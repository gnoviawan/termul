import FeatureSection from '../components/FeatureSection';
import MoreFeaturesSection from '../components/MoreFeaturesSection';
import Hero from '../components/Hero';
import { TestimonialsSection } from '../components/TestimonialsSection';

export function HomePage() {
  return (
    <>
      <main id="main-content">
        <Hero />
        <FeatureSection />
        <MoreFeaturesSection />
        <TestimonialsSection />
      </main>
    </>
  );
}
