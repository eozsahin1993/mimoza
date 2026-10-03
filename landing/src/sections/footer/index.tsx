import flowerIcon from "../../assets/flower-icon.svg";
import { Wordmark } from "../../components/wordmark";
import "./style.css";

export function Footer() {
  return (
    <footer>
      <a className="footer-brand" href="/" aria-label="Mimoza home">
        <img className="footer-icon" src={flowerIcon} alt="" />
        <Wordmark light />
      </a>
      <span className="footer-links">
        <a href="/privacy/">Privacy policy</a>
        <a href="/support/">Support</a>
      </span>
      <span>© 2026 RareKiwi Software LLC</span>
    </footer>
  );
}
