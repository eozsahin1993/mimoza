import { ContactForm } from "../../components/contactForm";
import { Icon } from "../../components/Icon";
import { Wordmark } from "../../components/wordmark";
import { Footer } from "../../sections/footer";
import "../../styles/staticPage.css";

const SUPPORT_EMAIL = "hello@joinmimoza.com";

export function Support() {
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
        <span className="kicker">Support</span>
        <h1 className="display policy-title">Mimoza Support</h1>

        <div className="policy-lede">
          <p>
            Mimoza is a private, end-to-end encrypted way to share photos with a small circle of people. This page
            is how to reach us, how a few things in the app work, and where to go to delete your account.
          </p>
        </div>

        <h2 id="contact">Contact us</h2>
        <p>Send us a message for help with the app, to report a problem, or to send feedback. A person reads every one.</p>
        <ContactForm />

        <h2 id="faq">Frequently asked questions</h2>

        <details>
          <summary>How do invites work?</summary>
          <p>
            Anyone in a circle can create an invite link and share it by text, email, whatever's easiest. Opening
            the link lets someone ask to join, and an admin of the circle approves or denies the request before
            they can see anything in it. An admin can revoke a link at any time, and links expire on their own
            after a while if nobody uses them.
          </p>
        </details>

        <details>
          <summary>What happens if I leave a circle?</summary>
          <p>
            Open the circle, tap the menu in the top right, and choose <strong>Leave</strong>. If you're the only
            admin, you'll be asked to make someone else an admin first, and if you're the only member left, the
            circle is deleted entirely. You lose access to anything posted after you leave, since the circle's key
            changes. Photos and comments you already posted stay with the circle, like a print you handed someone.
            Delete them first if you don't want that.
          </p>
        </details>

        <details>
          <summary>Can I delete a photo I posted?</summary>
          <p>
            Yes. Open the photo, tap the menu, and choose <strong>Delete</strong>. Only the person who posted it, or
            a circle admin, can do this. It's removed for everyone in the circle, right away, and can't be
            recovered.
          </p>
        </details>

        <details>
          <summary>How does account recovery work?</summary>
          <p>
            Your encryption key lives in your phone's own keychain, and is backed up through iCloud Keychain on
            iPhone or Google Block Store on Android, the same end-to-end encrypted systems those platforms use for
            passwords. Signing in on a new phone with the same Apple or Google account restores it automatically.
            You can also move an account directly between two devices by scanning a code, without waiting on that
            backup. There's no recovery phrase, though: if you lose access to every device without either of those,
            there's no way for us to restore your keys. See <a href="/privacy/#keys">the privacy policy</a> for the
            full explanation.
          </p>
        </details>

        <details>
          <summary>How do I delete my account?</summary>
          <p>
            In the app, open <strong>Account</strong> and tap <strong>Delete account</strong>. It's immediate and
            can't be undone. If you no longer have access to the app, email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}?subject=Delete%20my%20Mimoza%20account`}>{SUPPORT_EMAIL}</a> with the
            subject "Delete my account" and we'll take care of it. The full details of what gets deleted are in{" "}
            <a href="/privacy/#delete-account">the privacy policy</a>.
          </p>
        </details>

        <details>
          <summary>What's end-to-end encrypted, and how?</summary>
          <p>
            Photos, captions, comments, reactions, and circle cover photos. Each circle has its own key, generated
            on a member's device, and that key encrypts all of that circle's content with XChaCha20-Poly1305. When
            someone joins, the key is sealed to their own public key using X25519 key exchange, so it's never
            visible to us along the way. All of this runs on the open-source noble cryptography libraries rather
            than anything we wrote ourselves. See <a href="/privacy/#can't-see">the privacy policy</a> for what that
            does and doesn't cover.
          </p>
        </details>

        <p className="support-footnote">
          For more on what Mimoza can and can't see, and what we collect, see the{" "}
          <a href="/privacy/">privacy policy</a>.
        </p>
      </article>

      <Footer />
    </main>
  );
}
