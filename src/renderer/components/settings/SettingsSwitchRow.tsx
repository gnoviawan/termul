import { useId } from 'react'
import { Switch } from '@/components/ui/switch'

/** Settings row: label + description on the left, a {@link Switch} on the right. */
export function SettingsSwitchRow({
  label,
  description,
  checked,
  onToggle
}: {
  /** Row title; also the switch's accessible name. */
  label: string
  description: string
  checked: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  const descriptionId = useId()
  return (
    <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-md px-4 py-3">
      <div className="flex-1">
        <div className="text-sm text-foreground">{label}</div>
        <div id={descriptionId} className="text-xs text-muted-foreground mt-0.5">
          {description}
        </div>
      </div>
      <Switch
        aria-label={label}
        aria-describedby={descriptionId}
        checked={checked}
        onCheckedChange={onToggle}
      />
    </div>
  )
}
