import React from 'react';
import { cn } from '../lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'dark' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  as?: React.ElementType;
  href?: string;
  target?: string;
  rel?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', as: Component = 'button', children, ...props }, ref) => {
    return (
      <Component
        ref={ref}
        className={cn(
          // Base styles
          "relative inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap rounded-full",
          "transition-[transform,colors,opacity,box-shadow] duration-150 ease-[var(--ease-out)]",
          "active:scale-[0.97]",
          "before:absolute before:inset-0 before:rounded-full before:transition-opacity before:duration-150",
          
          // Variants
          variant === 'primary' && [
            "bg-[#fcfcfc] text-black",
            "border border-black/5",
            "shadow-[inset_0_1px_1px_rgba(255,255,255,1),inset_0_-1px_1px_rgba(0,0,0,0.1),0_4px_6px_rgba(0,0,0,0.05)]",
            "hover:bg-white",
          ],
          variant === 'secondary' && [
            "bg-white/60 backdrop-blur-sm text-slate-900",
            "border border-slate-300/80",
            "shadow-[inset_0_1px_1px_rgba(255,255,255,0.8),inset_0_-1px_1px_rgba(0,0,0,0.05),0_4px_6px_rgba(0,0,0,0.02)]",
            "hover:bg-white/80",
          ],
          variant === 'dark' && [
            "bg-white/5 text-white",
            "border border-white/10",
            "shadow-[inset_0_1px_1px_rgba(255,255,255,0.1),inset_0_-1px_1px_rgba(0,0,0,0.5),0_4px_6px_rgba(0,0,0,0.2)]",
            "hover:bg-white/10",
          ],
          variant === 'outline' && [
            "bg-transparent text-slate-800",
            "border border-slate-900/10",
            "hover:bg-slate-900/5",
          ],

          // Sizes
          size === 'sm' && "px-4 py-2 text-sm",
          size === 'md' && "px-6 py-3 text-base",
          size === 'lg' && "px-6 py-3.5 text-base",
          
          className
        )}
        {...props}
      >
        {children}
      </Component>
    );
  }
);

Button.displayName = 'Button';
