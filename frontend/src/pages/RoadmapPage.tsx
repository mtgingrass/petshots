// Public roadmap board (/roadmap): three columns of curated items with vote
// counts. Anyone can look; voting needs a (free) account — the chip is the
// login nudge. Items are edited operator-side in S3, not here.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getRoadmap,
  getMyRoadmapVotes,
  toggleRoadmapVote,
  type RoadmapItem,
} from '../api';
import { useAuth } from '../auth/AuthContext';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';

const COLUMNS: { status: RoadmapItem['status']; label: string; dot: string }[] = [
  { status: 'planned', label: 'Planned', dot: 'roadmap-dot--planned' },
  { status: 'in-progress', label: 'In progress', dot: 'roadmap-dot--progress' },
  { status: 'complete', label: 'Complete', dot: 'roadmap-dot--complete' },
];

export function RoadmapPage() {
  const { email } = useAuth();
  const [items, setItems] = useState<RoadmapItem[] | null>(null);
  const [voted, setVoted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState(false); // logged-out vote attempt

  useEffect(() => {
    getRoadmap()
      .then((r) => setItems(r.items))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the roadmap.'));
  }, []);

  useEffect(() => {
    if (!email) return;
    getMyRoadmapVotes()
      .then((r) => setVoted(new Set(r.voted)))
      .catch(() => {});
  }, [email]);

  async function vote(item: RoadmapItem) {
    if (!email) {
      setNudge(true);
      return;
    }
    try {
      const res = await toggleRoadmapVote(item.id);
      setItems((prev) =>
        prev ? prev.map((i) => (i.id === item.id ? { ...i, votes: res.votes } : i)) : prev,
      );
      setVoted((prev) => {
        const next = new Set(prev);
        if (res.voted) next.add(item.id);
        else next.delete(item.id);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your vote.');
    }
  }

  return (
    <>
      <SiteHeader />
      <main className="page">
        <h1>Roadmap</h1>
        <p className="subtle">
          What we're building next, what's underway, and what recently shipped. Vote for
          what matters to you{email ? '' : ' — you just need a free account'}.
        </p>

        {nudge && !email && (
          <p className="roadmap-nudge">
            <Link to="/signup">Create a free account</Link> or <Link to="/login">log in</Link> to
            vote.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {items === null && !error && <p className="subtle">Loading…</p>}

        {items && (
          <div className="roadmap-board">
            {COLUMNS.map((col) => {
              const colItems = items
                .filter((i) => i.status === col.status)
                .sort((a, b) => b.votes - a.votes);
              return (
                <section className="roadmap-col" key={col.status}>
                  <h2 className="roadmap-col__title">
                    <span className={`roadmap-dot ${col.dot}`} aria-hidden="true" />
                    {col.label}
                  </h2>
                  {colItems.length === 0 && <p className="subtle">Nothing here right now.</p>}
                  {colItems.map((item) => (
                    <div className="roadmap-card" key={item.id}>
                      <button
                        type="button"
                        className={`roadmap-vote${voted.has(item.id) ? ' roadmap-vote--on' : ''}`}
                        aria-pressed={voted.has(item.id)}
                        aria-label={`Vote for ${item.title}`}
                        onClick={() => void vote(item)}
                      >
                        <span aria-hidden="true">▲</span>
                        {item.votes}
                      </button>
                      <div className="roadmap-card__body">
                        <span className="roadmap-card__title">{item.title}</span>
                        {item.description && (
                          <span className="subtle roadmap-card__desc">{item.description}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
        )}

        <p className="subtle">
          Missing something?{' '}
          <a href="mailto:mark.gingrass@gmail.com?subject=Petshots%20Feature%20Request">
            Tell us what you'd like to see
          </a>
          .
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
