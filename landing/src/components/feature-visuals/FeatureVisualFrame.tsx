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
        'relative rounded-xl border border-white/10 bg-[#0a0a0a] shadow-[0_20px_50px_rgba(0,0,0,0.5)]',
        size === 'sm' && 'w-[85%] max-w-sm',
        size === 'md' && 'w-[90%] max-w-md',
        className,
      )}
    >
      {children}
    </div>
  );
}
