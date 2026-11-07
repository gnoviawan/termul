import { rowId } from '@/components/settings/row-id'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { Switch } from '@/components/ui/switch'

interface SettingsSwitchRowProps {
  /** Control id; the row's id is `rowId(id)` so search can jump to it. */
  id: string
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
}

/** A {@link SettingsRow} with a labelled, described `Switch` on the right. */
export function SettingsSwitchRow({
  id,
  label,
  description,
  checked,
  disabled,
  onToggle
}: SettingsSwitchRowProps): React.JSX.Element {
  return (
    <SettingsRow
      id={rowId(id)}
      htmlFor={id}
      label={label}
      description={description}
      layout="inline"
      disabled={disabled}
    >
      <Switch
        id={id}
        aria-describedby={settingsDescriptionId(id)}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
      />
    </SettingsRow>
  )
}
