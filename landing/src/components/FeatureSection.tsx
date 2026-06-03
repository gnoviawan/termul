import { useState, useEffect, useRef } from 'react';

import { useReducedMotion } from '../lib/useReducedMotion';
import { features, featureBackgroundImage } from '../data/features';
import { FeatureVisual } from './feature-visuals';
import { SectionHeader } from './SectionHeader';
import { FeatureVideo } from './FeatureVideo';

const FeatureSection = () => {
  const [activeFeature, setActiveFeature] = useState('01');
  const observerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveFeature(entry.target.getAttribute('data-id') || '01');
          }
        });
      },
      { rootMargin: '-30% 0px -60% 0px' }
    );

    observerRefs.current.forEach((ref) => {
      if (ref) observer.observe(ref);
    });

    return () => observer.disconnect();
  }, []);

  const scrollToFeature = (id: string) => {
    const target = document.getElementById(`feature-${id}`);
    if (target) {
      target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  };

  const activeIndex = features.findIndex((feature) => feature.id === activeFeature);

  return (
    <section id="features" className="py-32 px-6 max-w-7xl mx-auto relative">
      <div className="flex flex-col lg:flex-row gap-16 lg:gap-24 relative items-start">
        {/* Left Sticky Sidebar */}
        <div className="lg:w-1/3 lg:sticky lg:top-32 flex flex-col gap-12 w-full">
          <SectionHeader
            eyebrow="Termul Features"
            title="Everything in one workspace."
            description="Terminals, editors, browsers, and annotations — organized by project."
          />

          {/* Mobile feature nav */}
          <div className="lg:hidden -mx-2 overflow-x-auto pb-1 scroll-smooth snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex gap-2 px-2 min-w-max">
              {features.map((feature) => (
                <button
                  key={feature.id}
                  type="button"
                  onClick={() => scrollToFeature(feature.id)}
                  className={`snap-center rounded-full px-4 py-2 font-mono text-xs tracking-wide whitespace-nowrap transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]
                    ${activeFeature === feature.id
                      ? 'bg-porcelain/10 text-foreground border border-border-subtle'
                      : 'text-gray-500 border border-transparent hover:text-gray-300 hover:bg-porcelain/5'
                    }`}
                >
                  <span className={activeFeature === feature.id ? 'text-aether-blue' : ''}>
                    {feature.id}
                  </span>{' '}
                  {feature.navTitle}
                </button>
              ))}
            </div>
          </div>

          <div className="hidden lg:flex flex-col gap-1 relative max-h-[calc(100vh-12rem)] overflow-y-auto [scrollbar-width:thin]">
            <div
              className="absolute left-0 right-0 bg-porcelain/10 rounded-lg pointer-events-none"
              style={{
                height: '44px',
                transform: `translateY(${activeIndex * 48}px)`,
                transition: reducedMotion
                  ? 'none'
                  : 'transform 250ms var(--ease-in-out)',
              }}
            ></div>
            {features.map((feature) => (
              <a
                key={feature.id}
                href={`#feature-${feature.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  scrollToFeature(feature.id);
                }}
                className={`py-3 px-4 rounded-lg font-mono text-sm tracking-wide flex items-center gap-4 relative z-10 transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]
                  ${activeFeature === feature.id
                    ? 'text-foreground'
                    : 'text-gray-500 hover:text-gray-300'
                  }`}
              >
                <span
                  className={
                    activeFeature === feature.id
                      ? 'text-aether-blue transition-colors duration-150 ease-[var(--ease-out)]'
                      : 'transition-colors duration-150 ease-[var(--ease-out)]'
                  }
                >
                  {feature.id}
                </span>
                {feature.navTitle}
              </a>
            ))}
          </div>
        </div>

        {/* Right Scrolling Content */}
        <div className="lg:w-2/3 flex flex-col gap-12 lg:gap-24">
          {features.map((feature, idx) => (
            <div
              key={feature.id}
              id={`feature-${feature.id}`}
              data-id={feature.id}
              ref={(el) => {
                observerRefs.current[idx] = el;
              }}
              className="scroll-mt-32"
            >
              <div className="rounded-2xl border border-border-subtle bg-porcelain/[0.02] overflow-hidden flex flex-col">
                {/* Visual Header */}
                <div className="aspect-[4/3] w-full relative border-b border-border-subtle flex items-center justify-center overflow-hidden bg-pitch-black/40 isolate">
                  <img
                    src={featureBackgroundImage}
                    alt=""
                    aria-hidden
                    className="absolute inset-0 z-0 w-full h-full object-cover pointer-events-none"
                  />
                  {!reducedMotion && feature.video ? (
                    <FeatureVideo
                      id={feature.id}
                      video={feature.video}
                      title={feature.title}
                    />
                  ) : (
                    <FeatureVisual id={feature.id} />
                  )}
                </div>

                {/* Text Content */}
                <div className="p-8 sm:p-12 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                  <h3 className="text-2xl sm:text-3xl font-medium mb-4 text-foreground">
                    {feature.title}
                  </h3>
                  <p className="text-gray-400 text-lg leading-relaxed">{feature.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeatureSection;
