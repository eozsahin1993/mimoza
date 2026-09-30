import appIcon from "../assets/app-icon.png";
import { StoreBadge } from "../components/StoreBadge";
import { WaitlistForm } from "../components/WaitlistForm";
import { APP_IS_LIVE } from "../config";

export function Closing() {
  return (
    <section className="closing" id="download">
      <div className="closing-flower">
        <img className="closing-icon" src={appIcon} alt="" />
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
