import postDetailShot from "../assets/screenshots/post-detail.jpg";
import { PhoneFrame } from "../components/phoneFrame";
import "../styles/phone-showcase.css";

export function ConversationShowcase() {
  return (
    <section className="section phone-showcase">
      <PhoneFrame className="phone-frame-md" src={postDetailShot} alt="A post with reactions and comments from the circle" />
      <div className="phone-showcase-copy">
        <span className="kicker">Not just a like</span>
        <div className="display phone-showcase-title" role="heading" aria-level={2}>
          Every photo starts a conversation.
        </div>
        <p>More than one reaction, and comments that actually get read, because it's ten people, not ten thousand.</p>
      </div>
    </section>
  );
}
