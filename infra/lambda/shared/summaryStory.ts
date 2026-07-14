/**
 * ============================================================================
 * SUMMARY STORY — shared story-generation pipeline for the Summary tab.
 * ============================================================================
 *
 * Three stories share this code (same dailyStats.ts bundling pattern — each
 * Lambda esbuilds its own copy):
 *   - DAILY  (api Lambda, GET /summary): today's story, cached per day.
 *   - WEEKLY (reminder Lambda, {weeklyStories:true} cron, Mondays): the
 *     completed Mon-Sun week, written permanently to
 *     users/{pool}/summary/weeks/{monday}.json — the pet-book record.
 *   - MONTHLY (reminder Lambda, {monthlyStories:true} cron, the 1st):
 *     text-only consolidation of the month's weekly stories into
 *     users/{pool}/summary/months/{YYYY-MM}.json.
 *
 * Tone guardrails and the feeding-stays-out-of-the-narrative rule live in
 * copy/summary.ts and apply to every story because they all flow through
 * generateWindowStory / generateMonthStory here. Tunables in config.ts
 * SUMMARY. Memorial pets are skipped at the stats source (computeStoryWindow)
 * so no story ever mentions them.
 */
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { SUMMARY, AI, DAILY } from './config';
import { summaryCopy } from './copy';
import { mergedDailyEntries, rangeStats, overallCompletionPct } from './dailyStats';

const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

let claude: AnthropicBedrock | null = null;
function getClaude(): AnthropicBedrock {
  if (!claude) {
    claude = new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? 'us-east-1',
      timeout: AI.CLIENT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return claude;
}

async function getJson<T>(bucket: string, key: string): Promise<T | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await obj.Body!.transformToString()) as T;
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return null;
    throw e;
  }
}

const METERS_PER_MILE = 1609.344;
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Matches the Daily feeding presets plus meal-ish custom items — feeding is
 *  a chip stat, never story material (and the Daily tab offers to drop it
 *  after disuse). Mirrored in api/index.ts's isFeedingDailyItem. */
export const isFeedingStoryItem = (id: string, label: string) =>
  id === 'preset-breakfast' ||
  id === 'preset-dinner' ||
  /\b(breakfast|lunch|dinner|meal|feed(ing)?)\b/i.test(label);

export interface StoryPetStats {
  petId: string;
  name: string;
  species: string;
  carePct: number;
  moodAvg: number | null;
  medsGiven: number;
  weight: { value: number; unit: string; delta: number | null } | null;
  walks: { count: number; miles: number; kcal: number | null } | null; // null for cats
  checklist: { id: string; label: string; count: number; total: number }[];
}
export interface StoryPhotoRef {
  petId: string;
  id: string;
  filename: string;
  key: string;
  size: number;
}
interface WalkLike {
  petIds: string[];
  startedAt: string;
  distanceMeters: number;
}
interface DailyItemLike {
  id: string;
  name: string;
  addedOn?: string;
  removedOn?: string;
}

/**
 * Per-pet window stats over an explicit date range (inclusive, oldest
 * first). Leaner than the api Lambda's computeTrendsView — no series, no
 * insight line, no kcal (stories don't need them) — but the same
 * archive-merging math via dailyStats.ts. Skips memorial pets.
 */
