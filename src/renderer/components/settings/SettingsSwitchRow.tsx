import { rowId } from '@/components/settings/row-id'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { Switch } from '@/components/ui/switch'

interface SettingsSwitchRowProps {
  /** Control id; the row's id is `rowId(id)` so search can jump to it. */
  id: string
  label: string
  description: string
  checked: boolean
  onToggle: (enabled: boolean) => void
}

/** A {@link SettingsRow} with a labelled, described `Switch` on the right. */
export function SettingsSwitchRow({
  id,
  label,
  description,
  checked,
  onToggle
}: SettingsSwitchRowProps): React.JSX.Element {
  return (
    <SettingsRow
      id={rowId(id)}
      htmlFor={id}
      label={label}
      description={description}
      layout="inline"
    >
      <Switch
        id={id}
        aria-describedby={settingsDescriptionId(id)}
        checked={checked}
        onCheckedChange={onToggle}
      />
    </SettingsRow>
  )
}
