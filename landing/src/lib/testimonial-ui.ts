/** Shared Tailwind classes for testimonial CMS + submit forms. */

export const testimonialPanelClass =
  'rounded-3xl border border-border-subtle bg-porcelain/[0.03]';

export const testimonialPanelInsetClass =
  'rounded-3xl border border-border-subtle bg-porcelain/[0.02]';

export const testimonialLabelClass = 'text-sm font-medium text-foreground';

const fieldFocus =
  'outline-none transition-[border-color,background-color,box-shadow] duration-200 ease-[var(--ease-out)] hover:border-porcelain/20 hover:bg-pitch-black/60 focus:border-porcelain/30 focus:bg-porcelain/[0.03] focus:ring-4 focus:ring-porcelain/5 placeholder:text-gray-600';

export const testimonialInputClass = [
  'rounded-full border border-border-subtle bg-pitch-black/40 px-4 py-3 text-sm text-foreground',
  fieldFocus,
].join(' ');

export const testimonialTextareaClass = [
  'resize-none rounded-2xl border border-border-subtle bg-pitch-black/40 px-4 py-3 text-sm text-foreground',
  fieldFocus,
].join(' ');

const fileFieldFocus =
  'outline-none transition-[border-color,background-color,box-shadow] duration-200 ease-[var(--ease-out)] hover:border-porcelain/20 hover:bg-pitch-black/60 focus-within:border-porcelain/30 focus-within:bg-porcelain/[0.03] focus-within:ring-4 focus-within:ring-porcelain/5';

export const testimonialFileInputClass = [
  'w-full min-w-0 cursor-pointer rounded-full border border-border-subtle bg-pitch-black/40 py-2 pl-2 pr-4 text-sm text-gray-300',
  fileFieldFocus,
  'file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-porcelain/10 file:px-4 file:py-1.5 file:text-sm file:font-medium file:text-foreground file:transition-colors file:hover:bg-porcelain/20',
].join(' ');
