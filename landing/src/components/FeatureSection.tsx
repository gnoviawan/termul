import { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tick01Icon } from '@hugeicons/core-free-icons';

import { useReducedMotion } from '../lib/useReducedMotion';
import {
  features,
  pixelBlastDefaults,
  featurePixelBlastProps,
} from '../data/features';
import { FeatureVisual } from './feature-visuals';

const PixelBlast = lazy(() => import('./PixelBlast'));

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
          <div>
            <div className="flex items-center gap-2 text-xs font-mono tracking-wider text-gray-500 mb-6 uppercase">
              <div className="w-1.5 h-1.5 rounded-sm bg-white/30"></div>
              Termul Features
            </div>
            <h2 className="text-4xl md:text-5xl font-medium tracking-tight mb-4 text-balance">
              Everything in one workspace.
            </h2>
            <p className="text-gray-400 text-lg leading-relaxed">
              Terminals, editors, browsers, and annotations — organized by project.
            </p>
          </div>

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
                      ? 'bg-white/10 text-white border border-white/10'
                      : 'text-gray-500 border border-transparent hover:text-gray-300 hover:bg-white/5'
                    }`}
                >
                  <span className={activeFeature === feature.id ? 'text-blue-400' : ''}>
                    {feature.id}
                  </span>{' '}
                  {feature.navTitle}
                </button>
              ))}
            </div>
          </div>

          <div className="hidden lg:flex flex-col gap-1 relative max-h-[calc(100vh-12rem)] overflow-y-auto [scrollbar-width:thin]">
            <div
              className="absolute left-0 right-0 bg-white/10 rounded-lg pointer-events-none"
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
                    ? 'text-white'
                    : 'text-gray-500 hover:text-gray-300'
                  }`}
              >
                <span
                  className={
                    activeFeature === feature.id
                      ? 'text-blue-400 transition-colors duration-150 ease-[var(--ease-out)]'
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
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden flex flex-col">
                {/* Visual Header */}
                <div className="aspect-[4/3] w-full relative border-b border-white/10 flex items-center justify-center overflow-hidden bg-black/40 isolate">
                  <Suspense
                    fallback={
                      <div
                        className="absolute inset-0 z-0 bg-gradient-to-br from-black/50 to-black/20"
                        aria-hidden
                      />
                    }
                  >
                    {!reducedMotion && (
                      <div className="absolute inset-0 z-0" aria-hidden>
                        <PixelBlast
                          {...pixelBlastDefaults}
                          {...featurePixelBlastProps[feature.id]}
                        />
                      </div>
                    )}
                    {reducedMotion && (
                      <div
                        className="absolute inset-0 z-0 bg-gradient-to-br from-white/[0.04] to-transparent"
                        aria-hidden
                      />
                    )}
                  </Suspense>
                  <FeatureVisual id={feature.id} />
                </div>

                {/* Text Content */}
                <div className="p-8 sm:p-12 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                  <h3 className="text-2xl sm:text-3xl font-medium mb-4 text-white">
                    {feature.title}
                  </h3>
                  <p className="text-gray-400 text-lg leading-relaxed">{feature.description}</p>
                  <ul className="mt-6 flex flex-col gap-2.5">
                    {feature.bullets.map((bullet) => (
                      <li key={bullet} className="flex items-start gap-3 text-gray-400">
                        <HugeiconsIcon
                          icon={Tick01Icon}
                          className="w-4 h-4 text-blue-400 mt-0.5 shrink-0"
                        />
                        <span className="leading-relaxed">{bullet}</span>
                      </li>
                    ))}
                  </ul>
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
