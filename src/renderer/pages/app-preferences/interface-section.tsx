import { ColorSwatchGroup } from '@/components/settings/ColorSwatchGroup'
import { rowId } from '@/components/settings/row-id'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { SettingsStepper } from '@/components/settings/SettingsStepper'
import { isTauriContext } from '@/lib/tauri-runtime'
import type { ProjectColor } from '@/types/project'
import { UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN, UI_ZOOM_STEP } from '@/types/settings'

interface InterfaceSectionProps {
  uiZoomLevel: number
  defaultProjectColor: ProjectColor
  handleUiZoomChange: (value: number) => void
  handleDefaultProjectColorChange: (value: ProjectColor) => void
}

export function InterfaceSection({
  uiZoomLevel,
  defaultProjectColor,
  handleUiZoomChange,
  handleDefaultProjectColorChange
}: InterfaceSectionProps): React.JSX.Element {
  // Web (#858): Ctrl+=/-/0 are the browser zoom keys; the web defaults use Alt.
  const zoomKeys = isTauriContext() ? 'Ctrl+=, Ctrl+- and Ctrl+0' : 'Alt+=, Alt+- and Alt+0'
  return (
    <SettingsSection id="interface">
      <SettingsGroup title="Display">
        <SettingsCard>
          <SettingsRow
            id={rowId('ui-zoom')}
            label="Interface zoom"
            describes="ui-zoom"
            description={`Make everything larger or smaller, from 50% to 300%. ${zoomKeys} also work.`}
          >
            <SettingsStepper
              role="group"
              aria-label="Interface zoom"
              aria-describedby={settingsDescriptionId('ui-zoom')}
              value={uiZoomLevel}
              min={UI_ZOOM_MIN}
              max={UI_ZOOM_MAX}
              step={UI_ZOOM_STEP}
              onValueChange={handleUiZoomChange}
              format={(value) => `${Math.round(value * 100)}%`}
              decrementLabel="Decrease interface zoom"
              incrementLabel="Increase interface zoom"
              resetValue={UI_ZOOM_DEFAULT}
              resetLabel="Reset to 100%"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="New projects">
        <SettingsCard>
          <SettingsRow
            id={rowId('default-project-color')}
            label="Default color"
            description="New projects start with this color. You can change it per project."
          >
            <ColorSwatchGroup
              aria-label="Default project color"
              value={defaultProjectColor}
              onValueChange={handleDefaultProjectColorChange}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </SettingsSection>
  )
}
