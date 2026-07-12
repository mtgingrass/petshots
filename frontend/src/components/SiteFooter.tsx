import { Link } from 'react-router-dom';
import { isNative } from '../native';
import { APP_STORE_URL } from '../productConfig';

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
          {/* Browser-only: pointless inside the native app. Goes to the
              App Store once APP_STORE_URL is set; until then, the landing
              page's iPhone section (#iphone bypasses the logged-in
              redirect there). */}
          {!isNative &&
            (APP_STORE_URL ? (
              <>
                {' '}
                · <a href={APP_STORE_URL}>📱 Get the iPhone app</a>
              </>
            ) : (
              <>
                {' '}
                · <a href="/#iphone">📱 Get the iPhone app</a>
              </>
            ))}
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
