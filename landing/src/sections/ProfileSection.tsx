import { Icon } from "../components/Icon";

export function ProfileSection() {
  return (
    <section className="profile-section">
      <div className="profile-card-wrap">
        <div className="profile-card">
          <div className="profile-card-head">
            <span>YOUR PROFILE</span>
            <strong>That was quick.</strong>
          </div>
          <div className="profile-picture">AM</div>
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
      <div className="profile-copy">
        <span className="kicker">Less to collect. Less to worry about.</span>
        <div className="display profile-title" role="heading" aria-level={2}>
          A name and a picture. That is the whole profile.
        </div>
        <p>
          No username to claim. No bio to fill. No email address or phone number required for your profile. There is
          nothing else to collect.
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
    </section>
  );
}
