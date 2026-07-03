// Two-phase sign-up: (1) create the account, (2) confirm with the emailed code.
// We flip between phases with local state rather than separate routes.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signUp, confirmSignUp, resendConfirmationCode } from '../auth/cognito';
import { Turnstile } from '../components/Turnstile';
import { SiteHeader } from '../components/SiteHeader';

export function SignUp() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<'register' | 'confirm'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaKey, setCaptchaKey] = useState(0); // bump to remount the widget
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signUp(email, password, captchaToken);
      // Store opt-in for pickup on first dashboard load (can't call API until confirmed + logged in).
      localStorage.setItem('petshots.pendingMarketingOptIn', marketingOptIn ? 'true' : 'false');
      setPhase('confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-up failed');
      // Turnstile tokens are single-use - reset the widget for another attempt.
      setCaptchaToken('');
      setCaptchaKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await confirmSignUp(email, code);
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SiteHeader />
      <main className="page page--centered">
        <h1>Create your account</h1>

      {error && <p className="error">{error}</p>}

      {phase === 'register' ? (
        <form className="form" onSubmit={handleRegister}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </label>
          <p className="subtle">
            8+ characters with upper, lower, number, and symbol.
          </p>
          <label className="marketing-opt-in">
            <input
              type="checkbox"
              checked={marketingOptIn}
              onChange={(e) => setMarketingOptIn(e.target.checked)}
            />
            <span>Send me product updates and tips from Petshots</span>
          </label>
          <Turnstile key={captchaKey} onToken={setCaptchaToken} />
          <button className="btn btn--primary" type="submit" disabled={busy || !captchaToken}>
            {busy ? 'Creating…' : 'Sign up'}
          </button>
        </form>
      ) : (
        <form className="form" onSubmit={handleConfirm}>
          <p className="subtle">
            We emailed a 6-digit code to <strong>{email}</strong>. Enter it below.
          </p>
          <label>
            Verification code
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'Confirming…' : 'Confirm'}
          </button>
          <button
            type="button"
            className="btn btn--link"
            onClick={() => resendConfirmationCode(email).catch(() => undefined)}
          >
            Resend code
          </button>
        </form>
      )}

        <p className="subtle">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </main>
    </>
  );
}
