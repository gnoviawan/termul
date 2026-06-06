import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

type SectionHeaderProps = {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  align?: 'start' | 'center';
  className?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  titleId?: string;
};

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = 'start',
  className,
  titleClassName,
  descriptionClassName,
  titleId,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        align === 'center' && 'mx-auto text-center',
        className,
      )}
    >
      {eyebrow && (
        <div
          className={cn(
            'mb-6 flex items-center gap-2 text-xs font-mono tracking-wider text-gray-500 uppercase',
            align === 'center' && 'justify-center',
          )}
        >
          <div className="h-1.5 w-1.5 rounded-sm bg-porcelain/30" />
          {eyebrow}
        </div>
      )}
      <h2
        id={titleId}
        className={cn(
          'mb-4 text-4xl font-medium tracking-tight text-balance md:text-5xl',
          titleClassName,
        )}
      >
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            'text-lg leading-relaxed text-gray-400',
            descriptionClassName,
          )}
        >
          {description}
        </p>
      )}
    </div>
  );
}
