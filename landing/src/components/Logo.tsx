import { cn } from '../lib/utils';

interface LogoProps {
  className?: string;
  iconClassName?: string;
  textClassName?: string;
}

export const Logo = ({ className, iconClassName, textClassName }: LogoProps) => {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <img
        src="/termul.svg"
        alt=""
        width={24}
        height={24}
        decoding="async"
        className={cn("h-6 w-auto max-h-6 shrink-0 object-contain object-left", iconClassName)}
        aria-hidden
      />
      <span className={cn("text-xl font-semibold tracking-tight", textClassName)}>Termul</span>
    </div>
  );
};
