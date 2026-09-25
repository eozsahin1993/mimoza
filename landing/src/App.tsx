import { Nav } from "./sections/Nav";
import { Hero } from "./sections/Hero";
import { Marquee } from "./sections/Marquee";
import { CircleWalkthrough } from "./sections/CircleWalkthrough";
import { PrivacySection } from "./sections/PrivacySection";
import { ProfileSection } from "./sections/ProfileSection";
import { QuietFeatures } from "./sections/QuietFeatures";
import { Closing } from "./sections/Closing";
import { Footer } from "./sections/Footer";

function App() {
  return (
    <main>
      <Nav />
      <Hero />
      <Marquee />
      <CircleWalkthrough />
      <PrivacySection />
      <ProfileSection />
      <QuietFeatures />
      <Closing />
      <Footer />
    </main>
  );
}

export default App;
