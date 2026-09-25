import familyPhoto from "../assets/family.jpg";
import friendsPhoto from "../assets/friends.jpg";
import kitchenPhoto from "../assets/kitchen.jpg";
import { Icon } from "../components/Icon";

const steps = [
  {
    number: "01",
    title: "Start your circle",
    copy: "Name it for the people it belongs to—your family, cousins, or the friends who feel like family.",
  },
  {
    number: "02",
    title: "Invite your people",
    copy: "Share a private link or code. New members join after an admin gives the okay.",
  },
  {
    number: "03",
    title: "Share the everyday",
    copy: "Photos, captions, comments, and more than one reaction. No audience beyond the circle.",
  },
  {
    number: "04",
    title: "Find it all again",
    copy: "Every circle has its own album, so the good bits don't disappear down an endless feed.",
  },
];

export function CircleWalkthrough() {
  return (
    <section className="section walkthrough" id="circles">
      <div className="section-intro">
        <span className="kicker">A shared space, kept small</span>
        <div className="display section-title" role="heading" aria-level={2}>
          How circles work
        </div>
        <p>
          One place for the people who would already be in the group chat—only calmer, easier to look back on, and
          made for photos.
        </p>
      </div>
      <div className="steps-layout">
        <div className="steps-list">
          {steps.map((step) => (
            <div className="step" key={step.number}>
              <span className="step-number">{step.number}</span>
              <div>
                <div className="step-title" role="heading" aria-level={3}>
                  {step.title}
                </div>
                <p>{step.copy}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="album-visual">
          <div className="album-top">
            <div>
              <span className="eyebrow">THE FAMILY</span>
              <strong>Our album</strong>
            </div>
            <span className="album-count">126 moments</span>
          </div>
          <div className="album-grid">
            <img className="album-tall" src={kitchenPhoto} alt="Grandparent cooking with grandchildren" />
            <img src={familyPhoto} alt="Grandfather and grandchild together" />
            <div className="album-quote">
              <span>“Same time next Sunday?”</span>
              <small>— Nina</small>
            </div>
            <img className="album-wide" src={friendsPhoto} alt="Friends relaxing together at home" />
          </div>
          <div className="roster-event">
            <div className="tiny-avatar">J</div>
            <div>
              <strong>Jane joined the circle</strong>
              <span>Welcomed by Alex · Today</span>
            </div>
            <span className="event-check">
              <Icon name="check" size={16} />
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
