import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';

import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md border border-white/10 bg-muted px-2.5 py-1 text-xs font-medium text-foreground shadow-md',
        'origin-[var(--radix-tooltip-content-transform-origin)]',
        'opacity-0 translate-y-1 scale-95',
        'transition-[opacity,transform] duration-200 ease-[var(--ease-out)]',
        'data-[state=delayed-open]:opacity-100 data-[state=delayed-open]:translate-y-0 data-[state=delayed-open]:scale-100',
        'data-[state=closed]:opacity-0 data-[state=closed]:translate-y-1 data-[state=closed]:scale-95',
        'motion-reduce:transition-none motion-reduce:data-[state=delayed-open]:translate-y-0 motion-reduce:data-[state=delayed-open]:scale-100',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
