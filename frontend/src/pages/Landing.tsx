import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';

const KOFI_URL = 'https://ko-fi.com/markgingrass';
const APP_URL = 'https://petshots.app';

export function Landing() {
  const { email } = useAuth();
  const [copied, setCopied] = useState(false);

  async function shareApp() {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Petshots',
          text: 'Pet vaccine records on your phone — ready at the door.',
          url: APP_URL,
        });
      } catch {
        // user cancelled share sheet — no-op
      }
    } else {
      await navigator.clipboard.writeText(APP_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <>
      <SiteHeader />
      <main className="page">
        {email ? (
          <>
            <section className="hero">
              <span className="hero__badge" aria-hidden="true">🐾</span>
              <h1>Welcome back.</h1>
              <div className="actions">
                <Link className="btn btn--primary btn--lg" to="/dashboard">
                  Go to your dashboard →
                </Link>
              </div>
            </section>

            <div className="support-cards">
              <div className="support-card">
                <p className="support-card__title">Enjoying Petshots?</p>
                <p className="subtle">
                  If it saved you from scrambling at the door, a coffee keeps
                  the lights on.
                </p>
                <a
                  href={KOFI_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn"
                >
                  ☕ Buy me a coffee
                </a>
              </div>
              <div className="support-card">
                <p className="support-card__title">Know a dog owner?</p>
                <p className="subtle">
                  If your friend scrambles for shot records every time they show
                  up somewhere new, send them here.
                </p>
                <button className="btn" onClick={() => void shareApp()}>
                  {copied ? '✓ Link copied!' : 'Share Petshots'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <section className="hero">
              <span className="hero__badge" aria-hidden="true">🐾</span>
              <h1>Proof of shots, in seconds.</h1>
              <p className="tagline">
                Your pet's vaccine records on your phone.
              </p>
              <p className="subtle">
                Daycare, groomer, boarding, the dog bar. They all want the
                rabies cert <em>right now</em>, and it's always buried in an
                email from your vet. Petshots keeps it one tap away.
              </p>
              <div className="actions">
                <Link className="btn btn--primary btn--lg" to="/signup">
                  Get started — it's free
                </Link>
                <Link className="btn btn--lg" to="/login">
                  Log in
                </Link>
              </div>
            </section>

            <h2 className="section-title">How it works</h2>
            <ol className="steps">
              <li>
                <strong>Upload once</strong>
                <p className="subtle">
                  Snap a photo or save the PDF from your vet. Takes a minute.
                </p>
              </li>
              <li>
                <strong>We track the dates</strong>
                <p className="subtle">
                  Add the expiration date and Petshots flags anything overdue or
                  due soon.
                </p>
              </li>
              <li>
                <strong>Show it at the door</strong>
                <p className="subtle">
                  One tap on your phone pulls up the record while the staff
                  waits.
                </p>
              </li>
            </ol>

            <div className="pledge">
              <strong>No clutter, ever.</strong> No feeds, no upsells, no
              vet-portal maze. Just your pet's records, free.
            </div>
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
