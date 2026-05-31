import FeatureSection from '../components/FeatureSection';
import Hero from '../components/Hero';
import { TestimonialsSection } from '../components/TestimonialsSection';

export function HomePage() {
  return (
    <>
      <main id="main-content">
        <Hero />
        <FeatureSection />
      </main>
      <TestimonialsSection />
    </>
  );
}
