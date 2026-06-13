import { ContributorsSection } from '../components/sections/ContributorsSection';
import { FeatureSection } from '../components/sections/FeatureSection';
import { MoreFeaturesSection } from '../components/sections/MoreFeaturesSection';
import { Hero } from '../components/sections/Hero';
import { TestimonialsSection } from '../components/sections/TestimonialsSection';

export function HomePage() {
  return (
    <>
      <main id="main-content">
        <Hero />
        <FeatureSection />
        <MoreFeaturesSection />
        <TestimonialsSection />
        <ContributorsSection />
      </main>
    </>
  );
}
