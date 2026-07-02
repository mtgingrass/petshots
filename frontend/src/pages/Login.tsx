import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signIn } from '../auth/cognito';
import { useAuth } from '../auth/AuthContext';
import { SiteHeader } from '../components/SiteHeader';

export function Login() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
      await refresh(); // pull the new session into context
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SiteHeader />
      <main className="page page--centered">
        <h1>Welcome back</h1>

      {error && <p className="error">{error}</p>}

      <form className="form" onSubmit={handleSubmit}>
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
            autoComplete="current-password"
          />
        </label>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>

        <p className="subtle">
          Need an account? <Link to="/signup">Sign up</Link>
        </p>
      </main>
    </>
  );
}
