// Door mode's offline store. The founder moment — phone out at a check-in
// desk — routinely happens in metal buildings with one bar of signal, so the
// records shown by Present mode must survive with zero network.
//
// Two layers, filled fire-and-forget whenever the dashboard loads docs online:
//  - metadata (pets + their docs' labels/expiries/filenames) in localStorage
//  - document bytes in the Cache API, keyed by the STABLE synthetic path
//    /door-cache/{docId} — presigned S3 URLs re-sign on every fetch, so the
//    real URL can never be a cache key
//
// /door reads only these two layers and needs no auth: the bytes are already
// on the device, and an expired Cognito token (unrefreshable offline) is
// exactly the lockout this feature exists to avoid. Logout wipes everything.
import type { Pet, Doc } from './api';

const META_KEY = 'petshots.doorCache';
const CACHE_NAME = 'petshots-door-v1';

export interface DoorDoc {
  id: string;
  label: string;
  expiry?: string;
  filename: string;
}

export interface DoorPet {
  id: string;
  name: string;
  species: string;
  docs: DoorDoc[];
}

export interface DoorCacheMeta {
  savedAt: string; // ISO
  pets: DoorPet[];
}

export function readDoorCache(): DoorCacheMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const meta = JSON.parse(raw) as DoorCacheMeta;
    return Array.isArray(meta.pets) ? meta : null;
  } catch {
    return null;
  }
}

// Rabies first — if storage quota cuts the fill short, the doc that matters
// most at a front desk is the one that made it in.
function fillOrder(docs: Doc[]): Doc[] {
  return [...docs].sort(
    (a, b) => Number(/rabies/i.test(b.label)) - Number(/rabies/i.test(a.label)),
  );
}

let filling = false;

// Refresh the offline store from a successful online load. Never throws;
// callers fire-and-forget. Blobs are immutable per doc id (uploads are never
// rewritten in place), so only missing ids are fetched.
export async function updateDoorCache(
  pets: Pet[],
  allDocs: Record<string, Doc[]>,
): Promise<void> {
  if (filling || !('caches' in window)) return;
  filling = true;
  try {
    const meta: DoorCacheMeta = {
      savedAt: new Date().toISOString(),
      pets: pets.map((p) => ({
        id: p.id,
        name: p.name,
        species: p.species,
        docs: (allDocs[p.id] ?? []).map(({ id, label, expiry, filename }) => ({
          id,
          label,
          expiry,
          filename,
        })),
      })),
    };
    localStorage.setItem(META_KEY, JSON.stringify(meta));

    const cache = await caches.open(CACHE_NAME);
    const wanted = new Set<string>();
    for (const pet of pets) {
      for (const doc of fillOrder(allDocs[pet.id] ?? [])) {
        const path = `/door-cache/${doc.id}`;
        wanted.add(path);
        if (await cache.match(path)) continue;
        try {
          const res = await fetch(doc.url);
          if (res.ok) await cache.put(path, res);
        } catch {
          // offline mid-fill or quota — whatever landed stays usable
        }
      }
    }
    // Drop bytes for docs that no longer exist.
    for (const req of await cache.keys()) {
      if (!wanted.has(new URL(req.url).pathname)) await cache.delete(req);
    }
  } catch {
    // storage unavailable (private mode, quota) — door mode just stays empty
  } finally {
    filling = false;
  }
}

// Object URL for a cached doc's bytes, or null if it never made it in.
export async function getDocObjectUrl(docId: string): Promise<string | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(`/door-cache/${docId}`);
    if (!hit) return null;
    return URL.createObjectURL(await hit.blob());
  } catch {
    return null;
  }
}

export async function clearDoorCache(): Promise<void> {
  try {
    localStorage.removeItem(META_KEY);
    if ('caches' in window) await caches.delete(CACHE_NAME);
  } catch {
    // best-effort
  }
}
