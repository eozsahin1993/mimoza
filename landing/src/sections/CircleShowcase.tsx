import circlesShot from "../assets/screenshots/circles.jpg";
import { PhoneFrame } from "../components/PhoneFrame";

export function CircleShowcase() {
  return (
    <section className="section phone-showcase">
      <PhoneFrame className="phone-frame-md" src={circlesShot} alt="The circle list, showing The Mitchells, Weekend Hikers, and more" />
      <div className="phone-showcase-copy">
        <span className="kicker">Every part of your life</span>
        <div className="display phone-showcase-title" role="heading" aria-level={2}>
          A circle for every part of your life.
        </div>
        <p>The family, the cousins, the hiking group, the regulars at your table—each one gets its own circle.</p>
      </div>
    </section>
  );
}
