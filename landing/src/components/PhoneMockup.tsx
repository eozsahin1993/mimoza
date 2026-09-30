import feedShot from "../assets/screenshots/feed.jpg";
import { Icon } from "./Icon";
import { PhoneFrame } from "./PhoneFrame";

export function PhoneMockup() {
  return (
    <div className="phone-stage">
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="floating-note note-left">
        <div className="mini-avatars">
          <span className="avatar avatar-one">M</span>
          <span className="avatar avatar-two">J</span>
          <span className="avatar avatar-three">A</span>
        </div>
        <div>
          <strong>Sunday crew</strong>
          <span>8 people</span>
        </div>
      </div>
      <PhoneFrame src={feedShot} alt="A family's holiday photo in their circle feed" />
      <div className="floating-note note-right">
        <span className="activity-icon ochre">
          <Icon name="lock" size={16} />
        </span>
        <div>
          <strong>Only your circle</strong>
          <span>End-to-end encrypted</span>
        </div>
      </div>
    </div>
  );
}
