import { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick01Icon, ConsoleIcon } from "@hugeicons/core-free-icons";

import { AppleLogo, LinuxLogo, WindowsLogo } from './OsBrandIcons';
import { useReducedMotion } from '../lib/useReducedMotion';

import type { PixelBlastProps } from './PixelBlast';

const PixelBlast = lazy(() => import('./PixelBlast'));

const pixelBlastDefaults = {
  pixelSize: 6,
  patternScale: 3,
  patternDensity: 1.2,
  pixelSizeJitter: 0.5,
  enableRipples: true,
  rippleSpeed: 0.4,
  rippleThickness: 0.12,
  rippleIntensityScale: 1.5,
  liquid: true,
  liquidStrength: 0.12,
  liquidRadius: 1.2,
  liquidWobbleSpeed: 5,
  speed: 0.6,
  edgeFade: 0.25,
  transparent: true,
} satisfies Partial<PixelBlastProps>;

const featurePixelBlastProps: Partial<Record<string, Partial<PixelBlastProps>>> = {
  '01': {
    variant: 'circle',
    color: '#38bdf8',
  },
  '02': {
    variant: 'diamond',
    color: '#f472b6',
    patternDensity: 1.35,
    rippleSpeed: 0.38,
    liquidWobbleSpeed: 5.4,
    speed: 0.52,
  },
  '03': {
    variant: 'triangle',
    color: '#fb923c',
    patternScale: 2.85,
    patternDensity: 1.05,
    liquidStrength: 0.14,
    speed: 0.58,
  },
  '04': {
    variant: 'square',
    color: '#4ade80',
    patternScale: 2.6,
    rippleThickness: 0.1,
    liquidStrength: 0.1,
    speed: 0.54,
  },
};

