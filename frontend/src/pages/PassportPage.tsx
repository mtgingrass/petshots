import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchPassport, type PassportData } from '../api';

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function parseDay(d: string): Date {
  return new Date(`${d}T00:00:00`);
}

function formatDate(day: string): string {
  return parseDay(day).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function daysUntil(expiry: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((parseDay(expiry).getTime() - today.getTime()) / 86_400_000);
}

type Status = 'overdue' | 'due-soon' | 'current' | 'none';

function statusOf(expiry?: string): Status {
  if (!expiry) return 'none';
  const days = daysUntil(expiry);
  if (days < 0) return 'overdue';
  if (days <= 30) return 'due-soon';
  return 'current';
}

function StatusBadge({ expiry }: { expiry?: string }) {
  const status = statusOf(expiry);
  const text =
    status === 'overdue'
      ? `Overdue ${Math.abs(daysUntil(expiry!))}d`
      : status === 'due-soon'
        ? `Due in ${daysUntil(expiry!)}d`
        : status === 'current'
          ? 'Current'
          : 'No date';
  return <span className={`status status--${status}`}>{text}</span>;
}

function ProfileField({ label, value }: { label: string; value?: string | boolean | null }) {
  if (value === undefined || value === null || value === '') return null;
  const display = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
  return (
    <div className="profile-field">
      <span className="profile-field__label">{label}</span>
      <span className="profile-field__value">{display}</span>
    </div>
  );
}

function speciesEmoji(species: string): string {
  if (species === 'dog') return '🐶';
  if (species === 'cat') return '🐱';
  return '🐾';
}

function profileAge(dob?: string): string | null {
  if (!dob) return null;
  const today = new Date();
  const birth = new Date(`${dob}T00:00:00`);
  const years = today.getFullYear() - birth.getFullYear();
  const months = today.getMonth() - birth.getMonth();
  const adjusted = months < 0 || (months === 0 && today.getDate() < birth.getDate()) ? years - 1 : years;
  if (adjusted < 1) {
    const m = ((today.getFullYear() - birth.getFullYear()) * 12 + today.getMonth() - birth.getMonth());
    return `${m} month${m !== 1 ? 's' : ''} old`;
  }
  return `${adjusted} year${adjusted !== 1 ? 's' : ''} old`;
}

export function PassportPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PassportData | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setErrorMsg('No passport token provided.'); setLoading(false); return; }
    fetchPassport(token)
      .then(setData)
      .catch((e: unknown) => setErrorMsg(e instanceof Error ? e.message : 'Failed to load passport'))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (data) document.title = `${data.pet.name}'s Records · Petshots`;
  }, [data]);

  if (loading) {
    return (
      <div className="page page--centered">
        <p className="subtle">Loading…</p>
      </div>
    );
  }

  if (errorMsg || !data) {
    const expired = errorMsg?.includes('expired');
    return (
      <div className="page page--centered">
        <a className="wordmark" href="/">🐾 Petshots</a>
        <p className="error" style={{ marginTop: '2rem' }}>
          {expired ? 'This passport link has expired.' : 'Passport not found or no longer active.'}
        </p>
        <a href="/" style={{ marginTop: '1rem' }}>Keep your own pet records at Petshots →</a>
      </div>
    );
  }

  const { pet, docs, expiresAt } = data;
  const hasProfile = pet.breed || pet.dob || pet.weight || pet.allergies || pet.behavior ||
    pet.vetName || pet.emergencyContact || pet.microchip || pet.fixed !== undefined || pet.notes;

  return (
    <div className="page passport-page">
      <header className="passport-page__header">
        <a className="wordmark" href="/">🐾 Petshots</a>
      </header>

      <div className="pet-detail__hero">
        <span className="avatar" style={{ width: 72, height: 72 }} aria-hidden="true">
          {pet.avatarUrl ? (
            <img src={pet.avatarUrl} alt="" />
          ) : (
            <span className="avatar__emoji">{speciesEmoji(pet.species)}</span>
          )}
        </span>
        <div className="pet-detail__hero-info">
          <span className="pet-detail__hero-name">{pet.name}</span>
          <span className="subtle">
            {speciesEmoji(pet.species)}{' '}
            {pet.species.charAt(0).toUpperCase() + pet.species.slice(1)}
            {pet.breed ? ` · ${pet.breed}` : ''}
          </span>
        </div>
      </div>

      <section className="card passport-page__docs">
        <h2 className="card__title">Vaccine Records · {docs.length}</h2>
        {docs.length === 0 ? (
          <p className="subtle">No records uploaded yet.</p>
        ) : (
          <ul className="doc-list">
            {docs.map((doc) => {
              const isImage = IMAGE_EXTS.includes(extOf(doc.filename));
              const status = statusOf(doc.expiry);
              return (
                <li key={doc.id} className="doc-item passport-doc-item">
                  <div className="passport-doc-info">
                    <span className={`doc-dot doc-dot--${status}`} aria-hidden="true" />
                    <span className="doc-meta">
                      <span className="doc-label">
                        {doc.label} <StatusBadge expiry={doc.expiry} />
                      </span>
                      <span className="subtle">
                        {doc.expiry
                          ? `${status === 'overdue' ? 'Expired' : 'Expires'} ${formatDate(doc.expiry)}`
                          : 'No expiry date'}
                      </span>
                    </span>
                  </div>
                  <a
                    className="btn btn--sm passport-doc-open"
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {isImage ? 'View' : 'Open PDF'} ↗
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {hasProfile && (
        <section className="card">
          <h2 className="card__title">Health Profile</h2>
          <div className="profile-view">
            {(pet.breed || pet.dob || pet.weight || pet.fixed !== undefined || pet.microchip) && (
              <section className="profile-section">
                <h3 className="profile-section__title">About</h3>
                <ProfileField label="Breed" value={pet.breed} />
                <ProfileField label="Age" value={profileAge(pet.dob)} />
                <ProfileField label="Weight" value={pet.weight} />
                <ProfileField label="Spayed/Neutered" value={pet.fixed !== undefined ? pet.fixed : undefined} />
                <ProfileField label="Microchip" value={pet.microchip} />
              </section>
            )}
            {(pet.allergies || pet.behavior || pet.notes) && (
              <section className="profile-section">
                <h3 className="profile-section__title">Health Notes</h3>
                <ProfileField label="Allergies" value={pet.allergies} />
                <ProfileField label="Behavior" value={pet.behavior} />
                <ProfileField label="Special instructions" value={pet.notes} />
              </section>
            )}
            {(pet.vetName || pet.vetPhone || pet.emergencyContact) && (
              <section className="profile-section">
                <h3 className="profile-section__title">Contacts</h3>
                <ProfileField label="Vet" value={pet.vetName} />
                <ProfileField label="Vet phone" value={pet.vetPhone} />
                <ProfileField label="Emergency contact" value={pet.emergencyContact} />
              </section>
            )}
          </div>
        </section>
      )}

      <footer className="passport-page__footer">
        {expiresAt && (
          <p className="subtle">This link expires {formatDate(expiresAt)}.</p>
        )}
        <p className="subtle">
          Shared via <a href="/">Petshots</a> — keep your pet's records ready at the door.
        </p>
      </footer>
    </div>
  );
}
