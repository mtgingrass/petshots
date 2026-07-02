import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  listPets,
  createPet,
  updatePet,
  deletePet,
  uploadAvatar,
  listDocs,
  uploadDoc,
  updateDoc,
  updateDocVersion,
  deleteDoc,
  MAX_PETS,
  MAX_DOCS,
  type Pet,
  type Doc,
} from '../api';
import { SiteFooter } from '../components/SiteFooter';

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const ALLOWED_EXTS = ['pdf', ...IMAGE_EXTS];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DUE_SOON_DAYS = 30;
const SELECTED_KEY = 'petshots.selectedPet';

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

function statusOf(expiry?: string): Status {
  if (!expiry) return 'none';
  const days = daysUntil(expiry);
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'due-soon';
  return 'current';
}

// Most urgent first: the record you need to act on (or produce at the door)
// should never be below the fold.
const STATUS_RANK: Record<Status, number> = { overdue: 0, 'due-soon': 1, current: 2, none: 3 };
function sortDocs(docs: Doc[]): Doc[] {
  return [...docs].sort((a, b) => {
    const rank = STATUS_RANK[statusOf(a.expiry)] - STATUS_RANK[statusOf(b.expiry)];
    if (rank !== 0) return rank;
    if (a.expiry && b.expiry && a.expiry !== b.expiry) return a.expiry < b.expiry ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

function speciesEmoji(species: string): string {
  if (species === 'dog') return '🐶';
  if (species === 'cat') return '🐱';
  return '🐾';
}

// The at-the-door pick: the record front-desk staff actually asks for.
// Prefer a doc labeled "rabies"; otherwise fall back to the most urgent one.
function quickShowDoc(docs: Doc[]): Doc | undefined {
  return docs.find((d) => /rabies/i.test(d.label)) ?? docs[0];
}

export function Dashboard() {
  const { email, logout } = useAuth();
  const navigate = useNavigate();

  const [pets, setPets] = useState<Pet[] | null>(null); // null = still loading
  const [selectedId, setSelectedId] = useState<string | null>(
    () => localStorage.getItem(SELECTED_KEY),
  );
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [addingPet, setAddingPet] = useState(false);
  const [editingPet, setEditingPet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const selectedPet = pets?.find((p) => p.id === selectedId) ?? pets?.[0] ?? null;

  const loadPets = useCallback(async () => {
    setError(null);
    try {
      const res = await listPets();
      setPets(res.pets);
      return res.pets;
    } catch (err) {
      setPets([]);
      setError(err instanceof Error ? err.message : 'Failed to load your pets');
      return [];
    }
  }, []);

  const loadDocs = useCallback(async (petId: string) => {
    setDocsLoading(true);
    try {
      const res = await listDocs(petId);
      setDocs(sortDocs(res.docs));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load records');
    } finally {
      setDocsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPets();
  }, [loadPets]);

  useEffect(() => {
    if (selectedPet) {
      setDocs([]);
      void loadDocs(selectedPet.id);
    }
  }, [selectedPet?.id, loadDocs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.title = selectedPet ? `${selectedPet.name} · Petshots` : 'Petshots';
  }, [selectedPet]);

  function selectPet(id: string) {
    setSelectedId(id);
    localStorage.setItem(SELECTED_KEY, id);
    setEditingPet(false);
    setError(null);
  }

  function handleLogout() {
    logout();
    navigate('/', { replace: true });
  }

  const refreshDocs = useCallback(async () => {
    if (selectedPet) await loadDocs(selectedPet.id);
  }, [selectedPet, loadDocs]);

  const quickDoc = quickShowDoc(docs);

  return (
    <>
      <main className="page">
        <header className="dashboard-header">
          <Link className="wordmark" to="/">
            🐾 Petshots
          </Link>
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

        {pets === null ? (
          <DashboardSkeleton />
        ) : pets.length === 0 ? (
          <section className="card">
            <div className="empty-state">
              <span className="empty-state__icon" aria-hidden="true">
                🐾
              </span>
              Who are we keeping records for? Add your pet to get started (up to{' '}
              {MAX_DOCS} documents each, free).
            </div>
            <PetForm
              submitLabel="Add pet"
              onDone={async () => {
                const next = await loadPets();
                if (next[0]) selectPet(next[0].id);
              }}
              onError={setError}
              onNotice={showNotice}
            />
          </section>
        ) : (
          <>
            <PetSwitcher
              pets={pets}
              selectedId={selectedPet?.id ?? null}
              onSelect={selectPet}
              onAdd={() => {
                setAddingPet(true);
                setEditingPet(false);
              }}
              onEdit={() => {
                setEditingPet(true);
                setAddingPet(false);
              }}
            />

            {addingPet && (
              <section className="card">
                <h2 className="card__title">New pet</h2>
                <PetForm
                  submitLabel="Add pet"
                  onDone={async (pet) => {
                    setAddingPet(false);
                    await loadPets();
                    if (pet) selectPet(pet.id);
                  }}
                  onCancel={() => setAddingPet(false)}
                  onError={setError}
                  onNotice={showNotice}
                />
              </section>
            )}

            {editingPet && selectedPet && (
              <section className="card">
                <h2 className="card__title">Edit {selectedPet.name}</h2>
                <PetForm
                  pet={selectedPet}
                  submitLabel="Save"
                  onDone={async () => {
                    setEditingPet(false);
                    await loadPets();
                  }}
                  onCancel={() => setEditingPet(false)}
                  onDeleted={async () => {
                    setEditingPet(false);
                    localStorage.removeItem(SELECTED_KEY);
                    setSelectedId(null);
                    await loadPets();
                  }}
                  onError={setError}
                  onNotice={showNotice}
                />
              </section>
            )}

            {selectedPet && !addingPet && !editingPet && (
              <>
                {quickDoc && !docsLoading && (
                  <a
                    className="btn btn--primary btn--lg quickshow"
                    href={quickDoc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    📄 Show {quickDoc.label} at the door
                  </a>
                )}
                {docsLoading ? (
                  <DashboardSkeleton />
                ) : (
                  <>
                    <StatusSummary docs={docs} />
                    <DocsSection
                      petId={selectedPet.id}
                      docs={docs}
                      onChanged={refreshDocs}
                      onError={setError}
                      onNotice={showNotice}
                    />
                  </>
                )}
              </>
            )}
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}

// ---- pet switcher ----

function PetAvatar({ pet, size = 36 }: { pet: Pet; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
      {pet.avatarUrl ? (
        <img src={pet.avatarUrl} alt="" />
      ) : (
        <span className="avatar__emoji">{speciesEmoji(pet.species)}</span>
      )}
    </span>
  );
}

function PetSwitcher({
  pets,
  selectedId,
  onSelect,
  onAdd,
  onEdit,
}: {
  pets: Pet[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="pet-switcher" role="tablist" aria-label="Your pets">
      {pets.map((pet) => {
        const selected = pet.id === selectedId;
        return (
          <button
            key={pet.id}
            role="tab"
            aria-selected={selected}
            className={`pet-chip${selected ? ' pet-chip--selected' : ''}`}
            onClick={() => (selected ? onEdit() : onSelect(pet.id))}
            title={selected ? `Edit ${pet.name}` : `Switch to ${pet.name}`}
          >
            <PetAvatar pet={pet} />
            <span className="pet-chip__name">{pet.name}</span>
            {selected && (
              <span className="pet-chip__edit" aria-hidden="true">
                ✎
              </span>
            )}
          </button>
        );
      })}
      {pets.length < MAX_PETS && (
        <button className="pet-chip pet-chip--add" onClick={onAdd}>
          + Add pet
        </button>
      )}
    </div>
  );
}

// ---- pet create/edit form (shared) ----

function PetForm({
  pet,
  submitLabel,
  onDone,
  onCancel,
  onDeleted,
  onError,
  onNotice,
}: {
  pet?: Pet; // absent = create mode
  submitLabel: string;
  onDone: (pet?: Pet) => Promise<void>;
  onCancel?: () => void;
  onDeleted?: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [name, setName] = useState(pet?.name ?? '');
  const [species, setSpecies] = useState(pet?.species ?? 'dog');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const photo = photoRef.current?.files?.[0];
    if (photo) {
      if (!AVATAR_TYPES.includes(photo.type)) {
        onError('Pet photo must be a JPG, PNG, or WebP image.');
        return;
      }
      if (photo.size > MAX_AVATAR_BYTES) {
        onError(`That photo is ${formatSize(photo.size)} - the limit is 5 MB.`);
        return;
      }
    }
    setBusy(true);
    onError(null);
    try {
      const saved = pet
        ? await updatePet(pet.id, name.trim(), species)
        : await createPet(name.trim(), species);
      if (photo) await uploadAvatar(saved.pet.id, photo);
      onNotice(pet ? 'Pet updated' : `${saved.pet.name} added`);
      await onDone(saved.pet);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save pet');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    onError(null);
    try {
      await deletePet(pet!.id);
      onNotice(`${pet!.name} deleted`);
      await onDeleted?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Delete failed');
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <label>
        Pet name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Species
        <select value={species} onChange={(e) => setSpecies(e.target.value)}>
          <option value="dog">Dog</option>
          <option value="cat">Cat</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label>
        Photo (optional · JPG, PNG · max 5 MB)
        <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" />
      </label>
      <div className="actions">
        <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      {pet && onDeleted && (
        <div className="actions">
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="btn btn--link btn--danger"
                onClick={handleDelete}
                disabled={busy}
              >
                {busy ? 'Deleting…' : `Yes, delete ${pet.name} and all records`}
              </button>
              <button
                type="button"
                className="btn btn--link"
                onClick={() => setConfirmingDelete(false)}
                disabled={busy}
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--link btn--danger"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              Delete pet…
            </button>
          )}
        </div>
      )}
    </form>
  );
}

// ---- vaccine status ----

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

// ---- documents ----

function DocsSection({
  petId,
  docs,
  onChanged,
  onError,
  onNotice,
}: {
  petId: string;
  docs: Doc[];
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [showUpload, setShowUpload] = useState(false);
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [editingDoc, setEditingDoc] = useState<Doc | null>(null);
  const [updatingDoc, setUpdatingDoc] = useState<Doc | null>(null);
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
      await uploadDoc(petId, file, label.trim() || file.name, expiry || undefined);
      setLabel('');
      setExpiry('');
      if (fileRef.current) fileRef.current.value = '';
      setShowUpload(false);
      await onChanged();
      onNotice('Document uploaded');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="card__title">
        Records · {docs.length}/{MAX_DOCS}
      </h2>

      {docs.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state__icon" aria-hidden="true">
            📄
          </span>
          No records yet. Snap a photo of the vaccine cert from your vet and add
          it below — future-you at the daycare door says thanks.
        </div>
      ) : (
        <ul className="doc-list">
          {docs.map((doc) => (
            <DocItem
              key={doc.id}
              petId={petId}
              doc={doc}
              isEditing={editingDoc?.id === doc.id}
              isUpdating={updatingDoc?.id === doc.id}
              onEdit={() => {
                setUpdatingDoc(null);
                setEditingDoc(doc);
                setShowUpload(false);
              }}
              onUpdate={() => {
                setEditingDoc(null);
                setUpdatingDoc(doc);
                setShowUpload(false);
              }}
              onChanged={onChanged}
              onError={onError}
              onNotice={onNotice}
            />
          ))}
        </ul>
      )}

      {editingDoc && (
        <EditDocForm
          petId={petId}
          doc={editingDoc}
          onDone={async () => {
            setEditingDoc(null);
            await onChanged();
          }}
          onCancel={() => setEditingDoc(null)}
          onError={onError}
          onNotice={onNotice}
        />
      )}

      {updatingDoc && (
        <UpdateDocForm
          petId={petId}
          doc={updatingDoc}
          onDone={async () => {
            setUpdatingDoc(null);
            await onChanged();
          }}
          onCancel={() => setUpdatingDoc(null)}
          onError={onError}
          onNotice={onNotice}
        />
      )}

      {!editingDoc && !updatingDoc && (
        atLimit ? (
          <p className="subtle">
            You've reached the {MAX_DOCS}-document limit. Delete one to add another.
          </p>
        ) : showUpload ? (
          <form className="form" onSubmit={handleUpload}>
            <label>
              Label
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Rabies 2026"
                autoFocus
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
            <div className="actions">
              <button className="btn btn--primary" type="submit" disabled={busy}>
                {busy ? 'Uploading…' : 'Upload'}
              </button>
              <button type="button" className="btn" onClick={() => setShowUpload(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button className="btn btn--add" onClick={() => setShowUpload(true)}>
            + Add record
          </button>
        )
      )}
    </section>
  );
}

function DocItem({
  petId,
  doc,
  isEditing,
  isUpdating,
  onEdit,
  onUpdate,
  onChanged,
  onError,
  onNotice,
}: {
  petId: string;
  doc: Doc;
  isEditing: boolean;
  isUpdating: boolean;
  onEdit: () => void;
  onUpdate: () => void;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const status = statusOf(doc.expiry);

  // Close the ⋯ menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirming(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setConfirming(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  async function handleDelete() {
    setBusy(true);
    onError(null);
    try {
      await deleteDoc(petId, doc.id);
      await onChanged();
      onNotice('Document deleted');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Delete failed');
      setBusy(false);
      setMenuOpen(false);
      setConfirming(false);
    }
    // On success the row unmounts after onChanged(), so no state reset needed.
  }

  return (
    <li className={`doc-item${isEditing || isUpdating ? ' doc-item--active' : ''}`}>
      {/* The whole row opens the document - the core at-the-door interaction. */}
      <a className="doc-main" href={doc.url} target="_blank" rel="noopener noreferrer">
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
      </a>

      <div className="doc-menu-wrap" ref={menuRef}>
        <button
          className="btn btn--icon"
          aria-label={`Options for ${doc.label}`}
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((v) => !v);
            setConfirming(false);
          }}
          disabled={busy}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="doc-menu" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onEdit();
              }}
            >
              Edit label / date
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onUpdate();
              }}
            >
              Update record
            </button>
            {confirming ? (
              <button role="menuitem" className="doc-menu__danger" onClick={handleDelete}>
                {busy ? 'Deleting…' : 'Confirm delete'}
              </button>
            ) : (
              <button
                role="menuitem"
                className="doc-menu__danger"
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function EditDocForm({
  petId,
  doc,
  onDone,
  onCancel,
  onError,
  onNotice,
}: {
  petId: string;
  doc: Doc;
  onDone: () => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [label, setLabel] = useState(doc.label);
  const [expiry, setExpiry] = useState(doc.expiry ?? '');
  const [busy, setBusy] = useState(false);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    const next = label.trim();
    if (!next) return;
    setBusy(true);
    onError(null);
    try {
      await updateDoc(petId, doc.id, next, expiry || undefined);
      await onDone();
      onNotice('Document updated');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-form-panel">
      <p className="doc-form-panel__title">Editing: {doc.label}</p>
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
        <button className="btn btn--primary" type="submit" disabled={busy || !label.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </form>
    </div>
  );
}

function UpdateDocForm({
  petId,
  doc,
  onDone,
  onCancel,
  onError,
  onNotice,
}: {
  petId: string;
  doc: Doc;
  onDone: () => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [label, setLabel] = useState(doc.label);
  const [expiry, setExpiry] = useState(doc.expiry ?? '');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleUpdate(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (!ALLOWED_EXTS.includes(extOf(file.name))) {
      onError('Please choose a PDF, JPG, or PNG file.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      onError(`That file is ${formatSize(file.size)} — the limit is 10 MB.`);
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await updateDocVersion(petId, doc.id, file, label.trim() || file.name, expiry || undefined);
      await onDone();
      onNotice('Record updated — previous version archived');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-form-panel">
      <p className="doc-form-panel__title">New version of: {doc.label}</p>
      <form className="doc-edit doc-edit--col" onSubmit={handleUpdate}>
        <div className="doc-edit__row">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label"
            aria-label="Document label"
            autoFocus
          />
          <input
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            aria-label="New expiration date"
          />
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          required
          aria-label="New document file"
        />
        <div className="doc-edit__row">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'Uploading…' : 'Upload new version'}
          </button>
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
