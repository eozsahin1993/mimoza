import { ContactForm } from "../../components/contactForm";
import { Icon } from "../../components/Icon";
import { Wordmark } from "../../components/wordmark";
import { Footer } from "../../sections/footer";
import "../../styles/staticPage.css";

const SUPPORT_EMAIL = "hello@joinmimoza.com";

export function DeleteAccount() {
  return (
    <main>
      <nav className="policy-nav">
        <a href="/" aria-label="Mimoza home">
          <Wordmark />
        </a>
        <a className="back" href="/">
          <Icon name="arrow" size={17} /> Home
        </a>
      </nav>

      <article className="policy">
        <span className="kicker">Account</span>
        <h1 className="display policy-title">Delete your Mimoza account</h1>

        <div className="policy-lede">
          <p>
            You can delete your account yourself from the app in a few taps. If you no longer have the app, request
            it here and we'll do it for you.
          </p>
        </div>

        <h2 id="in-app">From the app</h2>
        <p>
          Open <strong>Account</strong> and tap <strong>Delete account</strong>. Deletion is immediate and can't be
          undone.
        </p>

        <h2 id="request">Without the app</h2>
        <p>
          Tell us the name you used in Mimoza and whether you signed in with Apple or Google. Mimoza holds no email
          address or phone number for you, so we'll reply to confirm the request is yours before acting on it, and
          explain how. We aim to complete deletion within 30 days of confirming.
        </p>
        <ContactForm
          topic="deletion"
          messagePlaceholder="The name you used in Mimoza, and whether you signed in with Apple or Google"
        />
        <br/>
        <p>
          You can also email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=Delete%20my%20Mimoza%20account`}>{SUPPORT_EMAIL}</a> with the
          subject "Delete my account".
        </p>

        <h2 id="what-is-deleted">What gets deleted</h2>
        <ul>
          <li>Every photo, caption, comment and reaction you posted, in every circle you are in.</li>
          <li>Your membership of every circle, along with any pending join requests.</li>
          <li>Any circle in which you were the last remaining member, together with everything in it.</li>
          <li>Your name, profile picture, public key, devices, notification tokens and sessions.</li>
          <li>The Sign in with Apple connection, if you used it.</li>
        </ul>

        <h2 id="what-remains">What remains</h2>
        <p>
          Each circle you were in keeps one activity line saying that you deleted your account, with the name you
          used, so the other members can see why your photos disappeared. Server logs that mention your account
          identifier are deleted after 90 days, and database backups age out within 35 days. Backups are only used
          to recover from a failure, never to restore something you deleted.
        </p>

        <p className="support-footnote">
          For everything else we hold and how long we keep it, see the <a href="/privacy/">privacy policy</a>.
        </p>
      </article>

      <Footer />
    </main>
  );
}
