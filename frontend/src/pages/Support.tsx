import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';

// Public support page — the "Support URL" required by App Store Connect.
export function Support() {
  return (
    <>
      <SiteHeader />
      <main className="page privacy">
        <h1>Support</h1>
        <p className="subtle">Help with Petshots on the web and iOS</p>

        <section>
          <h2>Contact us</h2>
          <p>
            Email{' '}
            <a href="mailto:mark.gingrass@gmail.com?subject=Petshots%20Support">
              mark.gingrass@gmail.com
            </a>{' '}
            and we'll get back to you within one business day. Include the email address
            on your Petshots account so we can find it quickly.
          </p>
        </section>

        <section>
          <h2>Common questions</h2>
          <ul>
            <li>
              <strong>I forgot my password.</strong> Use the "Forgot your password?" link
              on the login screen — we'll email you a reset code.
            </li>
            <li>
              <strong>I'm not getting reminder emails.</strong> Check Settings → make sure
              reminders are on and email isn't paused. Reminders send once a day around
              5&nbsp;AM Eastern when something is due.
            </li>
            <li>
              <strong>How do I share my pet's records?</strong> Open your pet → Passport
              tab → create a link. Anyone with the link (or QR code) can view records —
              no account needed. You can revoke it any time.
            </li>
            <li>
              <strong>How do I add a family member?</strong> Settings → Family → enter
              their email or create an invite link. They see and can update the same pets.
            </li>
            <li>
              <strong>How do I cancel my subscription or delete my account?</strong>{' '}
              Manage billing from Settings on the web at petshots.app. Delete your account
              under Settings → Danger zone — it's immediate and also cancels any
              subscription.
            </li>
          </ul>
        </section>

        <section>
          <h2>More</h2>
          <p>
            See what we're building on the <a href="/roadmap">public roadmap</a>, or read
            the <a href="/privacy">privacy policy</a>.
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
