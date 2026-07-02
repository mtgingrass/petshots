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

// Worst-case status across a pet's full doc list — for the overview summary card.
function petOverallStatus(docs: Doc[]): Status {
  return docs.reduce<Status>((worst, doc) => {
    const s = statusOf(doc.expiry);
    return STATUS_RANK[s] < STATUS_RANK[worst] ? s : worst;
  }, 'none');
}

function petStatusLine(docs: Doc[]): string {
  if (docs.length === 0) return 'No records yet';
  const overdue = docs.filter((d) => statusOf(d.expiry) === 'overdue').length;
  const dueSoon = docs.filter((d) => statusOf(d.expiry) === 'due-soon').length;
  const base = `${docs.length} record${docs.length !== 1 ? 's' : ''}`;
  if (overdue > 0) return `${base} · ${overdue} overdue`;
  if (dueSoon > 0) return `${base} · ${dueSoon} due soon`;
  return base;
}

// ---- navigation state ----

type DashView =
  | { type: 'overview' }
  | { type: 'detail'; petId: string }
  | { type: 'add-pet' }
  | { type: 'edit-pet'; petId: string };

type EditView =
  | { type: 'list' }
  | { type: 'edit'; doc: Doc; petId: string }
  | { type: 'update'; doc: Doc; petId: string };

// ---- main component ----

