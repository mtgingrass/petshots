/**
 * digest-preview.mjs — Backend-only preview tool. Prints two things to the
 * terminal for the demo account's pets (Bella + Luna):
 *
 *   1. WEEKLY digest — the real thing. Invokes the already-deployed
 *      ReminderFn Lambda with { dryRun: true, forceDigest: true } and prints
 *      its actual would-send email body. No new code path; this is exactly
 *      what a subscriber would receive.
 *
 *   2. MONTHLY rollup — a PROTOTYPE, not a shipped feature. There is no
 *      monthly cron/email yet (deliberately — see TODO.md). This script
 *      reads daily.json + daily-archive/*.json + weights.json straight from
 *      S3 and computes a 30-day-vs-prior-30-day comparison, headlining
 *      whichever metric moved the most — inspired by how Bevel Health
 *      surfaces "what's moving the needle" as a rolling-average trend rather
 *      than a flat log of numbers. This is meant to be READ, then thrown
 *      away or promoted to a real feature later; it writes nothing.
 *
 * Usage:  node scripts/digest-preview.mjs
 * Requires: AWS CLI credentials with read access to petshots-uploads, and
 * lambda:InvokeFunction on the ReminderFn (same account Mark already uses).
 */

import { execFileSync } from 'node:child_process';

const BUCKET = 'petshots-uploads';
const OWNER_SUB = 'c4885488-4001-7021-839e-508d6a38d346'; // demo@petshots.app
const REMINDER_FN = 'PetshotsApiStack-ReminderFn8D49EC98-CEkKuWV5FLPO';
const TODAY = new Date();

const dateStr = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; };

