import { Icon } from "../../components/Icon";
import { StoreBadge } from "../../components/storeBadge";
import { Wordmark } from "../../components/wordmark";
import { Footer } from "../../sections/footer";
import "../../styles/staticPage.css";
import "./style.css";

// Someone lands here only when the link didn't open the app: it isn't
// installed, or the link was opened somewhere that skips app links, like
// an in-app browser. The custom scheme still reaches an installed app.
function appLink(pathname: string): string | null {
  const match = pathname.match(/^\/(staging\/)?join\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) return null;
  return `${match[1] ? "mimoza-staging" : "mimoza"}://join/${match[2]}`;
}

export function Join() {
  const link = appLink(window.location.pathname);

  return (
    <main className="join-page">
      <nav className="policy-nav">
        <a href="/" aria-label="Mimoza home">
          <Wordmark />
        </a>
        <a className="back" href="/">
          <Icon name="arrow" size={17} /> Home
        </a>
      </nav>

      <article className="policy">
        <span className="kicker">Invite</span>
        {link ? (
          <>
            <h1 className="display policy-title">You're invited to a circle</h1>
            <div className="policy-lede">
              <p>Open this invite in Mimoza to ask to join. The circle's admin approves new members.</p>
            </div>
            <a className="open-app" href={link}>
              Open in Mimoza <Icon name="arrow" size={17} />
            </a>

            <h2>Don't have Mimoza yet?</h2>
            <p>Install it, then come back to this page and tap Open in Mimoza.</p>
            <div className="store-row">
              <StoreBadge store="Apple" />
              <StoreBadge store="Google" />
            </div>
          </>
        ) : (
          <>
            <h1 className="display policy-title">This invite link is incomplete</h1>
            <div className="policy-lede">
              <p>Ask the person who sent it to share it again.</p>
            </div>
          </>
        )}
      </article>
      <Footer />
    </main>
  );
}