export async function computeStoryWindow(
  bucket: string,
  poolSub: string,
  dates: string[],
): Promise<{ pets: StoryPetStats[]; activeDays: number }> {
  const poolPrefix = `users/${poolSub}/pets/`;
  const todayKey = new Date().toISOString().slice(0, 10);
  const [list, walksStored] = await Promise.all([
    s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: poolPrefix })),
    // Read-only: the api Lambda owns the lazy legacy backfill; a missing
    // index here just means no walks.
    getJson<{ walks: WalkLike[] }>(bucket, `users/${poolSub}/walks-index.json`),
  ]);
  const walks = walksStored?.walks ?? [];
  const petIds = (list.Contents ?? [])
    .filter((it) => it.Key!.endsWith('/pet.json'))
    .map((it) => it.Key!.slice(poolPrefix.length).split('/')[0]);
  const rangeStart = dates[0];
  const rangeEnd = dates[dates.length - 1];
  const activeDates = new Set<string>();

  const pets = (
    await Promise.all(
      petIds.map(async (petId) => {
        const petPrefix = `${poolPrefix}${petId}/`;
        const [pet, daily, weightsStored] = await Promise.all([
          getJson<{ name?: string; species?: string; memorial?: boolean }>(bucket, `${petPrefix}pet.json`),
          getJson<{ items?: DailyItemLike[] | null; log?: Record<string, Record<string, { count?: number }>>; moods?: Record<string, { value: number }> }>(bucket, `${petPrefix}daily.json`),
          getJson<{ entries: { date: string; weight: number; unit: string }[] }>(bucket, `${petPrefix}weights.json`),
        ]);
        if (!pet?.name || pet.memorial) return null;
        const species = pet.species ?? '';
        const isCat = /cat/i.test(species);

        // Items visible at the window's end (same presets rule as the app).
        const presets: DailyItemLike[] = /dog/i.test(species)
          ? [{ id: 'preset-breakfast', name: 'Breakfast' }, { id: 'preset-dinner', name: 'Dinner' }, { id: 'preset-walk', name: 'Walk' }]
          : [{ id: 'preset-breakfast', name: 'Breakfast' }, { id: 'preset-dinner', name: 'Dinner' }];
        const items = (daily?.items ?? presets).filter(
          (i) => (!i.addedOn || i.addedOn <= rangeEnd) && (!i.removedOn || i.removedOn > rangeEnd),
        );

        const entries = await mergedDailyEntries(
          bucket, petPrefix, daily ?? null, dates, todayKey, DAILY.LOG_RETENTION_DAYS, (ymd, o) => addDays(ymd, o.days ?? 0),
        );
        for (const d of dates) {
          const e = entries[d];
          if (e && ((e.checks && Object.keys(e.checks).length > 0) || e.mood)) activeDates.add(d);
        }
        const stats = rangeStats(entries, dates, weightsStored?.entries ?? []);
        const itemIds = items.map((i) => i.id);
        const petWalks = walks.filter(
          (w) => w.petIds.includes(petId) && w.startedAt.slice(0, 10) >= rangeStart && w.startedAt.slice(0, 10) <= rangeEnd,
        );
        const miles = Math.round((petWalks.reduce((s, w) => s + w.distanceMeters, 0) / METERS_PER_MILE) * 10) / 10;
        return {
          petId,
          name: pet.name,
          species,
          carePct: overallCompletionPct(stats, itemIds),
          moodAvg: stats.moodAvg,
          medsGiven: stats.medsGiven,
          weight: stats.weightLatest
            ? {
                value: stats.weightLatest.weight,
                unit: stats.weightLatest.unit,
                delta:
                  stats.weightFirst && stats.weightFirst !== stats.weightLatest
                    ? Math.round((stats.weightLatest.weight - stats.weightFirst.weight) * 10) / 10
                    : null,
              }
            : null,
          walks: isCat ? null : { count: petWalks.length, miles, kcal: null as number | null },
          checklist: items.map((i) => ({
            id: i.id,
            label: i.name,
            count: stats.checkCountsByItemId.get(i.id) ?? 0,
            total: dates.length,
          })),
        } satisfies StoryPetStats;
      }),
    )
  ).filter((p): p is StoryPetStats => p !== null);

  return { pets, activeDays: activeDates.size };
}

/** The per-pet chip row the Summary tab renders under a story — plain
 *  numbers, feeding folded into a meals tally (stat, not story). */
export function buildChips(pets: StoryPetStats[]) {
  return pets.map((p) => {
    const feeding = p.checklist.filter((c) => isFeedingStoryItem(c.id, c.label));
    return {
      petId: p.petId,
      name: p.name,
      carePct: p.carePct,
      moodAvg: p.moodAvg,
      walks: p.walks,
      meals: feeding.length
        ? { done: feeding.reduce((s, c) => s + c.count, 0), total: feeding.reduce((s, c) => s + c.total, 0) }
        : null,
    };
  });
}

/** Compact stats JSON for the model — feeding items withheld. */
export function buildStatsForModel(pets: StoryPetStats[]) {
  return pets.map((p) => ({
    name: p.name,
    careConsistencyPct: p.carePct,
    moodAvg1to5: p.moodAvg,
    medsGiven: p.medsGiven,
    weight: p.weight,
    walks: p.walks ? { count: p.walks.count, miles: p.walks.miles } : null,
    checklist: p.checklist
      .filter((c) => !isFeedingStoryItem(c.id, c.label))
      .map((c) => ({ item: c.label, doneDays: c.count, windowDays: c.total })),
  }));
}

/**
 * Window photos, newest-first, interleaved across pets so a two-pet
 * household doesn't get three shots of the same dog. Dates compared on the
 * S3 object's LastModified (UTC).
 */
