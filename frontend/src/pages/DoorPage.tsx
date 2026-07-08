// Door mode — the offline safety net for the check-in moment. Renders pets
// and records purely from the local door cache (see doorCache.ts): no auth,
// no API, works with zero bars. Reuses the dashboard's Present carousel.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Pet, Doc } from '../api';
import { readDoorCache, getDocObjectUrl, type DoorPet } from '../doorCache';
import { PresentScreen } from './Dashboard';
import { SiteHeader } from '../components/SiteHeader';

function speciesEmoji(species: string): string {
  if (/dog/i.test(species)) return '🐶';
  if (/cat/i.test(species)) return '🐱';
  return '🐾';
}

export function DoorPage() {
  const meta = readDoorCache();
  const [presenting, setPresenting] = useState<{ pet: Pet; docs: Doc[] } | null>(null);
  const [resolving, setResolving] = useState<string | null>(null); // petId

  // Blob URLs live until the page goes away; revoke them when Present closes.
  useEffect(() => {
    if (!presenting) return;
    const urls = presenting.docs.map((d) => d.url);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [presenting]);

  async function present(pet: DoorPet) {
    setResolving(pet.id);
    try {
      const docs: Doc[] = [];
      for (const d of pet.docs) {
        const url = await getDocObjectUrl(d.id);
        if (!url) continue; // bytes never made it into the cache — skip
        docs.push({
          id: d.id,
          label: d.label,
          expiry: d.expiry,
          filename: d.filename,
          url,
          remindersEnabled: true,
          size: 0,
          uploadedAt: '',
        });
      }
      if (docs.length === 0) return;
      setPresenting({
        pet: { id: pet.id, name: pet.name, species: pet.species },
        docs,
      });
    } finally {
      setResolving(null);
    }
  }

  return (
    <>
      <SiteHeader />
      <main className="page">
        <h1>Door mode</h1>
        <p className="subtle">
          Records saved on this phone — no signal needed.
          {meta && (
            <> Last updated {new Date(meta.savedAt).toLocaleString()}.</>
          )}
        </p>

        {!meta || meta.pets.length === 0 ? (
          <section className="card">
            <p>Nothing saved on this phone yet.</p>
            <p className="subtle">
              Open your <Link to="/dashboard">dashboard</Link> once while online
              and your records are stored here automatically for offline use.
            </p>
          </section>
        ) : (
          <section className="card">
            {meta.pets.map((pet) => (
              <div key={pet.id} className="door-pet">
                <span className="door-pet__name">
                  {speciesEmoji(pet.species)} {pet.name}
                </span>
                <span className="subtle">
                  {pet.docs.length === 0
                    ? 'No records'
                    : `${pet.docs.length} record${pet.docs.length === 1 ? '' : 's'}`}
                </span>
                {pet.docs.length > 0 && (
                  <button
                    className="btn btn--primary"
                    type="button"
                    disabled={resolving !== null}
                    onClick={() => void present(pet)}
                  >
                    {resolving === pet.id ? 'Opening…' : '▶ Present'}
                  </button>
                )}
              </div>
            ))}
          </section>
        )}

        <p className="subtle">
          Back online? <Link to="/dashboard">Go to your dashboard</Link>
        </p>
      </main>

      {presenting && (
        <PresentScreen
          pet={presenting.pet}
          docs={presenting.docs}
          onExit={() => setPresenting(null)}
        />
      )}
    </>
  );
}
