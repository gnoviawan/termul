import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

type FeatureVisualRootProps = {
  children: ReactNode;
  className?: string;
};

type FeatureVisualWindowProps = {
  children: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
};

export function FeatureVisualFrameRoot({ children, className }: FeatureVisualRootProps) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FeatureVisualFrameWindow({
  children,
  size = 'sm',
  className,
}: FeatureVisualWindowProps) {
  return (
    <div
      className={cn(
        'relative rounded-xl border border-border-subtle bg-graphite shadow-[0_20px_50px_color-mix(in_srgb,var(--color-pitch-black)_50%,transparent)]',
        size === 'sm' && 'w-[85%] max-w-sm',
        size === 'md' && 'w-[90%] max-w-md',
        className,
      )}
    >
      {children}
    </div>
  );
}
