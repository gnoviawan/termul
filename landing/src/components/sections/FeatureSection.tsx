import { useState, useEffect, useRef, useCallback } from 'react';

import { useReducedMotion } from '../../lib/useReducedMotion';
import { HEADER_SCROLL_OFFSET, smoothScrollToElement } from '../../lib/smooth-scroll';
import { features, featureBackgroundImage } from '../../data/features';
import { FeatureVisual } from '../feature-visuals';
import { SectionHeader } from '../ui/SectionHeader';
import { FeatureVideo } from '../ui/FeatureVideo';

export const FeatureSection = () => {
  const [activeFeature, setActiveFeature] = useState('01');
  const observerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pillRef = useRef<HTMLSpanElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pillPlaced = useRef(false);
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
      smoothScrollToElement(target, { offset: HEADER_SCROLL_OFFSET });
    }
  };

  const activeIndex = features.findIndex((feature) => feature.id === activeFeature);

  const movePill = useCallback((tab: HTMLElement, animate: boolean) => {
    const pill = pillRef.current;
    if (!pill) return;

    if (!animate) {
      const previous = pill.style.transition;
      pill.style.transition = 'none';
      pill.style.transform = `translateX(${tab.offsetLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
      void pill.offsetWidth;
      pill.style.transition = previous;
      return;
    }

    pill.style.transform = `translateX(${tab.offsetLeft}px)`;
    pill.style.width = `${tab.offsetWidth}px`;
  }, []);

  useEffect(() => {
    const tab = tabRefs.current[activeIndex];
    if (!tab) return;

    movePill(tab, pillPlaced.current && !reducedMotion);
    pillPlaced.current = true;
  }, [activeIndex, movePill, reducedMotion]);

  useEffect(() => {
    const onResize = () => {
      const tab = tabRefs.current[activeIndex];
      if (tab) movePill(tab, false);
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [activeIndex, movePill]);

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
            <nav className="t-tabs mx-2 min-w-max" aria-label="Features">
              <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
              {features.map((feature, index) => (
                <button
                  key={feature.id}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  type="button"
                  aria-current={activeFeature === feature.id ? 'true' : undefined}
                  onClick={() => scrollToFeature(feature.id)}
                  className="t-tab snap-center font-mono text-xs tracking-wide whitespace-nowrap"
                >
                  <span className={activeFeature === feature.id ? 't-tab-index' : ''}>
                    {feature.id}
                  </span>{' '}
                  {feature.navTitle}
                </button>
              ))}
            </nav>
          </div>

          <div className="hidden lg:flex flex-col gap-1 relative max-h-[calc(100vh-12rem)] overflow-y-auto [scrollbar-width:thin]">
            <div
              className="absolute left-0 right-0 bg-porcelain/10 rounded-lg pointer-events-none"
              style={{
                height: '44px',
                transform: `translateY(${activeIndex * 48}px)`,
                transition: reducedMotion
                  ? 'none'
                  : 'transform var(--tabs-dur) var(--tabs-ease)',
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
                    : 'text-text-muted hover:text-text-muted-hover'
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
