import { rowId } from '@/components/settings/row-id'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { Switch } from '@/components/ui/switch'
import { DEFAULT_APP_SETTINGS, EDITOR_AUTO_SAVE_DELAY_OPTIONS } from '@/types/settings'

interface EditorSectionProps {
  editorAutoSave: boolean
  editorAutoSaveDelayMs: number
  handleEditorAutoSaveToggle: (enabled: boolean) => void
  handleEditorAutoSaveDelayChange: (value: number) => void
}

const DELAY_OPTIONS = EDITOR_AUTO_SAVE_DELAY_OPTIONS.map((option) => ({
  value: String(option.value),
  label: option.label
}))

export function EditorSection({
  editorAutoSave,
  editorAutoSaveDelayMs,
  handleEditorAutoSaveToggle,
  handleEditorAutoSaveDelayChange
}: EditorSectionProps): React.JSX.Element {
  const delay = EDITOR_AUTO_SAVE_DELAY_OPTIONS.some(
    (option) => option.value === editorAutoSaveDelayMs
  )
    ? editorAutoSaveDelayMs
    : DEFAULT_APP_SETTINGS.editorAutoSaveDelayMs
  return (
    <SettingsSection id="editor">
      <SettingsGroup
        title="Saving"
        footnote="Files that already have changes save when you turn auto save on."
      >
        <SettingsCard>
          <SettingsRow
            id={rowId('editor-auto-save')}
            htmlFor="editor-auto-save"
            label="Auto save"
            description="Save files after you stop typing."
            layout="inline"
          >
            <Switch
              id="editor-auto-save"
              aria-describedby={settingsDescriptionId('editor-auto-save')}
              checked={editorAutoSave}
              onCheckedChange={handleEditorAutoSaveToggle}
            />
          </SettingsRow>
          <SettingsRow
            id={rowId('editor-auto-save-delay')}
            htmlFor="editor-auto-save-delay"
            label="Auto save delay"
            description={
              editorAutoSave
                ? 'How long to wait after your last edit.'
                : 'Turn on auto save to choose a delay.'
            }
            indent
            disabled={!editorAutoSave}
          >
            <SettingsSelect
              id="editor-auto-save-delay"
              aria-describedby={settingsDescriptionId('editor-auto-save-delay')}
              options={DELAY_OPTIONS}
              value={String(delay)}
              onValueChange={(value) => handleEditorAutoSaveDelayChange(Number.parseInt(value, 10))}
              disabled={!editorAutoSave}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </SettingsSection>
  )
}
