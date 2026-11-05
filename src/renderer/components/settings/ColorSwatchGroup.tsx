import * as RadioGroup from '@radix-ui/react-radio-group'
import { forwardRef } from 'react'
import { Check } from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { availableColors, getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import type { ProjectColor } from '@/types/project'

interface ColorSwatchGroupProps
  extends Omit<React.ComponentPropsWithoutRef<typeof RadioGroup.Root>, 'onValueChange'> {
  onValueChange?: (value: ProjectColor) => void
}

const label = (color: string): string => color.charAt(0).toUpperCase() + color.slice(1)

/**
 * Project colors as a radio group: arrow keys move, the chosen swatch shows a
 * check, and each swatch has a name. Controlled or uncontrolled like Radix.
 */
export const ColorSwatchGroup = forwardRef<HTMLDivElement, ColorSwatchGroupProps>(
  function ColorSwatchGroup({ onValueChange, className, ...props }, ref) {
    return (
      <RadioGroup.Root
        ref={ref}
        orientation="horizontal"
        loop
        onValueChange={(value) => onValueChange?.(value as ProjectColor)}
        className={cn('flex flex-wrap items-center gap-1.5', className)}
        {...props}
      >
        {availableColors.map((color) => (
          <RadioGroup.Item
            key={color}
            value={color}
            aria-label={label(color)}
            title={label(color)}
            className={cn(
              'group flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-opacity duration-150 ease-out hover:opacity-80',
              FOCUS_RING_CLASS,
              'data-[state=checked]:ring-2 data-[state=checked]:ring-current data-[state=checked]:hover:opacity-100',
              getColorClasses(color).bg,
              getColorClasses(color).text
            )}
          >
            <RadioGroup.Indicator>
              <Check size={12} className="text-background" />
            </RadioGroup.Indicator>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    )
  }
)
