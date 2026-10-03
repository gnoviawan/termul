import { ProductCta } from '../ui/ProductCta';

export const Hero = () => {
  return (
    <section className="relative pt-40 pb-20 px-6 flex flex-col items-center justify-center text-center overflow-hidden">
      <img
        src="/bg-termul.webp"
        alt=""
        aria-hidden
        className="absolute inset-0 w-full h-full object-cover z-0 pointer-events-none"
      />
      <div
        className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-white/40 to-transparent z-[1] pointer-events-none"
        aria-hidden
      />
      <div className="relative z-10 w-full flex flex-col items-center text-black">
        <div className="t-stagger is-shown w-full flex flex-col items-center">
          <h1 className="text-5xl md:text-7xl font-medium tracking-tighter mb-6 max-w-4xl text-balance drop-shadow-[0_2px_16px_rgba(255,255,255,0.55)]">
            <span className="t-stagger-line t-stagger-line--1">A Hundred Agents</span>
            <span className="t-stagger-line t-stagger-line--2">In One Manager.</span>
          </h1>

          <p className="t-stagger-line t-stagger-line--3 text-lg md:text-xl max-w-2xl mb-10 text-slate-600">
            Termul treats workspaces as first-class citizens. Organize terminals by project with persistent sessions, snapshots, and a clean tabbed interface.
          </p>
        </div>

        <div className="mb-20 t-emphasis-fade">
          <ProductCta variant="hero" />
        </div>

        <div className="relative w-full max-w-5xl mx-auto t-emphasis-fade">
          <img
            src="/termulmock.png"
            alt="Termul application with project workspaces, multiple terminals, and file explorer"
            className="w-full h-auto rounded-lg shadow-2xl shadow-black/10"
            width={1024}
            height={640}
            loading="eager"
            decoding="async"
          />
        </div>
      </div>
    </section>
  );
};
