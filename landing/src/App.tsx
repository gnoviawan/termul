import { useCallback, useState } from 'react';
import Header from './components/Header';
import Hero from './components/Hero';
import FeatureSection from './components/FeatureSection';
import Footer from './components/Footer';
import { ScrollContainer } from './components/ScrollContainer';
import { TestimonialsSection } from './components/TestimonialsSection';

export function App() {
  const [scrollTop, setScrollTop] = useState(0);
  const handleScrollTopChange = useCallback((nextScrollTop: number) => {
    setScrollTop(nextScrollTop);
  }, []);

  return (
    <ScrollContainer onScrollTopChange={handleScrollTopChange}>
      <div className="min-h-screen">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-black focus:outline-none"
        >
          Skip to content
        </a>
        <Header scrollTop={scrollTop} />
        <main id="main-content">
          <Hero />
          <FeatureSection />
        </main>
        <TestimonialsSection />
        <Footer />
      </div>
    </ScrollContainer>
  );
}

export default App;
