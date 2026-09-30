import iphoneFrame from "../../assets/iphone-frame.png";
import "./style.css";

type PhoneFrameProps = {
  src: string;
  alt: string;
  className?: string;
};

/** The one device chrome every real screenshot on the page sits inside, so a phone looks like the same phone everywhere it appears. */
export function PhoneFrame({ src, alt, className }: PhoneFrameProps) {
  return (
    <div className={className ? `phone-frame ${className}` : "phone-frame"}>
      <div className="phone-screen">
        <img className="phone-screenshot" src={src} alt={alt} />
      </div>
      <img className="phone-frame-image" src={iphoneFrame} alt="" />
    </div>
  );
}
