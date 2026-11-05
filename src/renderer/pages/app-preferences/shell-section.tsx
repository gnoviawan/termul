import type { DetectedShells } from '@shared/types/ipc.types'
import { rowId } from '@/components/settings/row-id'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import {
  shellFromSelectValue,
  shellSelectOptions,
  shellSelectValue
} from '@/components/settings/shell-options'

interface ShellSectionProps {
  defaultShell: string
  availableShells: DetectedShells | null
  handleDefaultShellChange: (value: string) => void
}

export function ShellSection({
  defaultShell,
  availableShells,
  handleDefaultShellChange
}: ShellSectionProps): React.JSX.Element {
  const value = shellSelectValue(defaultShell, availableShells)
  const options = shellSelectOptions(value, availableShells, 'System default')
  return (
    <SettingsSection id="shell">
      <SettingsGroup title="Default shell">
        <SettingsCard>
          <SettingsRow
            id={rowId('default-shell')}
            htmlFor="default-shell"
            label="Shell"
            description="A project can choose its own shell in Project settings."
          >
            <SettingsSelect
              id="default-shell"
              aria-describedby={settingsDescriptionId('default-shell')}
              options={options}
              value={value}
              onValueChange={(next) => handleDefaultShellChange(shellFromSelectValue(next))}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </SettingsSection>
  )
}
