import flowerIcon from "../../assets/flower-icon.png";
import { StoreBadge } from "../../components/storeBadge";
import { WaitlistForm } from "../../components/waitlistForm";
import { APP_IS_LIVE } from "../../config";
import "./style.css";

export function Closing() {
  return (
    <section className="closing" id="download">
      <div className="closing-flower">
        <img className="closing-icon" src={flowerIcon} alt="" />
      </div>
      <span className="kicker kicker-dark">Your people. Your moments.</span>
      <div className="display closing-title" role="heading" aria-level={2}>
        Keep the good bits
        <br />
        between us.
      </div>
      <p>{APP_IS_LIVE ? "Mimoza is available for iPhone and Android." : "Coming soon to iPhone and Android."}</p>
      {APP_IS_LIVE ? (
        <div className="store-row centered">
          <StoreBadge store="Apple" />
          <StoreBadge store="Google" />
        </div>
      ) : (
        <WaitlistForm centered />
      )}
      <div className="domain">joinmimoza.com</div>
    </section>
  );
}
