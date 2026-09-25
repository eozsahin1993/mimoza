import { Icon } from "../components/Icon";

export function PrivacySection() {
  return (
    <section className="privacy-section" id="privacy">
      <div className="privacy-copy">
        <span className="kicker kicker-dark">Private where it matters</span>
        <div className="display privacy-title" role="heading" aria-level={2}>
          The relay can deliver it.
          <br />
          It cannot read it.
        </div>
        <p>
          Photos, captions, comments, and reactions are end-to-end encrypted on your device. Mimoza's relay server
          only passes along locked packages. It never gets the key.
        </p>
        <div className="honesty-note">
          <span className="honesty-mark">i</span>
          <div>
            <strong>Privacy, plainly stated.</strong>
            <p>
              Like WhatsApp, this protects your content—not all metadata. The server can know who is in a circle and
              when activity happened. It cannot see what was shared.
            </p>
          </div>
        </div>
      </div>
      <div className="encryption-visual">
        <div className="person-node person-one">
          <div className="avatar photo-avatar">A</div>
          <span>Alex</span>
        </div>
        <div className="person-node person-two">
          <div className="avatar photo-avatar second">M</div>
          <span>Mum</span>
        </div>
        <div className="person-node person-three">
          <div className="avatar photo-avatar third">J</div>
          <span>Jane</span>
        </div>
        <div className="connection c-one" />
        <div className="connection c-two" />
        <div className="connection c-three" />
        <div className="lock-core">
          <Icon name="lock" size={34} />
          <strong>Your circle</strong>
          <span>Keys stay on devices</span>
        </div>
        <div className="encrypted-chip">
          <span>◫</span> ENCRYPTED CONTENT
        </div>
      </div>
    </section>
  );
}
