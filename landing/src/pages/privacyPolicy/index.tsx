import { Icon } from "../../components/Icon";
import { Wordmark } from "../../components/wordmark";
import { Footer } from "../../sections/footer";
import "./style.css";

const SUPPORT_EMAIL = "hello@joinmimoza.com";
const LAST_UPDATED = "30 September 2026";

const SECTIONS = [
  ["cannot-see", "What we cannot see"],
  ["collect", "What we do collect"],
  ["do-not", "What we do not do"],
  ["waitlist", "The launch waitlist"],
  ["third-parties", "Who else handles your data"],
  ["permissions", "Device permissions"],
  ["keys", "Your keys"],
  ["where", "Where your data is stored"],
  ["retention", "How long we keep data"],
  ["delete-account", "Deleting your account"],
  ["children", "Children"],
  ["rights", "Your rights"],
  ["changes", "Changes to this policy"],
  ["contact", "Contact"],
] as const;

export function PrivacyPolicy() {
  return (
    <main>
      <nav className="policy-nav">
        <a href="/" aria-label="Mimoza home">
          <Wordmark />
        </a>
        <a className="back" href="/">
          <Icon name="arrow" size={17} /> joinmimoza.com
        </a>
      </nav>

      <article className="policy">
        <span className="kicker">Privacy Policy</span>
        <h1 className="display policy-title">Mimoza Privacy Policy</h1>
        <p className="policy-meta">
          Last updated {LAST_UPDATED}. Applies to the Mimoza app for iPhone and Android and to joinmimoza.com.
        </p>

        <div className="policy-lede">
          <p>
            Mimoza is end-to-end encrypted. Your photos, captions, comments, reactions, cover photos and profile
            pictures are encrypted on your device with keys that only the members of your circle hold. Our servers
            store and deliver them, but cannot read them.
          </p>
          <p>
            This page says what we can see, why we need it, who else touches it, and how to delete it. We never sell
            your information and we never use it for advertising.
          </p>
        </div>

        <nav className="policy-toc" aria-label="Contents">
          <strong>Contents</strong>
          <ol>
            {SECTIONS.map(([id, title]) => (
              <li key={id}>
                <a href={`#${id}`}>{title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <h2 id="cannot-see">What we cannot see</h2>
        <p>
          Every circle has its own content key. It is generated on a member's device and shared with the other members
          by encrypting it to each member's personal key. Mimoza never holds a copy. Anything encrypted with that key
          is unreadable to us and to anyone who is not in the circle:
        </p>
        <ul>
          <li>Photos and the captions on them</li>
          <li>Comments</li>
          <li>Reactions, including which emoji you chose</li>
          <li>Circle cover photos</li>
          <li>Profile pictures</li>
        </ul>
        <p>
          We can count reactions and comments on a post, and we can tell that you reacted, but not with what. There
          is no server-side copy of any key and no recovery phrase.
        </p>
        <div className="callout">
          <span className="honesty-mark">i</span>
          <p>
            <strong>Plainly stated:</strong> this protects your content, not all metadata. Like most encrypted
            messengers, we can see who is in a circle and when things happened. We cannot see what was shared. Mimoza
            does not yet offer a way to verify another member's key in person, so you are trusting our server to hand
            out the right public keys. We say so rather than imply otherwise.
          </p>
        </div>

        <h2 id="collect">What we do collect</h2>
        <p>
          Everything below is collected because the app cannot work without it. Nothing is collected for analytics or
          marketing.
        </p>
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>What it is and why we need it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Sign-in identifier</td>
              <td>
                The account identifier that Sign in with Apple or Google Sign-In gives us, so you can sign back in.
                The sign-in token Apple or Google sends includes your email address. We read the identifier from it
                and do not keep the email. Mimoza never stores an email address or phone number.
              </td>
            </tr>
            <tr>
              <td>Name</td>
              <td>
                The name you choose in the app. It is stored unencrypted so we can show it to the members of your
                circles and use it in notifications ("Alex posted a photo").
              </td>
            </tr>
            <tr>
              <td>Public key</td>
              <td>
                The public half of the encryption keypair your device generates. Other members use it to share circle
                keys with you. The private half never leaves your devices.
              </td>
            </tr>
            <tr>
              <td>Circles and membership</td>
              <td>
                Each circle's name, who is in it, who is an admin, when people joined or left, invite codes, and
                pending join requests (a name and a public key). The app also writes a short activity line for events
                such as "Jane joined" or "Alex changed the cover".
              </td>
            </tr>
            <tr>
              <td>Post and comment metadata</td>
              <td>
                Who posted or commented, in which circle, and when. Counts of comments and reactions. Whether you
                have reacted to or commented on a post. The content itself is encrypted.
              </td>
            </tr>
            <tr>
              <td>Encrypted content</td>
              <td>
                The encrypted bytes of photos, captions, comments, reactions, covers and profile pictures, stored so
                they can be delivered to the other members. We cannot decrypt them.
              </td>
            </tr>
            <tr>
              <td>Device and notifications</td>
              <td>
                For each device you sign in on: a push notification token, whether it is iOS or Android, and the
                language you chose for the app, so notifications arrive in that language. Only if you turn notifications on.
              </td>
            </tr>
            <tr>
              <td>Sign in with Apple grant</td>
              <td>
                If you sign in with Apple, we keep the refresh token Apple issues so that deleting your Mimoza account
                also revokes the Sign in with Apple connection, as Apple requires.
              </td>
            </tr>
            <tr>
              <td>Session tokens</td>
              <td>A random token per signed-in device that keeps you signed in for up to 90 days.</td>
            </tr>
            <tr>
              <td>Server logs</td>
              <td>
                Our server logs each request's kind, outcome and duration, and details of anything that fails, which
                can include your account identifier. Logs are deleted after 90 days. We do not log your IP address
                ourselves. The hosting provider sees it as any host does.
              </td>
            </tr>
            <tr>
              <td>App analytics</td>
              <td>
                Anonymous usage analytics: which screens you view and actions like posting or reacting. We never
                track what you write, post, or view.
              </td>
            </tr>
          </tbody>
        </table>

        <h2 id="do-not">What we do not do</h2>
        <ul>
          <li>No advertising, and no advertising identifiers.</li>
          <li>No selling, renting or trading of your information, ever.</li>
          <li>No uploading of your contacts. Inviting someone is a link you share yourself.</li>
          <li>No location data. The app never asks for your location and does not read location tags from photos.</li>
          <li>No access to your camera roll beyond the photos you pick to share.</li>
        </ul>

        <h2 id="waitlist">The launch waitlist</h2>
        <p>
          The one exception to "no email address, ever" above: if you enter your email on joinmimoza.com to be
          notified when Mimoza launches, that address is stored with Resend, the email service we use to send that
          one announcement. It is not linked to any Mimoza account — signing up for the waitlist before launch and
          creating an account afterward are two separate things, and we do not connect them.
        </p>
        <p>
          We use it for nothing but the launch announcement. Every email carries an unsubscribe link, and asking us
          at {SUPPORT_EMAIL} removes you immediately. Once Mimoza is available on both stores, this list and the form
          that feeds it go away.
        </p>

        <h2 id="third-parties">Who else handles your data</h2>
        <p>
          We do not share your data with anyone except the providers below, each of which processes only what is
          needed to deliver its part of the service. Your content stays encrypted through all of them.
        </p>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>What for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Amazon Web Services</td>
              <td>
                Hosts the Mimoza server, database and encrypted file storage, and delivers files through its content
                network. Data is stored in the United States (us-east-1).
              </td>
            </tr>
            <tr>
              <td>Apple</td>
              <td>
                Sign in with Apple, and the Apple Push Notification service that carries notifications to iPhones.
                Notification text is composed by our server from the sender's name, the circle's name and the kind of
                activity, for example "Mum commented on your photo". It never contains a photo, caption or comment.
              </td>
            </tr>
            <tr>
              <td>Google</td>
              <td>
                Google Sign-In, and Firebase Cloud Messaging, which carries the same notifications to Android
                devices.
              </td>
            </tr>
            <tr>
              <td>Expo</td>
              <td>
                When the app opens it asks Expo's update service whether a newer version of the app's code is
                available. That request carries the app version and platform, and Expo sees your IP address as any
                web server does. It carries nothing about your account or circles.
              </td>
            </tr>
            <tr>
              <td>Resend</td>
              <td>
                Holds the launch waitlist's email addresses and sends the single launch announcement — see "The
                launch waitlist" above. Not used for anything to do with the app itself.
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Each of these providers is bound by its own privacy terms and by our agreements with it to protect your data
          at least as well as this policy describes. We may also disclose information if the law requires it, or to
          protect the safety of our users. Since content is end-to-end encrypted, we could not hand over photos,
          captions or comments even if asked.
        </p>

        <h2 id="permissions">Device permissions</h2>
        <p>Mimoza asks for each of these only at the moment it is needed, and the app works if you say no.</p>
        <ul>
          <li>
            <strong>Photos.</strong> To pick the photos you want to share. Only the photos you choose leave your
            device, and they are encrypted first.
          </li>
          <li>
            <strong>Camera.</strong> To scan the transfer code shown on another of your devices when you move your
            account to a new phone. Camera frames are not stored or sent anywhere.
          </li>
          <li>
            <strong>Notifications.</strong> To tell you when someone posts, comments, reacts or joins. Off by
            default.
          </li>
        </ul>

        <h2 id="keys">Your keys</h2>
        <p>
          Your private key is generated on your device and kept in the system keychain (iOS Keychain or Android
          Keystore). To let a new phone open your circles, the key is also backed up through the platform's own
          end-to-end encrypted sync: iCloud Keychain on iOS and Google Block Store on Android. Apple and Google cannot
          read it, and neither can we. You can also move an account between two devices directly by scanning a code.
        </p>
        <p>
          If you lose every device, there is no recovery phrase and we cannot restore your keys. A new device
          publishes a fresh key, and the next member of each circle to open the app shares that circle's keys with it
          again.
        </p>

        <h2 id="where">Where your data is stored</h2>
        <p>
          Our server and storage run on Amazon Web Services in the United States. If you live elsewhere, your data is
          transferred there to provide the service. Content is encrypted before it leaves your device; the rest is
          protected in transit with TLS and at rest with the provider's encryption.
        </p>

        <h2 id="retention">How long we keep data</h2>
        <ul>
          <li>
            <strong>While your account exists,</strong> we keep what is listed above for as long as it is needed to
            run your circles.
          </li>
          <li>
            <strong>Deleting a photo or comment</strong> removes it for everyone in the circle. The encrypted file is
            deleted from storage and cleared from the content network. Download links already issued expire within
            an hour.
          </li>
          <li>
            <strong>Leaving a circle</strong> removes your membership and your profile picture from that circle, and
            the circle's key is rotated so you cannot read anything posted afterwards. Photos and comments you
            posted stay with the circle, like a print you handed someone. Delete them first if you do not want that.
          </li>
          <li>
            <strong>Invite codes and join requests</strong> expire on their own.
          </li>
          <li>
            <strong>Session tokens</strong> expire after 90 days, or immediately when you sign out.
          </li>
          <li>
            <strong>Server logs</strong> are deleted after 90 days.
          </li>
          <li>
            <strong>Database backups</strong> can hold a copy of deleted records for up to 35 days before they age
            out. Backups are only used to recover from a failure, never to restore something you deleted.
          </li>
        </ul>

        <h2 id="delete-account">Deleting your account</h2>
        <p>
          In the app, open <strong>Account</strong> and tap <strong>Delete account</strong>. This is immediate and
          cannot be undone. It:
        </p>
        <ul>
          <li>Deletes every photo, caption, comment and reaction you posted, in every circle you are in.</li>
          <li>Removes you from every circle, along with your profile picture and any pending join requests.</li>
          <li>
            Deletes any circle in which you were the last remaining member, together with everything in it.
          </li>
          <li>Deletes your name, public key, devices, notification tokens and sessions.</li>
          <li>Revokes the Sign in with Apple connection, if you used it.</li>
        </ul>
        <p>
          What remains: each circle you were in keeps one activity line saying that you deleted your account, with the
          name you used, so the other members can see why your photos disappeared. Log entries and backups that
          mention your account identifier age out on the schedule above.
        </p>
        <p>
          <strong>If you can no longer use the app,</strong> email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=Delete%20my%20Mimoza%20account`}>{SUPPORT_EMAIL}</a> with the
          subject "Delete my account". Because we hold no email address or phone number for you, we will need to
          confirm the request is yours before acting on it, and we will explain how in our reply. We aim to complete
          deletion within 30 days of confirming.
        </p>

        <h2 id="children">Children</h2>
        <p>
          Mimoza is not directed at children under 13, and you must be at least 13, or older where your country
          requires it, to create an account. We do not knowingly collect data from children. If you believe a child
          has created an account, contact us and we will delete it.
        </p>

        <h2 id="rights">Your rights</h2>
        <p>
          Everything we hold about you is visible in the app: your name, your circles and the people in them, and
          what you have posted. You can change your name at any time, leave any circle, delete anything you posted,
          and delete your account, all from the app and without asking us.
        </p>
        <p>
          Depending on where you live, including the European Economic Area, the United Kingdom, Switzerland and
          Türkiye, you may also have the legal right to access, correct, export or erase your personal data, to object
          to or restrict its processing, and to complain to your local data protection authority. Email us to exercise
          any of these, and we will respond within 30 days.
        </p>
        <p>
          Where the GDPR applies, we process the data listed above because it is necessary to provide the service you
          asked for (Article 6(1)(b)); notifications and access to your photos and camera are based on your consent,
          which you can withdraw in your device settings (Article 6(1)(a)); and server logs are kept on the basis of our
          legitimate interest in keeping the service secure and working (Article 6(1)(f)).
        </p>

        <h2 id="changes">Changes to this policy</h2>
        <p>
          When this policy changes, the new version is published here with a new date at the top. If a change affects
          what we collect or how we use it, we will also tell you in the app before it takes effect.
        </p>

        <h2 id="contact">Contact</h2>
        <p>
          Mimoza is published by its developer under the name "Mimoza" on the App Store and Google Play. For any
          question about this policy or your data, including deletion requests, email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </article>

      <Footer />
    </main>
  );
}
