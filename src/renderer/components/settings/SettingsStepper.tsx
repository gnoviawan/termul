import { forwardRef } from 'react'
import { Minus, Plus } from '@/components/icons'
import { FIELD_SURFACE_CLASS, FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

interface SettingsStepperProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value: number
  min: number
  max: number
  step?: number
  onValueChange: (value: number) => void
  /** Text for the value, e.g. `(v) => \`${v} px\``. */
  format?: (value: number) => string
  /** Accessible names, e.g. "Decrease zoom". */
  decrementLabel: string
  incrementLabel: string
  /** When set, a Reset button returns to this value. */
  resetValue?: number
  resetLabel?: string
}

const STEP_BUTTON_CLASS = `flex size-8 items-center justify-center text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground disabled:pointer-events-none disabled:opacity-35 ${FOCUS_RING_CLASS}`

/** Round away float noise from repeated `0.1` steps. */
function snap(value: number, step: number): number {
  const decimals = (step.toString().split('.')[1] ?? '').length
  return Number(value.toFixed(decimals))
}

/** −, value, + for a number setting. Each button is disabled at its limit. */
export const SettingsStepper = forwardRef<HTMLDivElement, SettingsStepperProps>(
  function SettingsStepper(
    {
      value,
      min,
      max,
      step = 1,
      onValueChange,
      format = String,
      decrementLabel,
      incrementLabel,
      resetValue,
      resetLabel = 'Reset',
      className,
      ...props
    },
    ref
  ) {
    const set = (next: number): void =>
      onValueChange(snap(Math.min(max, Math.max(min, next)), step))
    return (
      <div ref={ref} className={cn('flex items-center gap-2', className)} {...props}>
        <div
          className={cn(
            'flex h-8 items-center rounded-lg transition-colors duration-150 ease-out',
            FIELD_SURFACE_CLASS
          )}
        >
          <button
            type="button"
            aria-label={decrementLabel}
            disabled={value <= min}
            onClick={() => set(value - step)}
            className={cn(STEP_BUTTON_CLASS, 'rounded-l-lg')}
          >
            <Minus size={14} />
          </button>
          <output
            aria-live="polite"
            className="flex h-full min-w-16 items-center justify-center border-x border-border px-2 text-xs font-medium tabular-nums text-foreground"
          >
            {format(value)}
          </output>
          <button
            type="button"
            aria-label={incrementLabel}
            disabled={value >= max}
            onClick={() => set(value + step)}
            className={cn(STEP_BUTTON_CLASS, 'rounded-r-lg')}
          >
            <Plus size={14} />
          </button>
        </div>
        {resetValue !== undefined && (
          <button
            type="button"
            onClick={() => set(resetValue)}
            disabled={value === resetValue}
            className={`h-7 rounded-md px-2 text-xs font-medium text-secondary-foreground transition-colors duration-150 ease-out hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING_CLASS}`}
          >
            {resetLabel}
          </button>
        )}
      </div>
    )
  }
)
