import Header from './components/Header';
import Hero from './components/Hero';
import FeatureSection from './components/FeatureSection';
import Footer from './components/Footer';

function App() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-white/30 font-sans">
      <Header />
      <main>
        <Hero />
        <FeatureSection />
      </main>
      <Footer />
    </div>
  );
}

export default App;