function s3GetJson(key) {
  try {
    const out = execFileSync('aws', ['s3', 'cp', `s3://${BUCKET}/${key}`, '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out.toString());
  } catch {
    return null; // NoSuchKey or empty — treat as absent
  }
}
function s3List(prefix) {
  const out = execFileSync('aws', ['s3', 'ls', `s3://${BUCKET}/${prefix}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  return out.toString().split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);
}

// ── 1. WEEKLY digest — invoke the real, already-deployed Lambda ────────────
function printWeeklyDigest() {
  console.log('='.repeat(70));
  console.log('WEEKLY DIGEST (real — from the deployed ReminderFn, dry run)');
  console.log('='.repeat(70));
  const payload = JSON.stringify({ dryRun: true, forceDigest: true });
  execFileSync('aws', [
    'lambda', 'invoke', '--function-name', REMINDER_FN,
    '--payload', payload,
    '--cli-binary-format', 'raw-in-base64-out',
    '/tmp/petshots-digest-preview-invoke.json',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  const result = JSON.parse(execFileSync('cat', ['/tmp/petshots-digest-preview-invoke.json']).toString());
  const mine = (result.wouldSend ?? []).filter((s) => s.email === 'demo@petshots.app');
  if (mine.length === 0) {
    console.log('\n(No digest for demo@petshots.app this run — check remindersEnabled/weeklyDigest in settings.json,\nor that today matches DIGEST.DAY_UTC / forceDigest is being honored.)\n');
    return;
  }
  for (const m of mine) {
    console.log(`\nSubject: ${m.subject}\n`);
    console.log(m.body);
  }
  console.log();
}

// ── 2. MONTHLY rollup — prototype, computed locally from raw S3 data ───────
const PRESET_LABEL = { 'preset-breakfast': 'Breakfast', 'preset-dinner': 'Dinner', 'preset-walk': 'Walk' };

function loadFullHistory(petId) {
  const petPrefix = `users/${OWNER_SUB}/pets/${petId}/`;
  const live = s3GetJson(`${petPrefix}daily.json`) ?? { items: null, log: {}, moods: {} };
  const checksByDate = { ...live.log };
  const moodsByDate = { ...live.moods };
  const itemNames = new Map((live.items ?? []).map((i) => [i.id, i.name]));
  let archiveFiles = [];
  try {
    archiveFiles = s3List(`${petPrefix}daily-archive/`).filter((f) => f.endsWith('.json'));
  } catch { /* no archive yet */ }
  for (const f of archiveFiles) {
    const arch = s3GetJson(`${petPrefix}daily-archive/${f}`);
    for (const [date, entry] of Object.entries(arch?.days ?? {})) {
      if (entry.checks) checksByDate[date] = entry.checks;
      if (entry.mood) moodsByDate[date] = entry.mood;
    }
  }
  const weights = (s3GetJson(`${petPrefix}weights.json`)?.entries ?? []).sort((a, b) => a.date.localeCompare(b.date));
  // Discovered from the data itself, not a hardcoded preset list — a Daily
  // item can be ANY name a user typed in, not just breakfast/dinner/walk.
  const itemIds = [...new Set(Object.values(checksByDate).flatMap((day) => Object.keys(day)))].filter((id) => !id.startsWith('med:'));
  return { checksByDate, moodsByDate, weights, itemNames, itemIds };
}
function itemLabel(itemNames, id) {
  return PRESET_LABEL[id] ?? itemNames.get(id) ?? id;
}

function periodStats({ checksByDate, moodsByDate, weights, itemIds }, fromAgo, toAgo) {
  const from = dateStr(addDays(TODAY, -fromAgo));
  const to = dateStr(addDays(TODAY, -toAgo));
  const dates = Object.keys({ ...checksByDate, ...moodsByDate }).filter((d) => d >= from && d <= to);
  const eligibleDays = fromAgo - toAgo + 1;

  const rates = {};
  for (const id of itemIds) {
    const checkedDays = dates.filter((d) => checksByDate[d]?.[id]).length;
    rates[id] = checkedDays / eligibleDays;
  }
  const moods = dates.map((d) => moodsByDate[d]?.value).filter((v) => typeof v === 'number');
  const avgMood = moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null;
  const medsGiven = dates.reduce((n, d) => n + Object.keys(checksByDate[d] ?? {}).filter((k) => k.startsWith('med:')).length, 0);
  const inWindow = weights.filter((w) => w.date >= from && w.date <= to);
  const weightStart = inWindow[0]?.weight ?? null;
  const weightEnd = inWindow[inWindow.length - 1]?.weight ?? null;

  return { rates, avgMood, medsGiven, weightStart, weightEnd, unit: inWindow[0]?.unit };
}

// Same "we noticed" voice as the real weekly digest (copy/digest.ts's
// digestInsightCopy) but phrased for a month-over-month comparison instead
// of a flat day count. Template-based, not AI — see that file's header for
// why, and TODO.md for revisiting once custom items are common enough to
// need it.
function monthlyInsightLine(petName, label, itemId, thisPct, lastPct) {
  if (itemId === 'preset-breakfast') return `We noticed ${petName} only had breakfast logged ${thisPct}% of days this month (vs ${lastPct}% last month) — forgot to log it, or is ${petName} eating less?`;
  if (itemId === 'preset-dinner') return `We noticed ${petName} only had dinner logged ${thisPct}% of days this month (vs ${lastPct}% last month) — forgot to log it, or is ${petName} feeling off?`;
  if (itemId === 'preset-walk') return `We noticed ${petName}'s walks dropped to ${thisPct}% of days this month (vs ${lastPct}% last month) — anything keeping you two inside?`;
  return `We noticed ${petName}'s ${label} was only logged ${thisPct}% of days this month (vs ${lastPct}% last month) — just a logging gap, or worth a check-in?`;
}

function printMonthlyRollup(petName, species, petId) {
  const history = loadFullHistory(petId);
  const thisMonth = periodStats(history, 29, 0);
  const lastMonth = periodStats(history, 59, 30);
  const itemIds = history.itemIds;

  console.log(`\n${petName}`);
  console.log('-'.repeat(petName.length));

  // "What's moving the needle" — normalize each delta onto a comparable
  // 0-5-ish scale (rate deltas *5) and headline whichever moved most.
  const movers = [];
  if (thisMonth.avgMood != null && lastMonth.avgMood != null) {
    movers.push({ kind: 'mood', delta: thisMonth.avgMood - lastMonth.avgMood });
  }
  for (const id of itemIds) {
    movers.push({ kind: 'item', itemId: id, delta: (thisMonth.rates[id] - lastMonth.rates[id]) * 5 });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = movers[0];
  if (top && top.delta < -0.3) {
    // Only headline a DROP as a gentle question — a rise needs no prompting.
    if (top.kind === 'mood') {
      console.log(`  Headline: We noticed ${petName}'s mood dropped this month — everything okay?`);
    } else {
      const label = itemLabel(history.itemNames, top.itemId);
      const thisPct = Math.round(thisMonth.rates[top.itemId] * 100);
      const lastPct = Math.round(lastMonth.rates[top.itemId] * 100);
      console.log(`  Headline: ${monthlyInsightLine(petName, label, top.itemId, thisPct, lastPct)}`);
    }
  } else if (top && top.delta > 0.3) {
    const dir = top.kind === 'mood' ? `${petName}'s mood improved this month` : `${itemLabel(history.itemNames, top.itemId)} logging improved this month`;
    console.log(`  Headline: Good news — ${dir}.`);
  } else {
    console.log('  Headline: no major changes this month');
  }

  console.log(`  Mood (30d avg):     ${thisMonth.avgMood?.toFixed(1) ?? 'n/a'}  (prior 30d: ${lastMonth.avgMood?.toFixed(1) ?? 'n/a'})`);
  for (const id of itemIds) {
    console.log(`  ${itemLabel(history.itemNames, id).padEnd(18)} ${Math.round(thisMonth.rates[id] * 100)}% of days  (prior 30d: ${Math.round(lastMonth.rates[id] * 100)}%)`);
  }
  console.log(`  Meds given:         ${thisMonth.medsGiven}  (prior 30d: ${lastMonth.medsGiven})`);
  if (thisMonth.weightStart != null && thisMonth.weightEnd != null) {
    const d = Math.round((thisMonth.weightEnd - thisMonth.weightStart) * 10) / 10;
    console.log(`  Weight:             ${thisMonth.weightEnd} ${thisMonth.unit} (${d >= 0 ? '+' : ''}${d} ${thisMonth.unit} this month)`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────
printWeeklyDigest();

console.log('='.repeat(70));
console.log('MONTHLY ROLLUP (prototype — not a shipped feature, see file header)');
console.log('='.repeat(70));
printMonthlyRollup('Bella', 'dog', '7366feb6-dd6f-42ff-91b1-6033635d79fc');
printMonthlyRollup('Luna', 'cat', 'effae429-6ad1-460b-b87f-5b803cfb5ab7');
console.log();
