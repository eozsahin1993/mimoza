import { Icon } from "../components/Icon";
import { Wordmark } from "../components/Wordmark";

export function QuietFeatures() {
  return (
    <section className="quiet-features">
      <div className="feature-card notification-card">
        <span className="feature-icon">
          <Icon name="bell" size={23} />
        </span>
        <div className="feature-title" role="heading" aria-level={3}>
          A useful nudge, without the preview.
        </div>
        <p>
          Push notifications are composed server-side, so nothing private needs to be decrypted on your lock screen.
        </p>
        <div className="notification">
          <Wordmark />
          <div>
            <strong>New activity in The family</strong>
            <span>Open Mimoza to see what's new</span>
          </div>
          <small>now</small>
        </div>
      </div>
      <div className="feature-card reaction-card">
        <span className="feature-icon">
          <Icon name="link" size={23} />
        </span>
        <div className="feature-title" role="heading" aria-level={3}>
          More than a single like.
        </div>
        <p>Laugh, love, and tear up at the same photo. Everyone can leave more than one emoji reaction.</p>
        <div className="reaction-demo">
          <span>♥ 6</span>
          <span>🥹 4</span>
          <span>😂 2</span>
          <span>+ add yours</span>
        </div>
      </div>
    </section>
  );
}
