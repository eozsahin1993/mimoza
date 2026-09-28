import { Wordmark } from "../components/Wordmark";

export function Footer() {
  return (
    <footer>
      <a href="/" aria-label="Mimoza home">
        <Wordmark />
      </a>
      <span className="footer-links">
        <a href="/privacy/">Privacy policy</a>
        <a href="mailto:hello@joinmimoza.com">Support</a>
      </span>
      <span>© 2026 Mimoza</span>
    </footer>
  );
}
