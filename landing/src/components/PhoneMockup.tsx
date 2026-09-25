import familyPhoto from "../assets/family.jpg";
import iphoneFrame from "../assets/iphone-frame.png";
import { Icon } from "./Icon";

function StatusBarIcons() {
  return (
    <div className="status-icons">
      <svg aria-hidden="true" viewBox="0 0 18 12" width="18" height="12">
        <rect x="0" y="7" width="3" height="5" rx="0.8" fill="currentColor" />
        <rect x="5" y="5" width="3" height="7" rx="0.8" fill="currentColor" />
        <rect x="10" y="3" width="3" height="9" rx="0.8" fill="currentColor" />
        <rect x="15" y="0" width="3" height="12" rx="0.8" fill="currentColor" />
      </svg>
      <svg aria-hidden="true" viewBox="0 0 16 12" width="16" height="12">
        <path
          d="M8 10.4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm-2.7-3a3.8 3.8 0 0 1 5.4 0 .6.6 0 0 0 .9-.9 5 5 0 0 0-7.2 0 .6.6 0 0 0 .9.9Zm-2.3-2.3a7 7 0 0 1 10 0 .6.6 0 0 0 .9-.9 8.3 8.3 0 0 0-11.8 0 .6.6 0 0 0 .9.9Z"
          fill="currentColor"
        />
      </svg>
      <svg aria-hidden="true" viewBox="0 0 25 12" width="25" height="12">
        <rect x="0.5" y="0.5" width="21" height="11" rx="2.5" stroke="currentColor" fill="none" />
        <rect x="2" y="2" width="16" height="8" rx="1.3" fill="currentColor" />
        <rect x="22.5" y="4" width="1.6" height="4" rx="0.8" fill="currentColor" />
      </svg>
    </div>
  );
}

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
      <div className="phone-frame">
        <div className="phone-screen">
          <div className="phone-top">
            <span>9:41</span>
            <StatusBarIcons />
          </div>
          <div className="app-header">
            <div>
              <span className="eyebrow">CIRCLE</span>
              <strong>The family</strong>
            </div>
            <div className="tiny-avatar">AK</div>
          </div>
          <div className="phone-scroll">
            <div className="feed-card">
              <div className="post-meta">
                <div className="tiny-avatar terracotta">N</div>
                <div>
                  <strong>Nora</strong>
                  <span>18 min ago</span>
                </div>
              </div>
              <img src={familyPhoto} alt="Grandfather holding his grandchild" />
              <div className="post-copy">
                <strong>Grandpa's new favorite reading buddy.</strong>
                <div className="reactions">
                  <span>♥ 4</span>
                  <span>🥹 3</span>
                  <span>🌼 2</span>
                </div>
                <div className="comment">
                  <strong>Mum</strong> This made my whole day.
                </div>
              </div>
            </div>
            <div className="activity-row">
              <span className="activity-icon">
                <Icon name="check" size={15} />
              </span>
              <span>
                <strong>Jane joined</strong> The family
              </span>
            </div>
            <div className="home-indicator" />
          </div>
        </div>
        <img className="phone-frame-image" src={iphoneFrame} alt="" />
      </div>
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
