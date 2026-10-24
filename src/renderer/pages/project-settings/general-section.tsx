import { ColorSwatchGroup } from '@/components/settings/ColorSwatchGroup'
import { rowId } from '@/components/settings/row-id'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ProjectColor } from '@/types/project'
import { SETTINGS_FIELD_CLASS } from './field-class'

interface GeneralSectionProps {
  name: string
  rootPath: string
  color: ProjectColor
  onNameChange: (name: string) => void
  onRootPathChange: (path: string) => void
  onBrowseRootPath: () => void
  onColorChange: (color: ProjectColor) => void
}

export function GeneralSection({
  name,
  rootPath,
  color,
  onNameChange,
  onRootPathChange,
  onBrowseRootPath,
  onColorChange
}: GeneralSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="general">
      <SettingsGroup title="Project">
        <SettingsCard>
          <SettingsRow id={rowId('project-name')} htmlFor="project-name" label="Name">
            <input
              id="project-name"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              className={SETTINGS_FIELD_CLASS}
            />
          </SettingsRow>
          <SettingsRow
            id={rowId('project-root-directory')}
            htmlFor="project-root-directory"
            label="Root directory"
            description="Changing it only affects new terminals."
          >
            <input
              id="project-root-directory"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={settingsDescriptionId('project-root-directory')}
              value={rootPath}
              onChange={(event) => onRootPathChange(event.target.value)}
              className={cn(SETTINGS_FIELD_CLASS, 'min-w-0 font-mono')}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={onBrowseRootPath}
            >
              Browse
            </Button>
          </SettingsRow>
          <SettingsRow
            id={rowId('project-color')}
            describes="project-color"
            label="Color"
            description="Marks this project in the sidebar."
          >
            <ColorSwatchGroup
              aria-label="Project color"
              aria-describedby={settingsDescriptionId('project-color')}
              value={color}
              onValueChange={onColorChange}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </SettingsSection>
  )
}
