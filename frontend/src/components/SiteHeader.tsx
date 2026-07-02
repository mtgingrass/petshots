import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Shared top nav for the public pages (landing / login / signup).
// The dashboard has its own header with pet context + logout.
export function SiteHeader() {
  const { email } = useAuth();

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="wordmark" to="/">
          🐾 Petshots
        </Link>
        <nav className="site-nav">
          {email ? (
            <Link className="btn btn--primary" to="/dashboard">
              Dashboard
            </Link>
          ) : (
            <>
              <Link className="btn btn--link" to="/login">
                Log in
              </Link>
              <Link className="btn btn--primary" to="/signup">
                Get started
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
