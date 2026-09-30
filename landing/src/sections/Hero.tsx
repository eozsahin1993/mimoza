import { Icon } from "../components/Icon";
import { StoreBadge } from "../components/StoreBadge";
import { WaitlistForm } from "../components/WaitlistForm";
import { PhoneMockup } from "../components/PhoneMockup";
import { APP_IS_LIVE } from "../config";

export function Hero() {
  return (
    <section className="hero">
      <div className="hero-copy">
        <span className="kicker">Made for your favorite people</span>
        <div className="display hero-title" role="heading" aria-level={1}>
          Private circles
          <br />
          for your photos.
        </div>
        <p className="hero-lede">
          Small circles, one shared feed. End-to-end encrypted, so only your circle can ever see what you share.
        </p>
        {APP_IS_LIVE ? (
          <div className="store-row">
            <StoreBadge store="Apple" />
            <StoreBadge store="Google" />
          </div>
        ) : (
          <WaitlistForm />
        )}
        <div className="hero-note">
          <Icon name="lock" size={16} /> Photos, captions, comments, and reactions stay private.
        </div>
      </div>
      <PhoneMockup />
    </section>
  );
}
