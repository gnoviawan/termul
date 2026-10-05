import type { ReactNode } from 'react';

import { useInViewOnce } from '../../lib/useInViewOnce';
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
  const { ref, shown } = useInViewOnce<HTMLDivElement>();
  const titleLine = eyebrow ? 't-stagger-line--2' : 't-stagger-line--1';
  const descriptionLine = eyebrow ? 't-stagger-line--3' : 't-stagger-line--2';

  return (
    <div
      ref={ref}
      className={cn(
        't-stagger',
        shown && 'is-shown',
        align === 'center' && 'mx-auto text-center',
        className,
      )}
    >
      {eyebrow && (
        <div className="t-stagger-line t-stagger-line--1">
          <div
            className={cn(
              'mb-6 flex items-center gap-2 text-xs font-mono tracking-wider text-gray-500 uppercase',
              align === 'center' && 'justify-center',
            )}
          >
            <div className="h-1.5 w-1.5 rounded-sm bg-porcelain/30" />
            {eyebrow}
          </div>
        </div>
      )}
      <h2
        id={titleId}
        className={cn(
          't-stagger-line mb-4 text-4xl font-medium tracking-tight text-balance md:text-5xl',
          titleLine,
          titleClassName,
        )}
      >
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            't-stagger-line text-lg leading-relaxed text-gray-400',
            descriptionLine,
            descriptionClassName,
          )}
        >
          {description}
        </p>
      )}
    </div>
  );
}
