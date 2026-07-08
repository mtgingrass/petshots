// Two-phase password reset: (1) request the emailed code, (2) submit code +
// new password. Same phase-flip pattern as SignUp.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { forgotPassword, confirmForgotPassword } from '../auth/cognito';
import { SiteHeader } from '../components/SiteHeader';

// Cognito error names → copy a person can act on. The request phase never
// reveals whether the account exists (preventUserExistenceErrors), so the
// friendly messages must not either.
function friendlyError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'CodeMismatchException':
      return 'That code is not right. Check the email and try again.';
    case 'ExpiredCodeException':
      return 'That code has expired. Request a new one.';
    case 'InvalidPasswordException':
      return 'Password must be 8+ characters with upper, lower, number, and symbol.';
    case 'LimitExceededException':
      return 'Too many attempts. Wait a few minutes and try again.';
    default:
      return err instanceof Error ? err.message : 'Something went wrong. Try again.';
  }
}

export function ResetPassword() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<'request' | 'confirm'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRequest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await forgotPassword(email);
      setPhase('confirm');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await confirmForgotPassword(email, code, password);
      navigate('/login', { replace: true });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SiteHeader />
      <main className="page page--centered">
        <h1>Reset your password</h1>

        {error && <p className="error">{error}</p>}

        {phase === 'request' ? (
          <form className="form" onSubmit={handleRequest}>
            <p className="subtle">
              Enter your account email and we'll send a reset code.
            </p>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                autoFocus
              />
            </label>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset code'}
            </button>
          </form>
        ) : (
          <form className="form" onSubmit={handleConfirm}>
            <p className="subtle">
              If an account exists for <strong>{email}</strong>, a 6-digit code
              is on its way. Enter it below with your new password.
            </p>
            <label>
              Reset code
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
              />
            </label>
            <label>
              New password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
              />
            </label>
            <p className="subtle">
              8+ characters with upper, lower, number, and symbol.
            </p>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
            <button
              type="button"
              className="btn btn--link"
              onClick={() => forgotPassword(email).catch(() => undefined)}
            >
              Resend code
            </button>
          </form>
        )}

        <p className="subtle">
          Remembered it? <Link to="/login">Log in</Link>
        </p>
      </main>
    </>
  );
}