export async function pickWindowPhotos(
  bucket: string,
  poolSub: string,
  petIds: string[],
  startDate: string,
  endDate: string,
): Promise<StoryPhotoRef[]> {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T23:59:59Z`);
  const perPet = await Promise.all(
    petIds.map(async (petId) => {
      const prefix = `users/${poolSub}/pets/${petId}/photos/`;
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      return (list.Contents ?? [])
        .filter((it) => {
          const t = it.LastModified?.getTime() ?? 0;
          return t >= startMs && t <= endMs;
        })
        .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
        .map((it) => {
          const parts = it.Key!.split('/');
          return { petId, id: parts[5], filename: parts.slice(6).join('/'), size: it.Size ?? 0, key: it.Key! };
        });
    }),
  );
  const refs: StoryPhotoRef[] = [];
  for (let round = 0; refs.length < SUMMARY.MAX_PHOTOS; round++) {
    const before = refs.length;
    for (const petPhotos of perPet) {
      if (refs.length >= SUMMARY.MAX_PHOTOS) break;
      if (petPhotos[round]) refs.push(petPhotos[round]);
    }
    if (refs.length === before) break;
  }
  return refs;
}

export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; data: string };
}
const AI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Fetch the refs that fit the model's size limits (oversized photos still
 *  display in the tab — they just aren't described in the story). */
export async function fetchImageBlocks(bucket: string, refs: StoryPhotoRef[]): Promise<ImageBlock[]> {
  const blocks: ImageBlock[] = [];
  let total = 0;
  for (const ref of refs) {
    if (ref.size > SUMMARY.MAX_PHOTO_BYTES_FOR_AI) continue;
    if (total + ref.size > SUMMARY.MAX_TOTAL_PHOTO_BYTES) continue;
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ref.key }));
    const mediaType = (obj.ContentType ?? '').toLowerCase().split(';')[0].trim();
    if (!AI_IMAGE_TYPES.includes(mediaType)) continue;
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType as ImageBlock['source']['media_type'],
        data: Buffer.from(await obj.Body!.transformToByteArray()).toString('base64'),
      },
    });
    total += ref.size;
  }
  return blocks;
}

/** Daily/weekly story: stats JSON + photos → 120-180 warm words. Throws on
 *  model failure or an empty/refused response — callers decide whether that
 *  means AI_FAILED (api) or skip-and-retry-next-cron (reminder). */
export async function generateWindowStory(opts: {
  petNames: string[];
  days: number;
  statsForModel: unknown;
  imageBlocks: ImageBlock[];
  windowNote?: string; // e.g. "This covers the completed week of Jul 6-12."
}): Promise<string> {
  const msg = await getClaude().messages.create({
    model: AI.BEDROCK_MODEL_ID,
    max_tokens: SUMMARY.MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          ...opts.imageBlocks,
          {
            type: 'text' as const,
            text: `Stats for the last ${opts.days} days (JSON):\n${JSON.stringify(opts.statsForModel)}\n\n${
              opts.windowNote ? `${opts.windowNote}\n\n` : ''
            }${summaryCopy.storyPrompt(opts.petNames, opts.days)}`,
          },
        ],
      },
    ],
  });
  const text = msg.content.find((b) => b.type === 'text');
  const story = (text && 'text' in text ? text.text : '').trim();
  if (!story || msg.stop_reason === 'refusal') throw new Error('empty story');
  return story;
}

/** Monthly consolidation: the month's weekly stories in, one 200-250 word
 *  month story out. Text-only — the weeks already digested the photos. */
export async function generateMonthStory(opts: {
  petNames: string[];
  monthLabel: string; // e.g. "July 2026"
  weeklyStories: { rangeStart: string; rangeEnd: string; story: string }[];
}): Promise<string> {
  const weeksText = opts.weeklyStories
    .map((w, i) => `Week ${i + 1} (${w.rangeStart} to ${w.rangeEnd}):\n${w.story}`)
    .join('\n\n');
  const msg = await getClaude().messages.create({
    model: AI.BEDROCK_MODEL_ID,
    max_tokens: SUMMARY.MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text: `${weeksText}\n\n${summaryCopy.monthPrompt(opts.petNames, opts.monthLabel)}`,
          },
        ],
      },
    ],
  });
  const text = msg.content.find((b) => b.type === 'text');
  const story = (text && 'text' in text ? text.text : '').trim();
  if (!story || msg.stop_reason === 'refusal') throw new Error('empty story');
  return story;
}
