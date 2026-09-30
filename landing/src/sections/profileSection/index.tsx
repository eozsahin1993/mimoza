import profilePhoto from "../../assets/profile-amelia.jpg";
import { Icon } from "../../components/Icon";
import "./style.css";

export function ProfileSection() {
  return (
    <section className="profile-section">
      <div className="profile-copy">
        <span className="kicker">Less to collect. Less to worry about.</span>
        <div className="display profile-title" role="heading" aria-level={2}>
          Just a full name. A picture, if you want one.
        </div>
        <p>
          Sign in is just Google or Apple, so you skip the password, the username, the bio, all of it. We only read
          the identifier they hand over. Your email address is never stored.
        </p>
        <div className="continuity-row">
          <span className="continuity-icon">
            <Icon name="cloud" size={22} />
          </span>
          <div>
            <strong>Your account follows you</strong>
            <span>
              The account key syncs invisibly with iCloud Keychain or Google Block Store. No password or recovery
              phrase to lose.
            </span>
          </div>
        </div>
      </div>
      <div className="profile-card-wrap">
        <div className="profile-card">
          <div className="profile-card-head">
            <span>YOUR PROFILE</span>
            <strong>That was quick.</strong>
          </div>
          <img className="profile-picture" src={profilePhoto} alt="" />
          <div className="profile-field">
            <span>NAME</span>
            <strong>Amelia Moore</strong>
            <Icon name="check" size={18} />
          </div>
          <div className="profile-done">
            <Icon name="check" size={17} /> Profile complete
          </div>
        </div>
        <div className="nothing-else">
          No email
          <br />
          No phone
          <br />
          No bio
          <br />
          No username
        </div>
      </div>
    </section>
  );
}
