import appIcon from "../assets/app-icon.png";
import { Wordmark } from "../components/Wordmark";

export function Footer() {
  return (
    <footer>
      <a className="footer-brand" href="/" aria-label="Mimoza home">
        <img className="footer-icon" src={appIcon} alt="" />
        <Wordmark light />
      </a>
      <span className="footer-links">
        <a href="/privacy/">Privacy policy</a>
        <a href="mailto:hello@joinmimoza.com">Support</a>
      </span>
      <span>© 2026 Mimoza</span>
    </footer>
  );
}
