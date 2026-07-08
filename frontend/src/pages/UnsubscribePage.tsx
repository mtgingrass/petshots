import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { unsubscribeAll } from '../api';

// Landing page for the unsubscribe link in every Petshots email. The link is a
// GET, but unsubscribing requires the confirm click below (a POST) — otherwise
// mail-scanner prefetch would silently opt people out.
export function UnsubscribePage() {
  const [params] = useSearchParams();
  const sub = params.get('u') ?? '';
  const token = params.get('t') ?? '';
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const linkValid = sub !== '' && token !== '';

  async function handleUnsubscribe() {
    setState('busy');
    setErrorMsg(null);
    try {
      await unsubscribeAll(sub, token);
      setState('done');
    } catch (e) {
      setState('error');
      setErrorMsg(e instanceof Error ? e.message : 'Something went wrong — try again.');
    }
  }

  return (
    <div className="page">
      <header className="passport-page__header">
        <a className="wordmark" href="/">🐾 Petshots</a>
      </header>
      <section className="card unsubscribe-card">
        {!linkValid ? (
          <>
            <h1>Unsubscribe</h1>
            <p>
              This unsubscribe link is missing its details. Use the link from a Petshots email, or
              log in and pause email in <Link to="/dashboard">Settings</Link>.
            </p>
          </>
        ) : state === 'done' ? (
          <>
            <h1>You're unsubscribed</h1>
            <p>
              You won't get any more email from Petshots — no reminders, birthdays, or updates.
            </p>
            <p className="subtle">
              Changed your mind? <Link to="/login">Log in</Link> and turn off "Pause all email" in
              Settings. Your reminder preferences were kept.
            </p>
          </>
        ) : (
          <>
            <h1>Unsubscribe from all Petshots email?</h1>
            <p>
              This stops everything: vaccine reminders, medication reminders, birthdays, and product
              updates. Your account and records are not affected.
            </p>
            {errorMsg && <p className="danger-confirm__error" role="alert">{errorMsg}</p>}
            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={state === 'busy'}
                onClick={() => void handleUnsubscribe()}
              >
                {state === 'busy' ? 'Unsubscribing…' : 'Unsubscribe from all email'}
              </button>
            </div>
            <p className="subtle">
              Rather fine-tune instead? Log in and adjust individual reminders in Settings.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
