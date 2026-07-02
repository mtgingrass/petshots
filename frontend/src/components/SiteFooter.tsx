import { Link } from 'react-router-dom';
import { AffiliateLinks } from './AffiliateLinks';

// Set to your Ko-fi URL (e.g. 'https://ko-fi.com/yourname') to show the donation line.
const DONATION_URL = 'https://ko-fi.com/markgingrass';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <AffiliateLinks />
        {DONATION_URL && (
          <p className="site-footer__support">
            <a href={DONATION_URL} target="_blank" rel="noopener noreferrer">
              ☕ Buy me a coffee
            </a>{' '}
            if Petshots saved you from scrambling at the door.
          </p>
        )}
        <p className="site-footer__feedback">
          Found a bug or have a feature request?{' '}
          <a href="mailto:mark.gingrass@gmail.com?subject=Petshots%20Feedback">
            Send us a note
          </a>
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
