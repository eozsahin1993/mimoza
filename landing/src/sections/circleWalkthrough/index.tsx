import inviteShot from "../../assets/screenshots/invite.jpg";
import albumShot from "../../assets/screenshots/album.jpg";
import { PhoneFrame } from "../../components/phoneFrame";
import "./style.css";

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
        <div className="flow-visual">
          <PhoneFrame
            className="phone-frame-sm flow-phone-one"
            src={inviteShot}
            alt="Circle details, with invite options and the member list"
          />
          <PhoneFrame className="phone-frame-sm flow-phone-two" src={albumShot} alt="A circle's album, grouped by month" />
        </div>
      </div>
    </section>
  );
}
