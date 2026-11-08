import { Icon } from "../../components/Icon";
import { Wordmark } from "../../components/wordmark";
import { Footer } from "../../sections/footer";
import "../../styles/staticPage.css";

const SUPPORT_EMAIL = "hello@joinmimoza.com";
const LAST_UPDATED = "7 November 2026";

export function Terms() {
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
        <span className="kicker">Terms of Use</span>
        <h1 className="display policy-title">Mimoza Terms of Use</h1>
        <p className="policy-meta">
          Last updated {LAST_UPDATED}. Applies to the Mimoza app for iPhone and Android and to joinmimoza.com.
        </p>

        <div className="policy-lede">
          <p>
            Mimoza is made by RareKiwi Software LLC. By creating an account or using the app you agree to these
            terms. They are short on purpose: Mimoza is for sharing photos with people you know, and the rules are
            the ones you'd expect among them.
          </p>
        </div>

        <h2 id="who">Who can use Mimoza</h2>
        <p>
          You must be at least 13, or older where your country requires it, to create an account. You sign in with
          Apple or Google and are responsible for keeping that sign-in and your devices secure. One person, one
          account.
        </p>

        <h2 id="not-allowed">What you may not share</h2>
        <p>
          Anything you post goes to the members of a circle you chose, and only to them. Even so, the following is
          not allowed anywhere in Mimoza, whether as a photo, caption, comment, reaction, name, profile picture or
          circle cover:
        </p>
        <ul>
          <li>Sexual content involving minors, or anything that sexualises a minor. We report this to the authorities.</li>
          <li>Non-consensual intimate images, or images of someone taken or shared without their consent where they
            had a reasonable expectation of privacy.
          </li>
          <li>Content that harasses, bullies, threatens or incites violence against a person or group.</li>
          <li>Hate speech, or content that dehumanises people for who they are.</li>
          <li>Content that is illegal where you or the recipient live, or that infringes someone else's rights.</li>
          <li>Spam, scams, malware, or using a circle to run or promote any of these.</li>
          <li>Impersonating another person, or pretending to be someone you're not to gain access to a circle.</li>
        </ul>
        <p>
          Only share photos of other people with their knowledge. If someone asks you to delete a photo of them, do
          it.
        </p>

        <h2 id="reports">Reports and removal</h2>
        <p>
          Every photo has a <strong>Report this photo</strong> option in its menu, and every circle lets an admin
          remove a post or a member. Reports reach a person at Mimoza. Because content is end-to-end encrypted we
          cannot look at what you report, so a report tells us which entry and which circle, and the reporter tells
          us why. We act on what we're told: we can remove the entry, remove the account that posted it from every
          circle, or delete that account. For the categories above we do this without warning. Where the law requires
          it, we also report to the relevant authority.
        </p>

        <h2 id="your-content">Your content</h2>
        <p>
          What you post stays yours. You give us only what we need to deliver it: storing the encrypted file and
          passing it to the members of the circle. We cannot read it and we never use it for anything else. Leaving
          a circle does not remove what you already posted there, so delete it first if you don't want it to stay.
        </p>

        <h2 id="the-service">The service</h2>
        <p>
          Mimoza is provided as is. We work to keep it reliable, but we don't promise it will always be available or
          free of faults, and we are not liable for loss of photos or data beyond what the law requires. Keep copies
          of anything you can't afford to lose. There is no recovery phrase: if you lose every device without the
          platform backup described in the <a href="/privacy/#keys">privacy policy</a>, we cannot restore your keys.
        </p>
        <p>
          We may suspend or delete an account that breaks these terms. You can delete your own account at any time
          from the app, or <a href="/delete-account/">request it here</a>.
        </p>

        <h2 id="changes">Changes</h2>
        <p>
          If we change these terms in a way that matters, we'll say so in the app before the change takes effect.
          Continuing to use Mimoza after that means you accept the new terms.
        </p>

        <h2 id="contact">Contact</h2>
        <p>
          Questions about these terms go to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, or use the
          form on the <a href="/support/">support page</a>. These terms are governed by the laws of the State of
          Georgia, United States.
        </p>

        <p className="support-footnote">
          For what we collect and how long we keep it, see the <a href="/privacy/">privacy policy</a>.
        </p>
      </article>

      <Footer />
    </main>
  );
}
