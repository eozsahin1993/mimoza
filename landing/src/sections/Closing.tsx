import { Flower } from "../components/Flower";
import { StoreBadge } from "../components/StoreBadge";

export function Closing() {
  return (
    <section className="closing" id="download">
      <div className="closing-flower">
        <Flower light />
      </div>
      <span className="kicker kicker-dark">Your people. Your moments.</span>
      <div className="display closing-title" role="heading" aria-level={2}>
        Keep the good bits
        <br />
        between us.
      </div>
      <p>Mimoza is available for iPhone and Android.</p>
      <div className="store-row centered">
        <StoreBadge store="Apple" />
        <StoreBadge store="Google" />
      </div>
      <div className="domain">joinmimoza.com</div>
    </section>
  );
}
