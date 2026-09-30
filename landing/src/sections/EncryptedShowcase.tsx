import createPostShot from "../assets/screenshots/create-post.jpg";
import { PhoneFrame } from "../components/phoneFrame";
import "../styles/phone-showcase.css";

export function EncryptedShowcase() {
  return (
    <section className="section phone-showcase">
      <PhoneFrame
        className="phone-frame-md"
        src={createPostShot}
        alt="Creating a post, with a note that 10 people can see it, nobody else"
      />
      <div className="phone-showcase-copy">
        <span className="kicker">Private by default</span>
        <div className="display phone-showcase-title" role="heading" aria-level={2}>
          End to end encrypted, just between you.
        </div>
        <p>
          Every photo, caption and comment is encrypted on your device before it's ever sent. The app tells you
          exactly who can see it, because that's the whole promise.
        </p>
      </div>
    </section>
  );
}
