import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { getRoadmap } from '../api';
import { useAuth } from '../auth/AuthContext';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';
// Real dashboard screenshot (demo account) — the hero product shot. Retake
// via scripts/shoot-docs.mjs and re-copy from docs/images/ when the
// overview screen changes noticeably.
import dashboardShot from '../assets/landing-dashboard.png';

// Static fallback for the roadmap teaser — shown until (or if never) the
// live board loads. Keep it plausible but generic.
const TEASER_FALLBACK = 'family sharing, daily care checklists, and weight tracking';

// "Weekly digest email" reads fine at sentence start but not mid-sentence —
// lowercase the first word unless it looks like an acronym (AI, QR…).
function inSentence(title: string): string {
  return /^[A-Z][a-z]/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title;
}

// The 3 most recently shipped roadmap items as an "x, y, and z" phrase.
function recentShipsPhrase(items: { status: string; title: string; completedAt?: string }[]): string | null {
  const shipped = items
    .filter((i) => i.status === 'complete' && i.completedAt)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .slice(0, 3)
    .map((i) => inSentence(i.title));
  if (shipped.length === 0) return null;
  if (shipped.length === 1) return shipped[0];
  return `${shipped.slice(0, -1).join(', ')}${shipped.length > 2 ? ',' : ''} and ${shipped[shipped.length - 1]}`;
}

export function Landing() {
  const { email } = useAuth();
  const [recentShips, setRecentShips] = useState<string | null>(null);

  useEffect(() => {
    getRoadmap()
      .then((r) => setRecentShips(recentShipsPhrase(r.items)))
      .catch(() => {}); // fallback copy stays
  }, []);

  if (email) return <Navigate to="/dashboard" replace />;

  return (
    <>
      <SiteHeader />
      <main className="page">
        <section className="hero">
          <div className="hero__copy">
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
          </div>
          <div className="hero__phone" aria-hidden="true">
            <img
              src={dashboardShot}
              alt=""
              width={780}
              height={1688}
              loading="eager"
            />
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

        <h2 className="section-title">And after the door</h2>
        <ul className="feature-grid">
          <li>
            <span className="feature-grid__icon" aria-hidden="true">🔔</span>
            <strong>Reminders</strong>
            <p className="subtle">Email and push before anything expires — vaccines, meds, birthdays.</p>
          </li>
          <li>
            <span className="feature-grid__icon" aria-hidden="true">✅</span>
            <strong>Daily care checklist</strong>
            <p className="subtle">Feedings, meds, walks — shared with the family so nobody feeds the dog twice.</p>
          </li>
          <li>
            <span className="feature-grid__icon" aria-hidden="true">📈</span>
            <strong>Trends</strong>
            <p className="subtle">Mood, weight, care, and walk charts — spot "he's been off all week" early.</p>
          </li>
          <li>
            <span className="feature-grid__icon" aria-hidden="true">📸</span>
            <strong>Photo albums</strong>
            <p className="subtle">Casual snaps in a per-pet album, shared with your family in real time.</p>
          </li>
          <li>
            <span className="feature-grid__icon" aria-hidden="true">🚶</span>
            <strong>Walks & badges</strong>
            <p className="subtle">GPS-tracked walks, achievement badges, and a family walk-off leaderboard.</p>
          </li>
          <li>
            <span className="feature-grid__icon" aria-hidden="true">🎫</span>
            <strong>Pet passport</strong>
            <p className="subtle">A shareable link with the records the groomer or boarder needs — no account required.</p>
          </li>
        </ul>

        <div className="pledge">
          <strong>No clutter, ever.</strong> No feeds, no upsells, no
          vet-portal maze. Just your pet's records, free.
        </div>

        <p className="roadmap-teaser subtle">
          Petshots ships every week — {recentShips ?? TEASER_FALLBACK} all landed
          recently. <Link to="/roadmap">See what's next on the roadmap →</Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
