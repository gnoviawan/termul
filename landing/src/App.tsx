import { useMemo, useState } from 'react';
import type { OverlayScrollbars } from 'overlayscrollbars';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import Header from './components/Header';
import Hero from './components/Hero';
import FeatureSection from './components/FeatureSection';
import Footer from './components/Footer';

function App() {
  const [scrollTop, setScrollTop] = useState(0);

  const overlayEvents = useMemo(
    () => ({
      initialized: (instance: OverlayScrollbars) => {
        setScrollTop(instance.elements().scrollOffsetElement.scrollTop);
      },
      scroll: (instance: OverlayScrollbars) => {
        setScrollTop(instance.elements().scrollOffsetElement.scrollTop);
      },
    }),
    [],
  );

  return (
    <OverlayScrollbarsComponent
      className="h-screen bg-black text-white selection:bg-white/30 font-sans"
      defer
      events={overlayEvents}
      options={{
        scrollbars: {
          autoHide: 'move',
          theme: 'os-theme-termul',
        },
      }}
    >
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
        <Footer />
      </div>
    </OverlayScrollbarsComponent>
  );
}

export default App;