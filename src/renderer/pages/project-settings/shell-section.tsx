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
  /** Stored shell; '' follows the app default. */
  shell: string
  availableShells: DetectedShells | null
  onShellChange: (shell: string) => void
}

export function ShellSection({
  shell,
  availableShells,
  onShellChange
}: ShellSectionProps): React.JSX.Element {
  const value = shellSelectValue(shell, availableShells)
  const options = shellSelectOptions(value, availableShells, 'App default')
  return (
    <SettingsSection id="shell">
      <SettingsGroup title="Default shell">
        <SettingsCard>
          <SettingsRow
            id={rowId('project-default-shell')}
            htmlFor="project-default-shell"
            label="Shell"
            description="App default uses the shell set in Preferences."
          >
            <SettingsSelect
              id="project-default-shell"
              aria-describedby={settingsDescriptionId('project-default-shell')}
              options={options}
              value={value}
              onValueChange={(next) => onShellChange(shellFromSelectValue(next))}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </SettingsSection>
  )
}
