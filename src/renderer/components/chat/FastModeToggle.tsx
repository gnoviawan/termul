import { Zap } from '@/components/icons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { isFastModeEnabled, oppositeFastModeValue } from './chat-input-bar-config'
import { useOptimisticSelect } from './use-optimistic-select'

interface FastModeToggleProps {
  option: SessionConfigOption
  disabled: boolean
  onSelect: (valueId: string) => void | Promise<void>
}

/**
 * Icon-only On/Off control for agents that advertise a binary Fast Mode config
 * option. Colored (warning/amber) when on; muted outline when off. Tooltip
 * carries the option name so the bare lightning affordance stays discoverable.
 */
export function FastModeToggle({
  option,
  disabled,
  onSelect
}: FastModeToggleProps): React.JSX.Element {
  const { displayValue, pending, select } = useOptimisticSelect(option.currentValue, onSelect)
  const on = isFastModeEnabled(option, displayValue)
  const nextValue = oppositeFastModeValue(option, displayValue)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled || !nextValue}
          aria-pressed={on}
          aria-label={option.name}
          aria-busy={pending || undefined}
          onClick={() => {
            if (!nextValue) return
            select(nextValue)
          }}
          className={cn(
            'relative inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-[color,transform] ease-out',
            "after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] @[400px]:after:-inset-y-1",
            on ? 'text-warning hover:text-warning' : 'text-muted-foreground hover:text-foreground',
            (disabled || !nextValue) &&
              'cursor-not-allowed text-disabled-foreground hover:text-disabled-foreground'
          )}
        >
          <Zap
            size={16}
            fill={on ? 'currentColor' : 'none'}
            strokeWidth={on ? 0 : 2}
            className={cn('shrink-0', pending && 'opacity-70')}
            aria-hidden="true"
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {option.name}
        {on ? ' · On' : ' · Off'}
      </TooltipContent>
    </Tooltip>
  )
}
