import { HugeiconsIcon } from '@hugeicons/react';

import { SectionHeader } from './SectionHeader';
import { moreFeatures } from '../data/more-features';

const MoreFeaturesSection = () => {
  return (
    <section id="more-features" className="py-32 px-6 max-w-7xl mx-auto">
      <SectionHeader
        align="center"
        eyebrow="And more"
        title="Built for the whole workflow."
        description="Beyond the headline features, Termul is packed with the everyday conveniences that keep you in flow."
        className="max-w-2xl"
        descriptionClassName="mt-4"
      />

      <div className="mt-16 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {moreFeatures.map((feature) => (
          <div
            key={feature.title}
            className="group rounded-2xl border border-white/10 bg-white/[0.02] p-6 transition-colors duration-200 ease-[var(--ease-out)] hover:border-white/20 hover:bg-white/[0.04]"
          >
            <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-blue-400 transition-colors duration-200 ease-[var(--ease-out)] group-hover:border-white/20">
              <HugeiconsIcon icon={feature.icon} className="h-5 w-5" />
            </div>
            <h3 className="mb-2 text-base font-medium text-white">{feature.title}</h3>
            <p className="text-sm leading-relaxed text-gray-400">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
};

export default MoreFeaturesSection;
