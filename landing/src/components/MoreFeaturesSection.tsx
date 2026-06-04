import { HugeiconsIcon } from '@hugeicons/react';

import { SectionHeader } from './SectionHeader';
import { moreFeatures } from '../data/more-features';

const MoreFeaturesSection = () => {
  return (
    <section id="more-features" className="py-32 px-6 max-w-7xl mx-auto">
      <SectionHeader
        align="center"
        title="Built for the whole workflow."
        description="Beyond the headline features, Termul is packed with the everyday conveniences that keep you in flow."
        className="max-w-2xl"
        descriptionClassName="mt-4"
      />

      <div className="mt-20 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {moreFeatures.map((feature) => (
          <div
            key={feature.title}
            className="group relative overflow-hidden rounded-3xl border border-border-subtle bg-porcelain/[0.02] p-8 shadow-2xl shadow-pitch-black/20 backdrop-blur-sm transition-[transform,border-color,background-color,box-shadow] duration-300 ease-[var(--ease-out)] hover:-translate-y-1 hover:border-porcelain/20 hover:bg-porcelain/[0.03] hover:shadow-pitch-black/40"
          >
            <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-aether-blue/10 blur-[50px] transition-opacity duration-300 group-hover:opacity-100 opacity-0 pointer-events-none" />
            
            <div className="relative z-10 mb-6 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-border-subtle bg-porcelain/[0.03] text-aether-blue shadow-inner transition-[border-color,background-color,transform,color] duration-300 ease-[var(--ease-out)] group-hover:border-aether-blue/30 group-hover:bg-aether-blue/10 group-hover:scale-110 group-hover:text-aether-blue/80">
              <HugeiconsIcon icon={feature.icon} className="h-6 w-6" />
            </div>
            <h3 className="relative z-10 mb-3 text-lg font-medium text-foreground tracking-tight">{feature.title}</h3>
            <p className="relative z-10 text-sm leading-relaxed text-gray-400">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
};

export default MoreFeaturesSection;
