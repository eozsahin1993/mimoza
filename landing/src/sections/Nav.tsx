import { Wordmark } from "../components/Wordmark";
import { Icon } from "../components/Icon";

function scrollToId(id: string) {
  document.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth" });
}

export function Nav() {
  return (
    <nav className="nav">
      <Wordmark />
      <div className="nav-links">
        <div role="link" tabIndex={0} onClick={() => scrollToId("circles")}>
          How it works
        </div>
        <div role="link" tabIndex={0} onClick={() => scrollToId("privacy")}>
          Privacy
        </div>
      </div>
      <div className="nav-download" role="link" tabIndex={0} onClick={() => scrollToId("download")}>
        Get Mimoza <Icon name="arrow" size={17} />
      </div>
    </nav>
  );
}
