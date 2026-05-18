import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import Header from './components/Header';
import Hero from './components/Hero';
import FeatureSection from './components/FeatureSection';
import Footer from './components/Footer';

function App() {
  return (
    <OverlayScrollbarsComponent
      className="h-screen bg-black text-white selection:bg-white/30 font-sans"
      defer
      options={{
        scrollbars: {
          autoHide: 'move',
          theme: 'os-theme-termul',
        },
      }}
    >
      <div className="min-h-screen">
        <Header />
        <main>
          <Hero />
          <FeatureSection />
        </main>
        <Footer />
      </div>
    </OverlayScrollbarsComponent>
  );
}

export default App;