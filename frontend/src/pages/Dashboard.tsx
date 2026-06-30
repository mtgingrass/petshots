import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  getPet,
  savePet,
  listDocs,
  uploadDoc,
  updateDoc,
  deleteDoc,
  MAX_DOCS,
  type Pet,
  type Doc,
} from '../api';

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const ALLOWED_EXTS = ['pdf', ...IMAGE_EXTS];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const DUE_SOON_DAYS = 30;

type Status = 'overdue' | 'due-soon' | 'current' | 'none';

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Parse a 'YYYY-MM-DD' as local midnight (not UTC) so day math is timezone-safe.
function parseDay(d: string): Date {
  return new Date(`${d}T00:00:00`);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
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

function statusOf(expiry?: string): Status {
  if (!expiry) return 'none';
  const days = daysUntil(expiry);
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'due-soon';
  return 'current';
}

export function Dashboard() {
  const { email, logout } = useAuth();
  const navigate = useNavigate();

  const [pet, setPet] = useState<Pet | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [petRes, docsRes] = await Promise.all([getPet(), listDocs()]);
      setPet(petRes.pet);
      // Newest first - most recent vaccination record on top.
      setDocs(
        [...docsRes.docs].sort(
          (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load your data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = pet ? `${pet.name} · Petshots` : 'Petshots';
  }, [pet]);

  function handleLogout() {
    logout();
    navigate('/', { replace: true });
  }

  return (
    <main className="page">
      <header className="dashboard-header">
        <h1>{pet ? pet.name : 'Your pet'}</h1>
        <div className="dashboard-user">
          <span className="subtle">{email}</span>
          <button className="btn" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>

      {notice && <p className="notice" role="status">{notice}</p>}
      {error && (
        <p className="error" role="alert" onClick={() => setError(null)} title="Dismiss">
          {error}
        </p>
      )}

      {loading ? (
        <DashboardSkeleton />
      ) : pet ? (
        <>
          <StatusSummary docs={docs} />
          <PetCard pet={pet} onSaved={setPet} onError={setError} onNotice={showNotice} />
          <DocsSection
            docs={docs}
            onChanged={load}
            onError={setError}
            onNotice={showNotice}
          />
        </>
      ) : (
        <AddPetForm onSaved={setPet} onError={setError} />
      )}
    </main>
  );
}

// Headline health check across all documents: the most severe status wins.
function StatusSummary({ docs }: { docs: Doc[] }) {
  const dated = docs.filter((d) => d.expiry);
  if (dated.length === 0) {
    return (
      <section className="summary summary--none">
        Add expiration dates to your documents to track vaccine status.
      </section>
    );
  }
  const overdue = dated.filter((d) => statusOf(d.expiry) === 'overdue');
  const dueSoon = dated.filter((d) => statusOf(d.expiry) === 'due-soon');

  if (overdue.length > 0) {
    return (
      <section className="summary summary--overdue">
        ⚠ {overdue.length} vaccine{overdue.length > 1 ? 's are' : ' is'} overdue —{' '}
        {overdue.map((d) => d.label).join(', ')}.
      </section>
    );
  }
  if (dueSoon.length > 0) {
    return (
      <section className="summary summary--due-soon">
        ⏰ {dueSoon.length} vaccine{dueSoon.length > 1 ? 's are' : ' is'} due soon —{' '}
        {dueSoon.map((d) => d.label).join(', ')}.
      </section>
    );
  }
  return <section className="summary summary--current">✓ All vaccines are up to date.</section>;
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

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <section className="card">
        <span className="skeleton skeleton--title" />
        <span className="skeleton skeleton--line" />
      </section>
      <section className="card">
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--line" />
      </section>
    </div>
  );
}

function AddPetForm({
  onSaved,
  onError,
}: {
  onSaved: (pet: Pet) => void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('dog');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      const { pet } = await savePet({ name: name.trim(), species });
      onSaved(pet);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save pet');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <p className="subtle">
        Add your pet to start storing vaccination records (up to {MAX_DOCS} documents).
      </p>
      <form className="form" onSubmit={handleSubmit}>
        <label>
          Pet name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Species
          <SpeciesSelect value={species} onChange={setSpecies} />
        </label>
        <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Add pet'}
        </button>
      </form>
    </section>
  );
}

function PetCard({
  pet,
  onSaved,
  onError,
  onNotice,
}: {
  pet: Pet;
  onSaved: (pet: Pet) => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pet.name);
  const [species, setSpecies] = useState(pet.species);
  const [busy, setBusy] = useState(false);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      const res = await savePet({ name: name.trim(), species });
      onSaved(res.pet);
      setEditing(false);
      onNotice('Pet updated');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save pet');
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <section className="card">
        <form className="form" onSubmit={handleSave}>
          <label>
            Pet name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Species
            <SpeciesSelect value={species} onChange={setSpecies} />
          </label>
          <div className="actions">
            <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setName(pet.name);
                setSpecies(pet.species);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className="card card--row">
      <span className="subtle" style={{ textTransform: 'capitalize' }}>
        {pet.species}
      </span>
      <button className="btn btn--link" onClick={() => setEditing(true)}>
        Edit pet
      </button>
    </section>
  );
}

function SpeciesSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="dog">Dog</option>
      <option value="cat">Cat</option>
      <option value="other">Other</option>
    </select>
  );
}

function DocsSection({
  docs,
  onChanged,
  onError,
  onNotice,
}: {
  docs: Doc[];
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const atLimit = docs.length >= MAX_DOCS;

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    if (!ALLOWED_EXTS.includes(extOf(file.name))) {
      onError('Please choose a PDF, JPG, or PNG file.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      onError(`That file is ${formatSize(file.size)} - the limit is 10 MB.`);
      return;
    }

    setBusy(true);
    onError(null);
    try {
      await uploadDoc(file, label.trim() || file.name, expiry || undefined);
      setLabel('');
      setExpiry('');
      if (fileRef.current) fileRef.current.value = '';
      await onChanged();
      onNotice('Document uploaded');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <h2 className="subtle">
          {docs.length}/{MAX_DOCS} documents
        </h2>

        {docs.length === 0 ? (
          <p className="subtle">No documents yet. Upload your first vaccination record below.</p>
        ) : (
          <ul className="doc-list">
            {docs.map((doc) => (
              <DocItem
                key={doc.id}
                doc={doc}
                onChanged={onChanged}
                onError={onError}
                onNotice={onNotice}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        {atLimit ? (
          <p className="subtle">
            You've reached the {MAX_DOCS}-document limit. Delete one to add another.
          </p>
        ) : (
          <form className="form" onSubmit={handleUpload}>
            <label>
              Label
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Rabies 2026"
              />
            </label>
            <label>
              Expiration date (optional)
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </label>
            <label>
              File (PDF, JPG, PNG · max 10 MB)
              <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png" required />
            </label>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Uploading…' : 'Upload document'}
            </button>
          </form>
        )}
      </section>
    </>
  );
}

function DocItem({
  doc,
  onChanged,
  onError,
  onNotice,
}: {
  doc: Doc;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [label, setLabel] = useState(doc.label);
  const [expiry, setExpiry] = useState(doc.expiry ?? '');
  const [busy, setBusy] = useState(false);
  const ext = extOf(doc.filename);
  const isImage = IMAGE_EXTS.includes(ext);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    const next = label.trim();
    if (!next) return;
    setBusy(true);
    onError(null);
    try {
      await updateDoc(doc.id, next, expiry || undefined);
      await onChanged();
      setEditing(false);
      onNotice('Document updated');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    onError(null);
    try {
      await deleteDoc(doc.id);
      await onChanged();
      onNotice('Document deleted');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Delete failed');
      setBusy(false);
      setConfirming(false);
    }
    // On success the row unmounts after onChanged(), so no state reset needed.
  }

  return (
    <li className="doc-item">
      <a className="doc-thumb" href={doc.url} target="_blank" rel="noopener noreferrer">
        {isImage ? (
          <img src={doc.url} alt={doc.label} />
        ) : (
          <span className="doc-thumb__ext">{ext || 'file'}</span>
        )}
      </a>

      <div className="doc-meta">
        {editing ? (
          <form className="doc-edit" onSubmit={handleSave}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
              aria-label="Document label"
              placeholder="Label"
            />
            <input
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              aria-label="Expiration date"
            />
            <button className="btn btn--link" type="submit" disabled={busy}>
              Save
            </button>
            <button
              className="btn btn--link"
              type="button"
              onClick={() => {
                setLabel(doc.label);
                setExpiry(doc.expiry ?? '');
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className="doc-label">
              {doc.label} <StatusBadge expiry={doc.expiry} />
            </span>
            <span className="subtle">
              {doc.expiry ? `Expires ${formatDate(`${doc.expiry}T00:00:00`)} · ` : ''}
              {doc.filename} · {formatSize(doc.size)}
            </span>
          </>
        )}
      </div>

      {!editing &&
        (confirming ? (
          <div className="actions">
            <button className="btn btn--link btn--danger" onClick={handleDelete} disabled={busy}>
              {busy ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button className="btn btn--link" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="actions">
            <button className="btn btn--link" onClick={() => setEditing(true)} disabled={busy}>
              Edit
            </button>
            <button className="btn btn--link" onClick={() => setConfirming(true)} disabled={busy}>
              Delete
            </button>
          </div>
        ))}
    </li>
  );
}
