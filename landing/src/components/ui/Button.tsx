import React from 'react';
import { cn } from '../../lib/utils';

type ButtonOwnProps<E extends React.ElementType> = {
  variant?: 'primary' | 'secondary' | 'dark' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  as?: E;
};

export type ButtonProps<E extends React.ElementType = 'button'> =
  ButtonOwnProps<E> &
  Omit<React.ComponentPropsWithRef<E>, keyof ButtonOwnProps<E>>;

type ButtonComponent = (<E extends React.ElementType = 'button'>(
  props: ButtonProps<E> & { ref?: React.ComponentPropsWithRef<E>['ref'] }
) => React.ReactElement | null) & {
  displayName?: string;
};

const renderButton = <E extends React.ElementType = 'button'>(
  { className, variant = 'primary', size = 'md', as, children, ...props }: ButtonProps<E>,
  ref: React.ComponentPropsWithRef<E>['ref']
) => {
    const Component = as ?? 'button';
    const componentProps = Component === 'button' ? { type: 'button', ...props } : props;

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
            "bg-porcelain text-pitch-black",
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
            "bg-slate-900/5 text-slate-900",
            "border border-slate-900/25",
            "hover:bg-slate-900/10",
          ],

          // Sizes
          size === 'sm' && "px-4 py-2 text-sm",
          size === 'md' && "px-6 py-3 text-base",
          size === 'lg' && "px-6 py-3.5 text-base",
          
          className
        )}
        {...componentProps}
      >
        {children}
      </Component>
    );
};

export const Button = React.forwardRef(
  renderButton as unknown as React.ForwardRefRenderFunction<
    unknown,
    ButtonProps<React.ElementType>
  >
) as ButtonComponent;

Button.displayName = 'Button';