const features = [
  {
    id: '01',
    navTitle: 'TABBED INTERFACE',
    title: "Tabbed Interface",
    description: "Windows Terminal-style clean tab bar with drag-and-drop reordering and quick shell switching.",
    bullets: [
      "Intuitive window management",
      "Drag-and-drop to reorder tabs",
      "Quick access to multiple environments"
    ],
    visual: (
      <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
        <div className="relative w-[85%] max-w-sm bg-[#0a0a0a] rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden">
          <div className="h-10 bg-[#000] border-b border-white/10 flex items-end px-2 pt-2 gap-1">
            <div className="bg-[#161616] border border-b-0 border-white/10 rounded-t-lg px-4 h-full text-[10px] text-gray-300 flex items-center gap-2">
              <HugeiconsIcon icon={ConsoleIcon} className="w-3 h-3 text-blue-400" />
              termul
            </div>
            <div className="px-4 h-full text-[10px] text-gray-500 flex items-center gap-2 hover:bg-white/5 rounded-t-lg cursor-pointer transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">
              <HugeiconsIcon icon={ConsoleIcon} className="w-3 h-3" />
              server
            </div>
            <div className="px-4 h-full text-[10px] text-gray-500 flex items-center gap-2 hover:bg-white/5 rounded-t-lg cursor-pointer transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">
              <HugeiconsIcon icon={ConsoleIcon} className="w-3 h-3" />
              client
            </div>
          </div>
          <div className="p-5 font-mono text-[10px] sm:text-xs text-gray-400 min-h-[140px] bg-[#0d0d0d] flex flex-col gap-1.5">
            <div className="text-gray-500">~/Projects/termul</div>
            <div><span className="text-green-400">➜</span> npm run dev</div>
            <div className="text-blue-400 mt-2">VITE v5.0.0 ready in 345 ms</div>
            <div className="text-gray-400">➜ Local: http://localhost:5173/</div>
          </div>
        </div>
      </div>
    )
  },
  {
    id: '02',
    navTitle: 'SESSION PERSISTENCE',
    title: "Session Persistence",
    description: "Terminal sessions persist across app restarts automatically. Take snapshots and restore workspace states anytime.",
    bullets: [
      "Automatic state saving",
      "Workspace snapshots for easy recovery",
      "Pick up exactly where you left off"
    ],
    visual: (
      <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
        <div className="relative w-[85%] max-w-sm bg-[#0a0a0a] rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden">
          <div className="h-8 bg-[#161616] border-b border-white/10 flex items-center px-4">
            <div className="text-[10px] text-gray-400 font-medium tracking-wide">SNAPSHOT MANAGER</div>
          </div>
          <div className="p-4 bg-[#0d0d0d] flex flex-col gap-2 min-h-[140px]">
            <div className="bg-white/5 border border-blue-500/30 rounded p-3 flex justify-between items-center shadow-lg shadow-black">
              <div>
                <div className="text-xs text-white mb-0.5">Before Refactor</div>
                <div className="text-[10px] text-gray-500">May 18, 10:42 AM • 4 tabs</div>
              </div>
              <div className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-1 rounded border border-blue-500/20 cursor-pointer transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">RESTORE</div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded p-3 flex justify-between items-center opacity-60">
              <div>
                <div className="text-xs text-white mb-0.5">End of day</div>
                <div className="text-[10px] text-gray-500">May 17, 05:30 PM • 2 tabs</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  },
  {
    id: '03',
    navTitle: 'MULTIPLE SHELLS',
    title: "Multiple Shell Support",
    description: "Automatically detects and supports PowerShell, CMD, Git Bash, WSL, zsh, bash and more.",
    bullets: [
      "Zero-config shell detection",
      "Seamless integration with WSL",
      "Support for all popular terminal environments"
    ],
    visual: (
      <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
        <div className="relative w-[85%] max-w-sm bg-[#0a0a0a] rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden">
          <div className="p-2 border-b border-white/10 bg-[#161616]">
            <div className="bg-[#0a0a0a] border border-white/10 rounded p-2 flex items-center justify-between text-xs text-gray-300">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]"></span> PowerShell
              </span>
              <span className="text-[10px] text-gray-500">▼</span>
            </div>
          </div>
          <div className="p-2 bg-[#0d0d0d] flex flex-col gap-1 text-xs">
            <div className="px-3 py-2 rounded bg-blue-500/10 text-white cursor-pointer flex items-center justify-between border border-blue-500/20 transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-400"></span> PowerShell
              </div>
              <HugeiconsIcon icon={Tick01Icon} className="w-3 h-3 text-blue-400" />
            </div>
            <div className="px-3 py-2 rounded hover:bg-white/5 text-gray-400 cursor-pointer flex items-center gap-2 transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">
              <span className="w-2 h-2 rounded-full bg-white opacity-50"></span> Command Prompt
            </div>
            <div className="px-3 py-2 rounded hover:bg-white/5 text-gray-400 cursor-pointer flex items-center gap-2 transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">
              <span className="w-2 h-2 rounded-full bg-orange-400 opacity-50"></span> Ubuntu (WSL)
            </div>
            <div className="px-3 py-2 rounded hover:bg-white/5 text-gray-400 cursor-pointer flex items-center gap-2 transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">
              <span className="w-2 h-2 rounded-full bg-yellow-400 opacity-50"></span> Git Bash
            </div>
          </div>
        </div>
      </div>
    )
  },
  {
    id: '04',
    navTitle: 'CROSS-PLATFORM',
    title: "Cross-Platform",
    description: "Built on Tauri 2.0 and React for blazing fast native performance on Windows, macOS, and Linux.",
    bullets: [
      "Native performance with Tauri 2.0",
      "Lightweight memory footprint",
      "Consistent experience across all OS"
    ],
    visual: (
      <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
        <div className="relative w-[85%] max-w-sm bg-[#0a0a0a] rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden">
          <div className="h-8 bg-gradient-to-r from-gray-800 to-gray-900 border-b border-white/10 flex items-center px-3 gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500"></div>
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500"></div>
            <div className="w-2.5 h-2.5 rounded-full bg-green-500"></div>
          </div>
          <div className="p-5 font-mono text-xs text-gray-400 min-h-[140px] bg-[#0d0d0d] flex flex-col justify-center items-center gap-4">
             <div className="flex gap-3 w-full">
               <div className="flex-1 flex flex-col items-center gap-2 p-3 bg-white/5 rounded-lg border border-white/5 shadow-inner text-gray-400">
                 <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                   <AppleLogo className="h-full w-full" />
                 </div>
                 <span className="text-[10px]">macOS</span>
               </div>
               <div className="flex-1 flex flex-col items-center gap-2 p-3 bg-blue-500/10 rounded-lg border border-blue-500/20 shadow-inner text-blue-400">
                 <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                   <WindowsLogo className="h-full w-full" />
                 </div>
                 <span className="text-[10px]">Windows</span>
               </div>
               <div className="flex-1 flex flex-col items-center gap-2 p-3 bg-white/5 rounded-lg border border-white/5 shadow-inner text-gray-400">
                 <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                   <LinuxLogo className="h-full w-full" />
                 </div>
                 <span className="text-[10px]">Linux</span>
               </div>
             </div>
             <div className="text-[10px] text-gray-500 font-sans tracking-wide uppercase mt-2">Tauri 2.0 Engine</div>
          </div>
        </div>
      </div>
    )
  }
];

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
            <h2 className="text-4xl md:text-5xl font-medium tracking-tight mb-6 text-balance">
              Terminal, reimagined.
            </h2>
          </div>

          {/* Mobile feature nav */}
          <div className="lg:hidden -mx-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex gap-2 px-2 min-w-max">
              {features.map((feature) => (
                <button
                  key={feature.id}
                  type="button"
                  onClick={() => scrollToFeature(feature.id)}
                  className={`rounded-full px-4 py-2 font-mono text-xs tracking-wide whitespace-nowrap transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]
                    ${activeFeature === feature.id
                      ? 'bg-white/10 text-white border border-white/10'
                      : 'text-gray-500 border border-transparent hover:text-gray-300 hover:bg-white/5'
                    }`}
                >
                  <span className={activeFeature === feature.id ? 'text-blue-400' : ''}>{feature.id}</span>
                  {' '}{feature.navTitle}
                </button>
              ))}
            </div>
          </div>

          <div className="hidden lg:flex flex-col gap-1 relative">
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
                <span className={activeFeature === feature.id ? 'text-blue-400 transition-colors duration-150 ease-[var(--ease-out)]' : 'transition-colors duration-150 ease-[var(--ease-out)]'}>{feature.id}</span>
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
              ref={el => { observerRefs.current[idx] = el; }}
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
                  {feature.visual}
                </div>
                
                {/* Text Content */}
                <div className="p-8 sm:p-12 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                  <h3 className="text-2xl sm:text-3xl font-medium mb-4 text-white">{feature.title}</h3>
                  <p className="text-gray-400 text-lg leading-relaxed">
                    {feature.description}
                  </p>
                  <ul className="mt-6 flex flex-col gap-2.5">
                    {feature.bullets.map((bullet) => (
                      <li key={bullet} className="flex items-start gap-3 text-gray-400">
                        <HugeiconsIcon icon={Tick01Icon} className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
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