export function Dashboard() {
  const { email, logout } = useAuth();
  const navigate = useNavigate();

  const [pets, setPets] = useState<Pet[] | null>(null); // null = still loading
  const [dashView, setDashView] = useState<DashView>({ type: 'overview' });
  const [allDocs, setAllDocs] = useState<Record<string, Doc[]>>({});
  const [allDocsLoading, setAllDocsLoading] = useState(false);
  const [editView, setEditView] = useState<EditView>({ type: 'list' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // Pet currently being viewed in detail/edit-pet screens.
  const detailPet =
    dashView.type === 'detail' || dashView.type === 'edit-pet'
      ? (pets?.find((p) => p.id === dashView.petId) ?? null)
      : null;

  // Docs for the active detail pet, always sorted.
  const detailDocs = detailPet ? (allDocs[detailPet.id] ?? []) : [];

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

  const loadAllDocs = useCallback(async (petList: Pet[]) => {
    if (petList.length === 0) {
      setAllDocs({});
      return;
    }
    setAllDocsLoading(true);
    try {
      const pairs = await Promise.all(
        petList.map((p) => listDocs(p.id).then((r) => [p.id, sortDocs(r.docs)] as const)),
      );
      setAllDocs(Object.fromEntries(pairs));
    } catch {
      // non-fatal — overview cards show without status
    } finally {
      setAllDocsLoading(false);
    }
  }, []);

  // Refresh just one pet's docs (after upload/delete/rename in detail view).
  const loadPetDocs = useCallback(async (petId: string) => {
    try {
      const res = await listDocs(petId);
      setAllDocs((prev) => ({ ...prev, [petId]: sortDocs(res.docs) }));
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    void loadPets();
  }, [loadPets]);

  // When the pets list changes (initial load, add, delete), reload all docs.
  useEffect(() => {
    if (pets !== null) void loadAllDocs(pets);
  }, [pets, loadAllDocs]);

  useEffect(() => {
    document.title = detailPet ? `${detailPet.name} · Petshots` : 'Petshots';
  }, [detailPet]);

  function handleLogout() {
    logout();
    navigate('/', { replace: true });
  }

  function backToOverview() {
    setDashView({ type: 'overview' });
    setEditView({ type: 'list' });
  }

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
        ) : dashView.type === 'add-pet' ? (
          <div className="screen-view">
            <nav className="screen-nav">
              <button
                className="screen-nav__back btn btn--link"
                type="button"
                onClick={backToOverview}
              >
                ← Dashboard
              </button>
              <span className="screen-nav__title">New Pet</span>
            </nav>
            <div className="screen-view__body">
              <PetForm
                submitLabel="Add pet"
                onDone={async (pet) => {
                  await loadPets();
                  setDashView(pet ? { type: 'detail', petId: pet.id } : { type: 'overview' });
                }}
                onCancel={backToOverview}
                onError={setError}
                onNotice={showNotice}
              />
            </div>
          </div>
        ) : dashView.type === 'edit-pet' && detailPet ? (
          <div className="screen-view">
            <nav className="screen-nav">
              <button
                className="screen-nav__back btn btn--link"
                type="button"
                onClick={() => setDashView({ type: 'detail', petId: detailPet.id })}
              >
                ← {detailPet.name}
              </button>
              <span className="screen-nav__title">Edit Pet</span>
            </nav>
            <div className="screen-view__body">
              <PetForm
                pet={detailPet}
                submitLabel="Save"
                onDone={async () => {
                  await loadPets();
                  setDashView({ type: 'detail', petId: detailPet.id });
                }}
                onCancel={() => setDashView({ type: 'detail', petId: detailPet.id })}
                onDeleted={async () => {
                  await loadPets();
                  backToOverview();
                }}
                onError={setError}
                onNotice={showNotice}
              />
            </div>
          </div>
        ) : dashView.type === 'detail' && detailPet ? (
          editView.type !== 'list' ? (
            editView.type === 'edit' ? (
              <EditDocScreen
                petId={editView.petId}
                doc={editView.doc}
                onDone={async () => {
                  setEditView({ type: 'list' });
                  await loadPetDocs(editView.petId);
                }}
                onCancel={() => setEditView({ type: 'list' })}
                onError={setError}
                onNotice={showNotice}
              />
            ) : (
              <UpdateDocScreen
                petId={editView.petId}
                doc={editView.doc}
                onDone={async () => {
                  setEditView({ type: 'list' });
                  await loadPetDocs(editView.petId);
                }}
                onCancel={() => setEditView({ type: 'list' })}
                onError={setError}
                onNotice={showNotice}
              />
            )
          ) : (
            <PetDetailScreen
              pet={detailPet}
              docs={detailDocs}
              onBack={backToOverview}
              onEditPet={() => setDashView({ type: 'edit-pet', petId: detailPet.id })}
              onEditDoc={(doc) => setEditView({ type: 'edit', doc, petId: detailPet.id })}
              onUpdateDoc={(doc) => setEditView({ type: 'update', doc, petId: detailPet.id })}
              onDocsChanged={() => loadPetDocs(detailPet.id)}
              onError={setError}
              onNotice={showNotice}
            />
          )
        ) : pets.length === 0 ? (
          <div className="empty-overview">
            <span className="empty-state__icon" aria-hidden="true">🐾</span>
            <p>Who are we keeping records for? Add your first pet to get started.</p>
            <button
              className="btn btn--primary"
              onClick={() => setDashView({ type: 'add-pet' })}
            >
              Add your first pet
            </button>
          </div>
        ) : (
          <>
            <h2 className="section-title">Your Pets</h2>
            <div className="pet-overview">
              {pets.map((pet) => (
                <PetSummaryCard
                  key={pet.id}
                  pet={pet}
                  docs={allDocs[pet.id]}
                  docsLoading={allDocsLoading}
                  onSelect={() => setDashView({ type: 'detail', petId: pet.id })}
                  onEdit={() => setDashView({ type: 'edit-pet', petId: pet.id })}
                />
              ))}
              {pets.length < MAX_PETS && (
                <button
                  className="pet-add-card"
                  onClick={() => setDashView({ type: 'add-pet' })}
                >
                  <span aria-hidden="true">+</span> Add pet
                </button>
              )}
            </div>
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}

// ---- pet avatar ----

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

// ---- pet overview card ----

function PetSummaryCard({
  pet,
  docs,
  docsLoading,
  onSelect,
  onEdit,
}: {
  pet: Pet;
  docs: Doc[] | undefined;
  docsLoading: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const status = docs ? petOverallStatus(docs) : 'none';
  const subLine = docsLoading && !docs ? 'Loading…' : petStatusLine(docs ?? []);

  return (
    <div className="pet-summary-card">
      <button className="pet-summary-card__tap" onClick={onSelect} aria-label={`View ${pet.name}'s records`}>
        <PetAvatar pet={pet} size={44} />
        <div className="pet-summary-card__body">
          <div className="pet-summary-card__name">{pet.name}</div>
          <div className="pet-summary-card__sub">
            {subLine}
            {docs && docs.length > 0 && status !== 'none' && (
              <span className={`status status--${status} pet-summary-card__pill`}>
                {status === 'overdue' ? 'Overdue' : status === 'due-soon' ? 'Due soon' : 'Current'}
              </span>
            )}
          </div>
        </div>
        <span className="pet-summary-card__chevron" aria-hidden="true">›</span>
      </button>
      <button
        className="pet-summary-card__edit btn btn--icon"
        aria-label={`Edit ${pet.name}`}
        onClick={onEdit}
        title={`Edit ${pet.name}`}
      >
        ✎
      </button>
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

// ---- pet detail screen ----

function PetDetailScreen({
  pet,
  docs,
  onBack,
  onEditPet,
  onEditDoc,
  onUpdateDoc,
  onDocsChanged,
  onError,
  onNotice,
}: {
  pet: Pet;
  docs: Doc[];
  onBack: () => void;
  onEditPet: () => void;
  onEditDoc: (doc: Doc) => void;
  onUpdateDoc: (doc: Doc) => void;
  onDocsChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  return (
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onBack}>
          ← Dashboard
        </button>
        <span className="screen-nav__title">{pet.name}</span>
        <button className="screen-nav__action btn btn--link" type="button" onClick={onEditPet}>
          ✎ Edit
        </button>
      </nav>
      <div className="screen-view__body">
        {docs.length > 0 && <StatusSummary docs={docs} />}
        <DocsSection
          petId={pet.id}
          docs={docs}
          onChanged={onDocsChanged}
          onError={onError}
          onNotice={onNotice}
          onEditDoc={onEditDoc}
          onUpdateDoc={onUpdateDoc}
        />
      </div>
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
  onEditDoc,
  onUpdateDoc,
}: {
  petId: string;
  docs: Doc[];
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  onEditDoc: (doc: Doc) => void;
  onUpdateDoc: (doc: Doc) => void;
}) {
  const [showUpload, setShowUpload] = useState(false);
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
              onEdit={() => { setShowUpload(false); onEditDoc(doc); }}
              onUpdate={() => { setShowUpload(false); onUpdateDoc(doc); }}
              onChanged={onChanged}
              onError={onError}
              onNotice={onNotice}
            />
          ))}
        </ul>
      )}

      {atLimit ? (
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
      )}
    </section>
  );
}

function DocItem({
  petId,
  doc,
  onEdit,
  onUpdate,
  onChanged,
  onError,
  onNotice,
}: {
  petId: string;
  doc: Doc;
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
    <li className="doc-item">
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

function EditDocScreen({
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
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onCancel}>
          ← Records
        </button>
        <span className="screen-nav__title">Edit Record</span>
      </nav>
      <form className="form" onSubmit={handleSave}>
        <label>
          Label
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label>
          Expiration date (optional)
          <input
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </label>
        <div className="actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !label.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function UpdateDocScreen({
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
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onCancel}>
          ← Records
        </button>
        <span className="screen-nav__title">Update Record</span>
      </nav>
      <form className="form" onSubmit={handleUpdate}>
        <label>
          Label
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          Expiration date (optional)
          <input
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </label>
        <label>
          New file (PDF, JPG, PNG · max 10 MB)
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            required
          />
        </label>
        <div className="actions">
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
