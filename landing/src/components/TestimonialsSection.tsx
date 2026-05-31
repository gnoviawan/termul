import type { ComponentProps } from 'react';

import { ArrowUpRightIcon } from 'lucide-react';

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { InfiniteSlider } from '@/components/ui/infinite-slider';

import { testimonials, type Testimonial } from '../data/testimonials';
import { cn } from '../lib/utils';
import { SectionHeader } from './SectionHeader';

const firstRow = testimonials.slice(0, 5);
const secondRow = testimonials.slice(5, 10);

export function TestimonialsSection() {
  return (
    <section
      aria-labelledby="testimonials-heading"
      className="overflow-hidden px-6 py-20"
    >
      <div className="relative mx-auto max-w-5xl">
        <SectionHeader
          align="center"
          titleId="testimonials-heading"
          title="Built for developers who live in the terminal"
          description="Teams use Termul to keep projects, shells, and context in one workspace—without rebuilding their setup every time they switch repos."
          className="mb-10 w-full max-w-2xl space-y-2"
          titleClassName="mb-8 text-3xl md:text-5xl"
        />
        <TestimonialsMarquee />
      </div>
    </section>
  );
}

function TestimonialsMarquee() {
  return (
    <div className="mask-l-from-80% mask-r-from-80% relative">
      <InfiniteSlider gap={0} speed={30} speedOnHover={0.5}>
        {firstRow.map((testimonial) => (
          <TestimonialsCard key={testimonial.name} {...testimonial} />
        ))}
      </InfiniteSlider>
      <InfiniteSlider gap={0} reverse speed={30} speedOnHover={0.5}>
        {secondRow.map((testimonial) => (
          <TestimonialsCard key={testimonial.name} {...testimonial} />
        ))}
      </InfiniteSlider>
    </div>
  );
}

function TestimonialsCard({
  className,
  quote,
  company,
  image,
  name,
  role,
  ...props
}: ComponentProps<'a'> & Testimonial) {
  return (
    <a
      className={cn(
        'group relative flex w-full max-w-xs flex-col justify-between *:px-4 hover:cursor-pointer *:md:px-6',
        className,
      )}
      {...props}
    >
      <blockquote className="flex-1 py-4">
        <p className="text-foreground text-sm">{quote}</p>
      </blockquote>
      <figcaption className="flex h-16 items-center justify-between">
        <div className="flex items-center gap-2">
          <Avatar className="size-8 rounded-full">
            <AvatarImage alt={`${name}'s profile picture`} src={image} />
            <AvatarFallback>{name.charAt(0)}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col py-2">
            <cite className="font-medium text-sm not-italic leading-5">
              {name}
            </cite>
            <span className="text-muted-foreground text-xs leading-5">
              {role}
              {company && `, ${company}`}
            </span>
          </div>
        </div>
        <ArrowUpRightIcon
          aria-hidden="true"
          className={cn(
            'size-4 opacity-0 group-hover:opacity-100',
            'group-hover:translate-x-1 group-hover:-translate-y-1',
            'transition-all duration-250 ease-out',
          )}
        />
      </figcaption>
      <div
        aria-hidden="true"
        className="absolute inset-5 -z-1 rounded-lg bg-accent opacity-0 transition-all duration-100 ease-out group-hover:inset-0 group-hover:opacity-100 dark:bg-muted/50 dark:group-active:bg-muted"
      />
    </a>
  );
}
