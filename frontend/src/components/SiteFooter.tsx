import { AffiliateLinks } from './AffiliateLinks';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <AffiliateLinks />
        <p className="site-footer__legal">
          © {new Date().getFullYear()} Petshots · Your records stay private —
          only you can see them.
        </p>
      </div>
    </footer>
  );
}
