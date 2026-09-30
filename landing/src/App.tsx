import { Nav } from "./sections/nav";
import { Hero } from "./sections/hero";
import { Marquee } from "./sections/marquee";
import { CircleShowcase } from "./sections/CircleShowcase";
import { CircleWalkthrough } from "./sections/circleWalkthrough";
import { EncryptedShowcase } from "./sections/EncryptedShowcase";
import { PrivacySection } from "./sections/privacySection";
import { ConversationShowcase } from "./sections/ConversationShowcase";
import { ProfileSection } from "./sections/profileSection";
import { QuietFeatures } from "./sections/quietFeatures";
import { Closing } from "./sections/closing";
import { Footer } from "./sections/footer";

function App() {
  return (
    <main>
      <Nav />
      <Hero />
      <Marquee />
      <CircleShowcase />
      <CircleWalkthrough />
      <EncryptedShowcase />
      <PrivacySection />
      <ConversationShowcase />
      <ProfileSection />
      <QuietFeatures />
      <Closing />
      <Footer />
    </main>
  );
}

export default App;
