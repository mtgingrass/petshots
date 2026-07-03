import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { useAuth } from '../auth/AuthContext';
import { changePassword } from '../auth/cognito';
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
  createPassport,
  revokePassport,
  getSettings,
  saveSettings,
  MAX_PETS,
  MAX_DOCS,
  DEFAULT_SETTINGS,
  type Pet,
  type Doc,
  type UserSettings,
} from '../api';
import { applyTheme, getSavedTheme, type Theme } from '../utils/theme';
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

// Match common vaccine labels to a plain-English blurb. Returns null for unknowns.
function vaccineBlurb(label: string): string | null {
  const l = label.toLowerCase();
  if (/rabies/.test(l))
    return 'Required at nearly every boarding facility, dog park, daycare, and groomer. A current rabies certificate is the most-requested document at check-in.';
  if (/\bdhpp\b|da2pp|distemper|parvovirus|parvo/.test(l))
    return 'Core vaccine protecting against distemper, adenovirus, parvovirus, and parainfluenza. Usually renewed every 1–3 years after the initial series.';
  if (/bordetella|kennel.?cough/.test(l))
    return 'Required at most boarding facilities and dog parks. Protects against kennel cough, a highly contagious respiratory infection.';
  if (/lepto/.test(l))
    return 'Protects against leptospirosis, a bacterial infection spread through contaminated water, soil, and wildlife.';
  if (/lyme/.test(l))
    return 'Tick-borne disease prevention, especially important in wooded or grassy areas.';
  if (/influenza|canine.?flu/.test(l))
    return 'Required at some boarding and daycare facilities. Protects against canine influenza strains H3N2 and H3N8.';
  if (/felv|feline.?leukemia/.test(l))
    return 'Recommended for cats with outdoor access or contact with other cats. Protects against feline leukemia virus.';
  if (/fvrcp|rhinotracheitis|calici/.test(l))
    return 'Core feline vaccine protecting against feline herpesvirus, calicivirus, and panleukopenia. Usually renewed every 1–3 years.';
  return null;
}

// ---- navigation state ----

type DashView =
  | { type: 'overview' }
  | { type: 'detail'; petId: string }
  | { type: 'add-pet' }
  | { type: 'edit-pet'; petId: string }
  | { type: 'change-password' }
  | { type: 'settings' };

type EditView =
  | { type: 'list' }
  | { type: 'doc'; doc: Doc; petId: string }
  | { type: 'edit'; doc: Doc; petId: string }
  | { type: 'update'; doc: Doc; petId: string }
  | { type: 'edit-profile' };

// ---- main component ----

