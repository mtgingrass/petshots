import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function Landing() {
  const { email } = useAuth();

  return (
    <main className="page page--centered">
      <h1>Petshots</h1>
      <p className="tagline">
        Your dog's rabies cert, ready in 10 seconds at the dog-bar door.
      </p>
      <p className="subtle">
        Store your pet's vaccination records and pull them up on your phone the
        moment the front desk asks — no more digging through vet emails.
      </p>

      <div className="actions">
        {email ? (
          <Link className="btn btn--primary" to="/dashboard">
            Go to your dashboard
          </Link>
        ) : (
          <>
            <Link className="btn btn--primary" to="/signup">
              Get started
            </Link>
            <Link className="btn" to="/login">
              Log in
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
