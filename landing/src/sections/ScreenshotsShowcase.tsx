import circlesShot from "../assets/screenshots/circles.jpg";
import feedShot from "../assets/screenshots/feed.jpg";
import encryptedShot from "../assets/screenshots/encrypted.jpg";
import albumShot from "../assets/screenshots/album.jpg";
import inviteShot from "../assets/screenshots/invite.jpg";
import postShot from "../assets/screenshots/post.jpg";

// Same headlines and order as the store listing screenshots, so the two
// tell one story rather than two.
const slides = [
  { image: circlesShot, headline: "A circle for every part of your life.", alt: "The circle list, showing The Mitchells, Weekend Hikers, and more" },
  { image: feedShot, headline: "A photo feed only your circle sees.", alt: "A family's holiday photo in their circle feed" },
  { image: encryptedShot, headline: "End to end encrypted, just between you.", alt: "Composing a post, with a note that only circle members can see it" },
  { image: albumShot, headline: "Keep the memories in a shared album.", alt: "A circle's album, grouped by month" },
  { image: inviteShot, headline: "Only the people you invite.", alt: "Circle details, with invite options and the member list" },
  { image: postShot, headline: "Every photo starts a conversation.", alt: "A post with comments from circle members" },
];

export function ScreenshotsShowcase() {
  return (
    <section className="section screenshots-section" id="look">
      <div className="section-intro">
        <span className="kicker">See it in your hands</span>
        <div className="display section-title" role="heading" aria-level={2}>
          A closer look
        </div>
        <p>The real app, the real screens—nothing staged for the pitch.</p>
      </div>
      <div className="shot-row">
        {slides.map((slide) => (
          <div className="shot-card" key={slide.headline}>
            <div className="shot-headline">{slide.headline}</div>
            <div className="shot-phone">
              <img src={slide.image} alt={slide.alt} loading="lazy" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