export function Dashboard() {
  const { email, logout } = useAuth();
  const navigate = useNavigate();

  const [theme, setTheme] = useState<Theme>(getSavedTheme);

  const [pets, setPets] = useState<Pet[] | null>(null); // null = still loading
  const [dashView, setDashView] = useState<DashView>({ type: 'overview' });
  const [allDocs, setAllDocs] = useState<Record<string, Doc[]>>({});
  const [allDocsLoading, setAllDocsLoading] = useState(false);
  const [editView, setEditView] = useState<EditView>({ type: 'list' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [presenting, setPresenting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    pet: Pet;
    docs: Doc[];
    timerId: ReturnType<typeof setTimeout>;
  } | null>(null);
  // Keep a ref so the unmount cleanup can read current value without a stale closure.
  const pendingDeleteRef = useRef(pendingDelete);
  pendingDeleteRef.current = pendingDelete;

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // On unmount, commit any pending delete immediately so nothing leaks.
  useEffect(() => {
    return () => {
      const pd = pendingDeleteRef.current;
      if (pd) {
        clearTimeout(pd.timerId);
        void deletePet(pd.pet.id);
      }
    };
  }, []);

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

  // Flush marketing opt-in captured at signup (stored before the user was logged in).
  useEffect(() => {
    const pending = localStorage.getItem('petshots.pendingMarketingOptIn');
    if (pending === null || !email) return;
    localStorage.removeItem('petshots.pendingMarketingOptIn');
    const marketingOptIn = pending === 'true';
    void getSettings()
      .catch(() => ({ ...DEFAULT_SETTINGS, email: email ?? '' }))
      .then((s) => saveSettings({ ...s, email: email ?? s.email, marketingOptIn }))
      .catch(() => {}); // non-fatal
  }, [email]);

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

  function handleDeletePetWithUndo(petId: string) {
    if (!pets) return;
    const pet = pets.find((p) => p.id === petId);
    if (!pet) return;
    const docs = allDocs[petId] ?? [];

    // Commit any previously pending delete before starting a new one.
    if (pendingDelete) {
      clearTimeout(pendingDelete.timerId);
      void deletePet(pendingDelete.pet.id).catch(() => {});
    }

    // Optimistically remove pet from local state and navigate away.
    setPets((prev) => (prev ?? []).filter((p) => p.id !== petId));
    setAllDocs((prev) => { const n = { ...prev }; delete n[petId]; return n; });
    backToOverview();

    const timerId = setTimeout(async () => {
      setPendingDelete(null);
      try {
        await deletePet(petId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed — restoring your pet');
        void loadPets();
      }
    }, 10000);

    setPendingDelete({ pet, docs, timerId });
  }

  function handleUndoDelete() {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timerId);
    setPets((prev) =>
      [...(prev ?? []), pendingDelete.pet].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setAllDocs((prev) => ({ ...prev, [pendingDelete.pet.id]: pendingDelete.docs }));
    showNotice(`${pendingDelete.pet.name} restored`);
    setPendingDelete(null);
  }

  return (
    <>
      <main className="page">
        <header className="dashboard-header">
          {dashView.type === 'overview' ? (
            <Link className="wordmark" to="/">🐾 Petshots</Link>
          ) : (
            <button className="btn btn--link dashboard-header__back" onClick={backToOverview}>
              ← Dashboard
            </button>
          )}
          <ProfileMenu
            email={email ?? ''}
            onSettings={() => setDashView({ type: 'settings' })}
            onChangePassword={() => setDashView({ type: 'change-password' })}
            onLogout={handleLogout}
          />
        </header>

        {pendingDelete && (
          <div className="undo-notice" role="status">
            <span>{pendingDelete.pet.name} deleted.</span>
            <button className="btn btn--link" onClick={handleUndoDelete}>Undo</button>
          </div>
        )}
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
                onDeletePet={handleDeletePetWithUndo}
                onError={setError}
                onNotice={showNotice}
              />
            </div>
          </div>
        ) : dashView.type === 'settings' ? (
          <SettingsScreen
            email={email ?? ''}
            theme={theme}
            onThemeChange={(t) => { applyTheme(t); setTheme(t); }}
            onDone={backToOverview}
            onError={setError}
            onNotice={showNotice}
          />
        ) : dashView.type === 'change-password' ? (
          <ChangePasswordScreen
            onDone={() => { backToOverview(); showNotice('Password changed'); }}
            onCancel={backToOverview}
            onError={setError}
          />
        ) : dashView.type === 'detail' && detailPet ? (
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
          ) : editView.type === 'update' ? (
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
          ) : editView.type === 'edit-profile' ? (
            <ProfileEditScreen
              pet={detailPet}
              onDone={async () => { setEditView({ type: 'list' }); await loadPets(); }}
              onCancel={() => setEditView({ type: 'list' })}
              onError={setError}
              onNotice={showNotice}
            />
          ) : editView.type === 'doc' ? (
            <DocDetailScreen
              petId={editView.petId}
              doc={editView.doc}
              onBack={() => setEditView({ type: 'list' })}
              onEdit={() => setEditView({ type: 'edit', doc: editView.doc, petId: editView.petId })}
              onUpdate={() => setEditView({ type: 'update', doc: editView.doc, petId: editView.petId })}
            />
          ) : (
            <PetDetailScreen
              pet={detailPet}
              docs={detailDocs}
              onEditPet={() => setDashView({ type: 'edit-pet', petId: detailPet.id })}
              onPresent={() => setPresenting(true)}
              onEditProfile={() => setEditView({ type: 'edit-profile' })}
              onViewDoc={(doc) => setEditView({ type: 'doc', doc, petId: detailPet.id })}
              onEditDoc={(doc) => setEditView({ type: 'edit', doc, petId: detailPet.id })}
              onUpdateDoc={(doc) => setEditView({ type: 'update', doc, petId: detailPet.id })}
              onDocsChanged={() => loadPetDocs(detailPet.id)}
              onPassportChanged={() => void loadPets()}
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
            <ShareAppButton onNotice={showNotice} />
          </>
        )}
      </main>
      <SiteFooter />
      {presenting && detailPet && detailDocs.length > 0 && (
        <PresentScreen
          pet={detailPet}
          docs={detailDocs}
          onExit={() => setPresenting(false)}
        />
      )}
    </>
  );
}

// ---- profile menu ----

function ProfileMenu({
  email,
  onSettings,
  onChangePassword,
  onLogout,
}: {
  email: string;
  onSettings: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="profile-menu" ref={ref}>
      <button
        className="profile-menu__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="profile-menu__email">{email}</span>
        <span className="profile-menu__chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="profile-menu__dropdown" role="menu">
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onSettings(); }}
          >
            Settings
          </button>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onChangePassword(); }}
          >
            Change password
          </button>
          <div className="profile-menu__divider" />
          <button
            role="menuitem"
            className="profile-menu__danger"
            onClick={() => { setOpen(false); onLogout(); }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

// ---- share button ----

function ShareAppButton({ onNotice }: { onNotice: (msg: string) => void }) {
  async function handleShare() {
    const data = {
      title: 'Petshots',
      text: "Keep your pet's vaccine records in one place — ready at the door in one tap.",
      url: 'https://petshots.app',
    };
    if (typeof navigator.share === 'function') {
      try { await navigator.share(data); } catch { /* user cancelled */ }
    } else {
      await navigator.clipboard.writeText('https://petshots.app');
      onNotice('Link copied to clipboard!');
    }
  }

  return (
    <button className="share-app-btn btn btn--link" onClick={handleShare}>
      Share Petshots with a fellow pet owner ↗
    </button>
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
  onDeletePet,
  onError,
  onNotice,
}: {
  pet?: Pet; // absent = create mode
  submitLabel: string;
  onDone: (pet?: Pet) => Promise<void>;
  onCancel?: () => void;
  onDeletePet?: (petId: string) => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [name, setName] = useState(pet?.name ?? '');
  const [species, setSpecies] = useState(pet?.species ?? 'dog');
  const [busy, setBusy] = useState(false);
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
        ? await updatePet(pet.id, { name: name.trim(), species })
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
      {pet && onDeletePet && (
        <div className="actions">
          <button
            type="button"
            className="btn btn--link btn--danger"
            onClick={() => onDeletePet(pet.id)}
            disabled={busy}
          >
            Delete {pet.name}…
          </button>
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
  onEditPet,
  onPresent,
  onEditProfile,
  onViewDoc,
  onEditDoc,
  onUpdateDoc,
  onDocsChanged,
  onPassportChanged,
  onError,
  onNotice,
}: {
  pet: Pet;
  docs: Doc[];
  onEditPet: () => void;
  onPresent: () => void;
  onEditProfile: () => void;
  onViewDoc: (doc: Doc) => void;
  onEditDoc: (doc: Doc) => void;
  onUpdateDoc: (doc: Doc) => void;
  onDocsChanged: () => Promise<void>;
  onPassportChanged: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [tab, setTab] = useState<'records' | 'profile' | 'share'>('records');

  return (
    <div className="screen-view">
      <nav className="screen-nav">
        {tab === 'records' && docs.length > 0 ? (
          <button className="screen-nav__back btn btn--link present-trigger" type="button" onClick={onPresent}>
            ▶ Present
          </button>
        ) : tab === 'profile' ? (
          <button className="screen-nav__back btn btn--link" type="button" onClick={onEditProfile}>
            ✎ Edit
          </button>
        ) : (
          <span />
        )}
        <span className="screen-nav__title">{pet.name}</span>
        {tab === 'records' ? (
          <button className="screen-nav__action btn btn--link" type="button" onClick={onEditPet}>
            ✎ Edit
          </button>
        ) : (
          <span />
        )}
      </nav>

      <div className="screen-view__body">
        <div className="pet-detail__hero">
          <PetAvatar pet={pet} size={72} />
          <div className="pet-detail__hero-info">
            <span className="pet-detail__hero-name">{pet.name}</span>
            <span className="subtle">
              {speciesEmoji(pet.species)}{' '}
              {pet.species.charAt(0).toUpperCase() + pet.species.slice(1)}
              {pet.breed ? ` · ${pet.breed}` : ''}
            </span>
          </div>
        </div>

        <div className="tab-bar">
          <button
            className={`tab-bar__tab${tab === 'records' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => setTab('records')}
          >
            Records
          </button>
          <button
            className={`tab-bar__tab${tab === 'profile' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => setTab('profile')}
          >
            Profile
          </button>
          <button
            className={`tab-bar__tab${tab === 'share' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => setTab('share')}
          >
            Share{pet.passportToken ? ' ✓' : ''}
          </button>
        </div>

        {tab === 'records' ? (
          <>
            {docs.length > 0 && <StatusSummary docs={docs} />}
            <DocsSection
              petId={pet.id}
              docs={docs}
              onChanged={onDocsChanged}
              onError={onError}
              onNotice={onNotice}
              onViewDoc={onViewDoc}
              onEditDoc={onEditDoc}
              onUpdateDoc={onUpdateDoc}
            />
          </>
        ) : tab === 'profile' ? (
          <ProfileSection pet={pet} onEdit={onEditProfile} />
        ) : (
          <ShareTabSection
            pet={pet}
            onPassportChanged={onPassportChanged}
            onNotice={onNotice}
            onError={onError}
          />
        )}
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
  onViewDoc,
  onEditDoc,
  onUpdateDoc,
}: {
  petId: string;
  docs: Doc[];
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  onViewDoc: (doc: Doc) => void;
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
              onView={() => onViewDoc(doc)}
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
  onView,
  onEdit,
  onUpdate,
  onChanged,
  onError,
  onNotice,
}: {
  petId: string;
  doc: Doc;
  onView: () => void;
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
      <button className="doc-main" onClick={onView} aria-label={`View details for ${doc.label}`}>
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
      </button>

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

function DocDetailScreen({
  petId: _petId,
  doc,
  onBack,
  onEdit,
  onUpdate,
}: {
  petId: string;
  doc: Doc;
  onBack: () => void;
  onEdit: () => void;
  onUpdate: () => void;
}) {
  const status = statusOf(doc.expiry);
  const blurb = vaccineBlurb(doc.label);
  const isImage = IMAGE_EXTS.includes(extOf(doc.filename));

  return (
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onBack}>
          ← Records
        </button>
        <span className="screen-nav__title">Record Details</span>
      </nav>
      <div className="screen-view__body doc-detail">
        <h2 className="doc-detail__label">{doc.label}</h2>
        <div className="doc-detail__status">
          <StatusBadge expiry={doc.expiry} />
          <span className="subtle doc-detail__expiry">
            {doc.expiry
              ? `${status === 'overdue' ? 'Expired' : 'Expires'} ${formatDate(doc.expiry)}`
              : 'No expiry date set'}
          </span>
        </div>

        {blurb && <p className="doc-detail__blurb">{blurb}</p>}

        {isImage && (
          <div className="doc-detail__preview">
            <img src={doc.url} alt={doc.label} loading="lazy" />
          </div>
        )}

        <a
          className="btn btn--primary btn--lg doc-detail__open"
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open certificate ↗
        </a>

        <div className="doc-detail__secondary">
          <button className="btn btn--link" type="button" onClick={onEdit}>
            Edit label / date
          </button>
          <button className="btn btn--link" type="button" onClick={onUpdate}>
            Update record
          </button>
        </div>
      </div>
    </div>
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

// ---- profile read view ----

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

function ProfileField({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="profile-field">
      <span className="profile-field__label">{label}</span>
      <span className="profile-field__value">{value}</span>
    </div>
  );
}

function ProfileSection({ pet, onEdit }: { pet: Pet; onEdit: () => void }) {
  const hasAny = pet.breed || pet.dob || pet.weight || pet.allergies || pet.behavior ||
    pet.vetName || pet.emergencyContact || pet.microchip || pet.fixed !== undefined || pet.notes;

  if (!hasAny) {
    return (
      <div className="profile-empty">
        <p className="subtle">No health profile yet.</p>
        <button className="btn btn--primary" onClick={onEdit}>Add profile details</button>
      </div>
    );
  }

  return (
    <div className="profile-view">
      {(pet.breed || pet.dob || pet.weight || pet.fixed !== undefined) && (
        <section className="profile-section">
          <h3 className="profile-section__title">About</h3>
          <ProfileField label="Breed" value={pet.breed} />
          <ProfileField label="Age" value={profileAge(pet.dob)} />
          <ProfileField label="Weight" value={pet.weight} />
          <ProfileField label="Status" value={pet.fixed !== undefined ? (pet.fixed ? 'Spayed / Neutered' : 'Intact') : undefined} />
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
  );
}

// ---- share / passport tab ----

function ShareTabSection({
  pet,
  onPassportChanged,
  onNotice,
  onError,
}: {
  pet: Pet;
  onPassportChanged: () => void;
  onNotice: (msg: string) => void;
  onError: (msg: string | null) => void;
}) {
  const [expiry, setExpiry] = useState('30d');
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const passportUrl = pet.passportToken
    ? `https://petshots.app/p/${pet.passportToken}`
    : null;

  useEffect(() => {
    if (!passportUrl) { setQrDataUrl(null); return; }
    // Always dark-on-white: inverted QR codes fail on many scanners.
    void QRCode.toDataURL(passportUrl, { width: 220, margin: 2, color: { dark: '#111827', light: '#ffffff' } })
      .then(setQrDataUrl)
      .catch(() => {});
  }, [passportUrl]);

  function expiryDate(): string | undefined {
    if (expiry === 'never') return undefined;
    const days = expiry === '7d' ? 7 : expiry === '30d' ? 30 : expiry === '90d' ? 90 : 365;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  }

  async function handleGenerate() {
    setBusy(true);
    onError(null);
    try {
      await createPassport(pet.id, expiryDate());
      onPassportChanged();
      onNotice('Passport link generated');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not generate passport');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    setBusy(true);
    onError(null);
    try {
      await revokePassport(pet.id);
      onPassportChanged();
      onNotice('Passport link revoked');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not revoke passport');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!passportUrl) return;
    try {
      await navigator.clipboard.writeText(passportUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError('Could not copy — try long-pressing the link');
    }
  }

  async function handleShare() {
    if (!passportUrl) return;
    const shareData = {
      title: `${pet.name}'s vaccine records`,
      text: `Here are ${pet.name}'s vaccine records from Petshots.`,
      url: passportUrl,
    };
    if (typeof navigator.share === 'function') {
      try { await navigator.share(shareData); } catch { /* user cancelled */ }
    } else {
      await handleCopy();
    }
  }

  if (!passportUrl) {
    return (
      <div className="share-tab card">
        <p className="share-tab__intro">
          Generate a link anyone can open — no login required. Share it with your groomer,
          boarding facility, or vet ahead of check-in.
        </p>
        <label className="share-tab__expiry-label">
          Link expires
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="7d">In 7 days</option>
            <option value="30d">In 30 days</option>
            <option value="90d">In 90 days</option>
            <option value="1y">In 1 year</option>
            <option value="never">Never</option>
          </select>
        </label>
        <button className="btn btn--primary" onClick={handleGenerate} disabled={busy}>
          {busy ? 'Generating…' : `Generate passport for ${pet.name}`}
        </button>
      </div>
    );
  }

  return (
    <div className="share-tab card">
      {qrDataUrl && (
        <div className="share-tab__qr-wrap">
          <img className="share-tab__qr" src={qrDataUrl} alt="QR code — scan to open passport" />
        </div>
      )}

      <div className="share-tab__url-row">
        <span className="share-tab__url" title={passportUrl}>{passportUrl}</span>
      </div>

      <div className="share-tab__actions">
        <button className="btn btn--primary" onClick={handleShare}>
          Share ↗
        </button>
        <button className="btn" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>

      {pet.passportExpiry && (
        <p className="share-tab__expiry subtle">
          Expires {formatDate(pet.passportExpiry)}
        </p>
      )}

      <div className="share-tab__revoke">
        <button
          className="btn btn--link btn--danger"
          onClick={handleRevoke}
          disabled={busy}
        >
          {busy ? 'Revoking…' : 'Revoke link'}
        </button>
        <span className="subtle share-tab__revoke-hint">Revoked links stop working immediately.</span>
      </div>
    </div>
  );
}

// ---- profile edit screen ----

function ProfileEditScreen({
  pet,
  onDone,
  onCancel,
  onError,
  onNotice,
}: {
  pet: Pet;
  onDone: () => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [breed, setBreed] = useState(pet.breed ?? '');
  const [dob, setDob] = useState(pet.dob ?? '');
  const [weight, setWeight] = useState(pet.weight ?? '');
  const [fixed, setFixed] = useState<'' | 'true' | 'false'>(
    pet.fixed === true ? 'true' : pet.fixed === false ? 'false' : ''
  );
  const [microchip, setMicrochip] = useState(pet.microchip ?? '');
  const [allergies, setAllergies] = useState(pet.allergies ?? '');
  const [behavior, setBehavior] = useState(pet.behavior ?? '');
  const [notes, setNotes] = useState(pet.notes ?? '');
  const [vetName, setVetName] = useState(pet.vetName ?? '');
  const [vetPhone, setVetPhone] = useState(pet.vetPhone ?? '');
  const [emergencyContact, setEmergencyContact] = useState(pet.emergencyContact ?? '');
  const [busy, setBusy] = useState(false);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      await updatePet(pet.id, {
        name: pet.name,
        species: pet.species,
        breed: breed || undefined,
        dob: dob || undefined,
        weight: weight || undefined,
        fixed: fixed === 'true' ? true : fixed === 'false' ? false : undefined,
        microchip: microchip || undefined,
        allergies: allergies || undefined,
        behavior: behavior || undefined,
        notes: notes || undefined,
        vetName: vetName || undefined,
        vetPhone: vetPhone || undefined,
        emergencyContact: emergencyContact || undefined,
      });
      onNotice('Profile saved');
      await onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onCancel}>
          ← {pet.name}
        </button>
        <span className="screen-nav__title">Edit Profile</span>
      </nav>
      <form className="form profile-form" onSubmit={handleSave}>
        <p className="profile-form__hint subtle">All fields are optional.</p>

        <fieldset className="profile-form__group">
          <legend>About</legend>
          <label>Breed
            <input value={breed} onChange={(e) => setBreed(e.target.value)} placeholder="e.g. Labrador Retriever" />
          </label>
          <label>Date of birth
            <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          </label>
          <label>Weight
            <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 45 lbs" />
          </label>
          <label>Spayed / Neutered
            <select value={fixed} onChange={(e) => setFixed(e.target.value as '' | 'true' | 'false')}>
              <option value="">Unknown</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
          <label>Microchip number
            <input value={microchip} onChange={(e) => setMicrochip(e.target.value)} placeholder="15-digit ID" />
          </label>
        </fieldset>

        <fieldset className="profile-form__group">
          <legend>Health notes</legend>
          <label>Known allergies
            <textarea value={allergies} onChange={(e) => setAllergies(e.target.value)} placeholder="e.g. Chicken, pollen" rows={2} />
          </label>
          <label>Behavior notes
            <textarea value={behavior} onChange={(e) => setBehavior(e.target.value)} placeholder="e.g. Reactive on leash, anxious around loud noises" rows={2} />
          </label>
          <label>Special instructions
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Needs medication twice daily, feed at 7am/6pm" rows={2} />
          </label>
        </fieldset>

        <fieldset className="profile-form__group">
          <legend>Contacts</legend>
          <label>Vet name
            <input value={vetName} onChange={(e) => setVetName(e.target.value)} placeholder="e.g. Dr. Smith at Riverside Vet" />
          </label>
          <label>Vet phone
            <input type="tel" value={vetPhone} onChange={(e) => setVetPhone(e.target.value)} placeholder="(555) 000-0000" />
          </label>
          <label>Emergency contact
            <input value={emergencyContact} onChange={(e) => setEmergencyContact(e.target.value)} placeholder="Name · phone number" />
          </label>
        </fieldset>

        <div className="actions">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ---- present mode (full-screen swipeable carousel) ----

function PresentScreen({
  pet,
  docs,
  onExit,
}: {
  pet: Pet;
  docs: Doc[];
  onExit: () => void;
}) {
  const [current, setCurrent] = useState(0);
  const slidesRef = useRef<HTMLDivElement>(null);

  // Dismiss on Escape key.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onExit(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onExit]);

  // Lock body scroll while presenting.
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  function handleScroll() {
    const el = slidesRef.current;
    if (!el) return;
    setCurrent(Math.round(el.scrollLeft / el.clientWidth));
  }

  return (
    <div className="present" role="dialog" aria-label={`${pet.name}'s records`}>
      <button className="present__exit" onClick={onExit} aria-label="Exit presentation">✕</button>

      <div className="present__slides" ref={slidesRef} onScroll={handleScroll}>
        {docs.map((doc) => {
          const isImage = IMAGE_EXTS.includes(extOf(doc.filename));
          const status = statusOf(doc.expiry);
          return (
            <div key={doc.id} className="present__slide">
              <div className="present__doc-header">
                <span className="present__doc-label">{doc.label}</span>
                <div className="present__doc-meta">
                  <StatusBadge expiry={doc.expiry} />
                  {doc.expiry && (
                    <span className="present__doc-expiry">
                      {status === 'overdue' ? 'Expired' : 'Expires'} {formatDate(doc.expiry)}
                    </span>
                  )}
                </div>
              </div>

              <div className="present__doc-content">
                {isImage ? (
                  <img
                    src={doc.url}
                    alt={doc.label}
                    className="present__doc-img"
                    loading="lazy"
                  />
                ) : (
                  <div className="present__pdf-card">
                    <span className="present__pdf-icon" aria-hidden="true">📄</span>
                    <p className="present__pdf-name">{doc.label}</p>
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn--primary btn--lg"
                    >
                      Open PDF ↗
                    </a>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="present__footer">
        <span className="present__pet-name">{pet.name}</span>
        {docs.length > 1 && (
          <div className="present__dots" aria-hidden="true">
            {docs.map((_, i) => (
              <span key={i} className={`present__dot${i === current ? ' present__dot--active' : ''}`} />
            ))}
          </div>
        )}
        {docs.length > 1 && (
          <span className="present__counter">{current + 1} / {docs.length}</span>
        )}
      </div>
    </div>
  );
}

// ---- settings screen ----

const REMINDER_DAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '1 day before' },
  { value: 3, label: '3 days before' },
  { value: 7, label: '1 week before' },
  { value: 14, label: '2 weeks before' },
  { value: 30, label: '1 month before' },
  { value: 60, label: '2 months before' },
];

function SettingsScreen({
  email,
  theme,
  onThemeChange,
  onDone,
  onError,
  onNotice,
}: {
  email: string;
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onDone: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSettings()
      .then((s) => setSettings({ ...DEFAULT_SETTINGS, ...s, email: s.email || email }))
      .catch(() => setSettings({ ...DEFAULT_SETTINGS, email }))
      .finally(() => setLoading(false));
  }, [email]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    onError(null);
    try {
      await saveSettings({ ...settings, email });
      onNotice('Settings saved');
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  }

  function toggleDay(day: number) {
    if (!settings) return;
    const days = settings.reminderDays.includes(day)
      ? settings.reminderDays.filter((d) => d !== day)
      : [...settings.reminderDays, day].sort((a, b) => a - b);
    setSettings({ ...settings, reminderDays: days });
  }

  return (
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onDone}>
          ← Dashboard
        </button>
        <span className="screen-nav__title">Settings</span>
      </nav>
      <div className="screen-view__body">
        {loading ? (
          <p className="subtle">Loading…</p>
        ) : (
          <form className="form settings-form" onSubmit={handleSave}>

            <fieldset className="settings-group">
              <legend>Appearance</legend>
              <div className="settings-row">
                <span className="settings-row__label">Theme</span>
                <div className="theme-toggle">
                  <button
                    type="button"
                    className={`theme-toggle__btn${theme === 'dark' ? ' theme-toggle__btn--active' : ''}`}
                    onClick={() => onThemeChange('dark')}
                  >
                    Dark
                  </button>
                  <button
                    type="button"
                    className={`theme-toggle__btn${theme === 'light' ? ' theme-toggle__btn--active' : ''}`}
                    onClick={() => onThemeChange('light')}
                  >
                    Light
                  </button>
                </div>
              </div>
            </fieldset>

            <fieldset className="settings-group">
              <legend>Email</legend>
              <div className="settings-row">
                <label className="settings-row__label" htmlFor="marketing-toggle">
                  Product updates
                  <span className="subtle settings-row__sub">Tips, new features, and Petshots news</span>
                </label>
                <label className="toggle" aria-label="Toggle marketing emails">
                  <input
                    id="marketing-toggle"
                    type="checkbox"
                    checked={settings?.marketingOptIn ?? false}
                    onChange={(e) => settings && setSettings({ ...settings, marketingOptIn: e.target.checked })}
                  />
                  <span className="toggle__track" />
                </label>
              </div>

              <div className="settings-group__divider" />

              <div className="settings-row">
                <label className="settings-row__label" htmlFor="reminders-toggle">
                  Vaccine reminders
                  <span className="subtle settings-row__sub">Get emailed before records expire</span>
                </label>
                <label className="toggle" aria-label="Toggle vaccine reminders">
                  <input
                    id="reminders-toggle"
                    type="checkbox"
                    checked={settings?.remindersEnabled ?? false}
                    onChange={(e) => settings && setSettings({ ...settings, remindersEnabled: e.target.checked })}
                  />
                  <span className="toggle__track" />
                </label>
              </div>

              {settings?.remindersEnabled && (
                <>
                  <p className="settings-hint subtle">Send reminders to <strong>{email}</strong>:</p>
                  <div className="settings-days">
                    {REMINDER_DAY_OPTIONS.map(({ value, label }) => (
                      <label key={value} className="settings-day-chip">
                        <input
                          type="checkbox"
                          checked={settings.reminderDays.includes(value)}
                          onChange={() => toggleDay(value)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </fieldset>

            <div className="actions">
              <button className="btn btn--primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save settings'}
              </button>
              <button className="btn" type="button" onClick={onDone} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ChangePasswordScreen({
  onDone,
  onCancel,
  onError,
}: {
  onDone: () => void;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) { onError('New passwords do not match.'); return; }
    if (next.length < 8) { onError('New password must be at least 8 characters.'); return; }
    setBusy(true);
    onError(null);
    try {
      await changePassword(current, next);
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not change password';
      onError(msg.includes('NotAuthorizedException') || msg.includes('Incorrect') ? 'Current password is incorrect.' : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onCancel}>
          ← Dashboard
        </button>
        <span className="screen-nav__title">Change Password</span>
      </nav>
      <form className="form" onSubmit={handleSubmit}>
        <label>
          Current password
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </label>
        <label>
          New password
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <div className="actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !current || !next || !confirm}>
            {busy ? 'Saving…' : 'Change password'}
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
