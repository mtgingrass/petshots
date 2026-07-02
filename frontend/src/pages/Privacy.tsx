import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';

export function Privacy() {
  return (
    <>
      <SiteHeader />
      <main className="page privacy">
        <h1>Privacy Policy</h1>
        <p className="subtle">Effective July 2, 2026</p>

        <section>
          <h2>What we collect</h2>
          <ul>
            <li>Your email address — used only to create and sign in to your account.</li>
            <li>Pet names and species you enter.</li>
            <li>Documents you upload: vaccine records, vet paperwork, and pet photos.</li>
          </ul>
          <p>
            We don't collect your real name, address, payment information, or any
            information about your pet's veterinarian.
          </p>
        </section>

        <section>
          <h2>Where it's stored</h2>
          <p>
            All data is stored on Amazon Web Services (AWS) in the US-East-1 (Virginia)
            region. Files are encrypted at rest and in transit (HTTPS only). Your uploaded
            documents are stored in a private bucket — they are never publicly accessible.
          </p>
        </section>

        <section>
          <h2>Who can see it</h2>
          <p>
            Only you. Access to your records requires your email and password. We do not
            sell, rent, or share your personal information or uploaded files with any third
            party. Petshots staff cannot view your documents.
          </p>
        </section>

        <section>
          <h2>What we don't do</h2>
          <ul>
            <li>No advertising or retargeting.</li>
            <li>No analytics tracking (no Google Analytics, Mixpanel, or similar).</li>
            <li>No third-party tracking pixels or ad network scripts.</li>
            <li>No selling or sharing of your data.</li>
          </ul>
        </section>

        <section>
          <h2>Cookies and local storage</h2>
          <p>
            We use browser localStorage to remember your session and which pet you last
            viewed. These are functional and strictly necessary — no advertising cookies
            are set.
          </p>
          <p>
            On the sign-up page, we use{' '}
            <a
              href="https://www.cloudflare.com/products/turnstile/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Cloudflare Turnstile
            </a>{' '}
            to prevent automated bot signups. Cloudflare may set its own cookies during
            this step; see{' '}
            <a
              href="https://www.cloudflare.com/privacypolicy/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Cloudflare's Privacy Policy
            </a>{' '}
            for details.
          </p>
        </section>

        <section>
          <h2>Amazon Associates</h2>
          <p>
            Product links in the footer of this site are Amazon Associates links. Petshots
            earns a small commission when you purchase through these links, at no extra
            cost to you. All affiliate links are labeled.
          </p>
        </section>

        <section>
          <h2>Data retention</h2>
          <p>
            Your data is kept for as long as your account exists. We don't automatically
            delete inactive accounts, so your pet's records remain available whenever you
            need them.
          </p>
        </section>

        <section>
          <h2>Deleting your account</h2>
          <p>
            To delete your account and all associated records, email{' '}
            <a href="mailto:mark.gingrass@gmail.com">mark.gingrass@gmail.com</a> with
            the subject <em>"Delete my Petshots account"</em>. We'll remove everything
            within 7 days and confirm by email.
          </p>
        </section>

        <section>
          <h2>Changes to this policy</h2>
          <p>
            We may update this policy as the product evolves. The date at the top of this
            page reflects the latest revision.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Questions? Email{' '}
            <a href="mailto:mark.gingrass@gmail.com">mark.gingrass@gmail.com</a>.
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
