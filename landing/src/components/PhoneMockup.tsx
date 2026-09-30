import feedShot from "../assets/screenshots/feed.jpg";
import crewPhotoOne from "../assets/hero-crew-1.jpg";
import crewPhotoTwo from "../assets/hero-crew-2.jpg";
import crewPhotoThree from "../assets/hero-crew-3.jpg";
import { Icon } from "./Icon";
import { PhoneFrame } from "./phoneFrame";

export function PhoneMockup() {
  return (
    <div className="phone-stage">
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="floating-note note-left">
        <div className="mini-avatars">
          <img className="avatar" src={crewPhotoOne} alt="" />
          <img className="avatar" src={crewPhotoTwo} alt="" />
          <img className="avatar" src={crewPhotoThree} alt="" />
        </div>
        <div className="floating-note-copy">
          <strong>Sunday crew</strong>
          <span>8 people</span>
        </div>
      </div>
      <PhoneFrame src={feedShot} alt="A family's holiday photo in their circle feed" />
      <div className="floating-note note-right">
        <span className="activity-icon ochre">
          <Icon name="lock" size={16} />
        </span>
        <div className="floating-note-copy">
          <strong>Only your circle</strong>
          <span>End-to-end encrypted</span>
        </div>
      </div>
    </div>
  );
}
