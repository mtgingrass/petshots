import { Link } from 'react-router-dom';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="site-footer__feedback">
          Found a bug or have a feature request?{' '}
          <a href="mailto:mark.gingrass@gmail.com?subject=Petshots%20Feedback">
            Send us a note
          </a>{' '}
          · <Link to="/support">Support</Link> · <Link to="/roadmap">Roadmap</Link>
        </p>
        <p className="site-footer__legal">
          © {new Date().getFullYear()} Petshots ·{' '}
          <Link to="/privacy">Privacy Policy</Link> · Your records stay private
          — only you can see them.
        </p>
      </div>
    </footer>
  );
}
