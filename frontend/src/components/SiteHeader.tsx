import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { applyTheme, getSavedTheme, type Theme } from '../utils/theme';

// Shared top nav for the public pages (landing / login / signup).
// The dashboard has its own header with pet context + logout.
export function SiteHeader() {
  const { email } = useAuth();
  const [theme, setTheme] = useState<Theme>(getSavedTheme);

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  }

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="wordmark" to="/">
          🐾 Petshots
        </Link>
        <nav className="site-nav">
          <button
            className="btn btn--icon theme-btn"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          {email ? (
            <Link className="btn btn--primary" to="/dashboard">
              Dashboard
            </Link>
          ) : (
            <>
              <Link className="btn" to="/login">
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
