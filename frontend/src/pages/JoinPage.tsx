// Family invite landing page (/join/{token}). Public: shows who's inviting
// you before any login. Accepting requires an account — the invite is stored
// locally across the signup/login hop and the dashboard routes back here.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getInviteInfo, joinHousehold } from '../api';
import { useAuth } from '../auth/AuthContext';
import { SiteHeader } from '../components/SiteHeader';

export const PENDING_INVITE_KEY = 'petshots.pendingInvite';

function joinError(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  switch (msg) {
    case 'ALREADY_IN_FAMILY':
      return "You're already part of another family. Leave it first (Settings → Family).";
    case 'HAS_OWN_FAMILY':
      return 'You have family members of your own, so you can\'t join another family.';
    case 'MEMBER_LIMIT_REACHED':
      return "This family is full — its owner's plan has no member seats left.";
    case 'OWN_INVITE':
      return 'This is your own invite link — send it to a family member instead.';
    case 'INVITE_NOT_FOUND':
      return 'This invite link is invalid or has expired. Ask for a new one.';
    default:
      return msg || 'Something went wrong. Try again.';
  }
}

export function JoinPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { email, loading } = useAuth();
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvalid(true);
      return;
    }
    getInviteInfo(token)
      .then((info) => {
        setOwnerEmail(info.ownerEmail ?? null);
        // Stash immediately: the login/signup hop can start from ANY link on
        // this page (including the site header), and the dashboard's pickup
        // routes back here afterwards.
        localStorage.setItem(PENDING_INVITE_KEY, token);
      })
      .catch(() => setInvalid(true));
  }, [token]);

  async function accept() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await joinHousehold(token);
      localStorage.removeItem(PENDING_INVITE_KEY);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(joinError(err));
    } finally {
      setBusy(false);
    }
  }

  // Declining shouldn't leave a stale token that bounces the next dashboard
  // visit back here.
  function decline() {
    localStorage.removeItem(PENDING_INVITE_KEY);
  }

  return (
    <>
      <SiteHeader />
      <main className="page page--centered">
        <h1>Family invite</h1>

        {invalid ? (
          <section className="card">
            <p>This invite link is invalid or has expired.</p>
            <p className="subtle">Ask the person who sent it for a fresh one — invites last 7 days.</p>
          </section>
        ) : (
          <section className="card">
            <p>
              {ownerEmail ? <strong>{ownerEmail}</strong> : 'Someone'} invited you to share
              their pets' records on Petshots — vaccine records, medications, and reminders,
              together in one place.
            </p>

            {error && <p className="error">{error}</p>}

            {loading ? null : email ? (
              <div className="actions">
                <button className="btn btn--primary" type="button" onClick={() => void accept()} disabled={busy}>
                  {busy ? 'Joining…' : 'Accept invite'}
                </button>
                <Link className="btn" to="/dashboard" onClick={decline}>
                  Not now
                </Link>
              </div>
            ) : (
              <>
                <p className="subtle">You'll need a free Petshots account to accept.</p>
                <div className="actions">
                  <Link className="btn btn--primary" to="/signup">
                    Sign up
                  </Link>
                  <Link className="btn" to="/login">
                    Log in
                  </Link>
                </div>
              </>
            )}
          </section>
        )}
      </main>
    </>
  );
}
