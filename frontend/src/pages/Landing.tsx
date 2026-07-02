import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';

export function Landing() {
  const { email } = useAuth();

  return (
    <>
      <SiteHeader />
      <main className="page">
        <section className="hero">
          <span className="hero__badge" aria-hidden="true">
            🐾
          </span>
          {email ? (
            <>
              <h1>Your records are ready.</h1>
              <p className="tagline">
                Head to your dashboard to view, add, or share your pet's
                records.
              </p>
              <div className="actions">
                <Link className="btn btn--primary btn--lg" to="/dashboard">
                  Go to your dashboard →
                </Link>
              </div>
            </>
          ) : (
            <>
              <h1>Proof of shots, in seconds.</h1>
              <p className="tagline">
                Your pet's vaccine records on your phone — ready before the
                front desk finishes asking.
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
            </>
          )}
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
              One tap on your phone pulls up the record while the staff waits.
            </p>
          </li>
        </ol>

        <div className="pledge">
          <strong>No clutter, ever.</strong> No feeds, no upsells, no vet-portal
          maze. Just your pet's records — free for one pet and four documents.
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
