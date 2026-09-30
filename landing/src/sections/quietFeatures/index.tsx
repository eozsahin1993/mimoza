import { Icon } from "../../components/Icon";
import "./style.css";

export function QuietFeatures() {
  return (
    <section className="quiet-features">
      <div className="feature-card feed-end-card">
        <span className="feature-icon">
          <Icon name="check" size={23} />
        </span>
        <div className="feature-title" role="heading" aria-level={3}>
          Caught up means caught up.
        </div>
        <p>
          No algorithm stretches the feed to keep you scrolling. Once you've seen what your circle shared, that's
          it, until someone posts again.
        </p>
        <div className="feed-end-demo">
          <div className="feed-end-row" />
          <div className="feed-end-row" />
          <div className="feed-end-caughtup">
            <span className="feed-end-check">
              <Icon name="check" size={14} />
            </span>
            <span>You're all caught up</span>
          </div>
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
