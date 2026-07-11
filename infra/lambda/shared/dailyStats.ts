/**
 * ============================================================================
 * DAILY STATS — shared window-stats computation for the Trends tab (api
 * Lambda's GET /trends) and the reminder Lambda's weekly/monthly report
 * emails.
 * ============================================================================
 *
 * Both Lambdas bundle this file independently (esbuild, same as config.ts /
 * copy/) — no runtime sharing, just the same source. Extracted after a real
 * bug: an earlier version of the "enough data to judge" gate was
 * window-relative and wrongly suppressed a genuine signal once tested
 * against a 30-day window (see DIGEST.MIN_ACTIVE_DAYS_FOR_INSIGHT's comment
 * in config.ts). A THIRD independent copy of this logic (for the new
 * monthly email) was judged too likely to drift the same way again —
 * this file is that logic, written once.
 *
 * Types here are intentionally minimal (only the fields these functions
 * touch) — each Lambda's own richer local type (DailyFile, WeightEntry,
 * etc.) is structurally assignable without casting.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DIGEST } from './config';
import { digestInsightCopy } from './copy';

const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

async function getJson<T>(bucket: string, key: string): Promise<T | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await obj.Body!.transformToString()) as T;
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return null;
    throw e;
  }
}

export interface DailyCheckLike {
  count?: number;
}
export interface DailyMoodLike {
  value: number;
}
export interface DailyFileLike {
  log?: Record<string, Record<string, DailyCheckLike>>;
  moods?: Record<string, DailyMoodLike>;
}
export interface WeightEntryLike {
  date: string;
  weight: number;
  unit: string;
}
export type MergedEntries = Record<string, { checks?: Record<string, DailyCheckLike>; mood?: DailyMoodLike }>;

// Merges daily.json's live log with daily-archive/{month}.json for any date
// older than the live retention window. A 7-day weekly window never crosses
// that boundary (DIGEST.LOOKBACK_DAYS < the 14-day retention window); a
// 30-day monthly window always does.
export async function mergedDailyEntries(
  bucket: string,
  petPrefix: string,
  daily: DailyFileLike | null,
  dates: string[],
  todayKey: string,
  liveRetentionDays: number,
  addToDay: (ymd: string, offset: { days?: number }) => string,
): Promise<MergedEntries> {
  const liveCutoff = addToDay(todayKey, { days: -(liveRetentionDays - 1) });
  const out: MergedEntries = {};
  const archiveMonths = new Set<string>();
  for (const d of dates) {
    if (d >= liveCutoff) out[d] = { checks: daily?.log?.[d], mood: daily?.moods?.[d] };
    else archiveMonths.add(d.slice(0, 7));
  }
  for (const month of archiveMonths) {
    const arch = await getJson<{ days?: MergedEntries }>(bucket, `${petPrefix}daily-archive/${month}.json`);
    for (const d of dates) {
      if (d.slice(0, 7) === month) out[d] = arch?.days?.[d] ?? {};
    }
  }
  return out;
}

export interface RangeStats {
  checkCountsByItemId: Map<string, number>;
  activeDates: Set<string>;
  moodAvg: number | null;
  medsGiven: number;
  weightFirst: WeightEntryLike | null;
  weightLatest: WeightEntryLike | null;
  totalDays: number;
}
export function rangeStats(
  entries: MergedEntries,
  dates: string[],
  weights: WeightEntryLike[],
): RangeStats {
  const checkCountsByItemId = new Map<string, number>();
  const activeDates = new Set<string>();
  const moods: number[] = [];
  let medsGiven = 0;
  for (const d of dates) {
    const e = entries[d];
    if (e?.mood) { moods.push(e.mood.value); activeDates.add(d); }
    if (!e?.checks) continue;
    activeDates.add(d);
    for (const [itemId, chk] of Object.entries(e.checks)) {
      const n = chk.count ?? 1;
      if (itemId.startsWith('med:')) medsGiven += n;
      else checkCountsByItemId.set(itemId, (checkCountsByItemId.get(itemId) ?? 0) + n);
    }
  }
  const inWindow = weights.filter((w) => w.date >= dates[0] && w.date <= dates[dates.length - 1]);
  return {
    checkCountsByItemId,
    activeDates,
    moodAvg: moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null,
    medsGiven,
    weightFirst: inWindow[0] ?? null,
    weightLatest: inWindow[inWindow.length - 1] ?? null,
    totalDays: dates.length,
  };
}

// "We noticed" line selection, shared by the Trends tab and every report
// email: mood dip takes priority, otherwise the checklist item with the
// lowest count IF the pet clears a small ABSOLUTE floor of tracked days
// first (DIGEST.MIN_ACTIVE_DAYS_FOR_INSIGHT) — a pet only added partway
// through the window must stay silent, not get told it "only logged
// breakfast 1 of 7 days." Deliberately NOT window-relative — see this
// file's header.
export function pickInsight(
  petName: string,
  stats: RangeStats,
  itemLabel: (id: string) => string,
): string | null {
  if (stats.moodAvg !== null && stats.moodAvg < DIGEST.MOOD_DIP_THRESHOLD) {
    return digestInsightCopy.moodDip(petName);
  }
  const trackedEnoughDays = stats.activeDates.size >= DIGEST.MIN_ACTIVE_DAYS_FOR_INSIGHT;
  if (!trackedEnoughDays) return null;
  const low = [...stats.checkCountsByItemId.entries()]
    .filter(([, n]) => n <= stats.totalDays - DIGEST.LOW_COMPLETION_MISSED_DAYS)
    .sort((a, b) => a[1] - b[1])[0];
  if (!low) return null;
  const [itemId, n] = low;
  if (itemId === 'preset-breakfast') return digestInsightCopy.lowBreakfast(petName, n, stats.totalDays);
  if (itemId === 'preset-dinner') return digestInsightCopy.lowDinner(petName, n, stats.totalDays);
  if (itemId === 'preset-walk') return digestInsightCopy.lowWalk(petName, n, stats.totalDays);
  return digestInsightCopy.lowGeneric(petName, itemLabel(itemId), n, stats.totalDays);
}

// Mean completion rate across a set of checklist items -> 0-100. The one
// number the Trends tab's gauge and every report email headline with.
export function overallCompletionPct(stats: RangeStats, itemIds: string[]): number {
  if (itemIds.length === 0) return 0;
  const sum = itemIds.reduce((acc, id) => acc + ((stats.checkCountsByItemId.get(id) ?? 0) / stats.totalDays) * 100, 0);
  return Math.round(sum / itemIds.length);
}
