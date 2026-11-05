import { rowId } from '@/components/settings/row-id'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { SettingsStepper } from '@/components/settings/SettingsStepper'
import { Switch } from '@/components/ui/switch'
import { MONO_STACK } from '@/lib/font-stacks'
import {
  type AppSettings,
  BUFFER_SIZE_OPTIONS,
  TERMINAL_RENDERER_OPTIONS,
  TERMINAL_URL_OPEN_MODE_OPTIONS,
  type TerminalUrlOpenMode
} from '@/types/settings'

interface AppearanceSectionProps {
  fontSize: number
  bufferSize: number
  terminalRenderer: AppSettings['terminalRenderer']
  screenReaderMode: boolean
  terminalUrlOpenMode: TerminalUrlOpenMode
  handleFontSizeChange: (value: number) => void
  handleBufferSizeChange: (value: number) => void
  handleRendererChange: (value: string) => void
  handleScreenReaderModeChange: (enabled: boolean) => void
  handleTerminalUrlOpenModeChange: (value: string) => void
}

const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 24

const BUFFER_OPTIONS = BUFFER_SIZE_OPTIONS.map((option) => ({
  value: String(option.value),
  label: option.label
}))

export function AppearanceSection({
  fontSize,
  bufferSize,
  terminalRenderer,
  screenReaderMode,
  terminalUrlOpenMode,
  handleFontSizeChange,
  handleBufferSizeChange,
  handleRendererChange,
  handleScreenReaderModeChange,
  handleTerminalUrlOpenModeChange
}: AppearanceSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="appearance">
      <SettingsGroup title="Text">
        <SettingsCard>
          <SettingsRow
            id={rowId('terminal-font-size')}
            label="Font size"
            describes="terminal-font-size"
            description={`Terminal text size, from ${FONT_SIZE_MIN} to ${FONT_SIZE_MAX} px.`}
          >
            <SettingsStepper
              role="group"
              aria-label="Font size"
              aria-describedby={settingsDescriptionId('terminal-font-size')}
              value={fontSize}
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              onValueChange={handleFontSizeChange}
              format={(value) => `${value} px`}
              decrementLabel="Decrease font size"
              incrementLabel="Increase font size"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup
        title="Rendering"
        footnote="Renderer, scrollback and screen reader changes apply to new terminals."
      >
        <SettingsCard>
          <SettingsRow
            id={rowId('terminal-renderer')}
            htmlFor="terminal-renderer"
            label="Renderer"
            description="WebGL is fastest. Auto falls back to DOM when WebGL is not available."
          >
            <SettingsSelect
              id="terminal-renderer"
              aria-describedby={settingsDescriptionId('terminal-renderer')}
              options={TERMINAL_RENDERER_OPTIONS}
              value={terminalRenderer}
              onValueChange={handleRendererChange}
            />
          </SettingsRow>
          <SettingsRow
            id={rowId('terminal-scrollback')}
            htmlFor="terminal-scrollback"
            label="Scrollback"
            description="Lines kept in terminal history. More lines use more memory."
          >
            <SettingsSelect
              id="terminal-scrollback"
              aria-describedby={settingsDescriptionId('terminal-scrollback')}
              options={BUFFER_OPTIONS}
              value={String(bufferSize)}
              onValueChange={(value) => handleBufferSizeChange(Number.parseInt(value, 10))}
            />
          </SettingsRow>
          <SettingsRow
            id={rowId('terminal-screen-reader-mode')}
            htmlFor="terminal-screen-reader-mode"
            label="Screen reader mode"
            description="Makes terminal output readable by screen readers. Can repeat typed characters in some setups. Changes apply to new terminals."
            layout="inline"
          >
            <Switch
              id="terminal-screen-reader-mode"
              aria-describedby={settingsDescriptionId('terminal-screen-reader-mode')}
              checked={screenReaderMode}
              onCheckedChange={handleScreenReaderModeChange}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title="Links">
        <SettingsCard>
          <SettingsRow
            id={rowId('terminal-url-open-mode')}
            htmlFor="terminal-url-open-mode"
            label="Open links in"
            description="Where Ctrl/Cmd+Click on a URL in terminal output opens."
          >
            <SettingsSelect
              id="terminal-url-open-mode"
              aria-describedby={settingsDescriptionId('terminal-url-open-mode')}
              options={TERMINAL_URL_OPEN_MODE_OPTIONS}
              value={terminalUrlOpenMode}
              onValueChange={handleTerminalUrlOpenModeChange}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title="Preview">
        <div
          className="rounded-lg border border-border bg-terminal-bg p-4 text-terminal-fg"
          style={{ fontFamily: MONO_STACK, fontSize: `${fontSize}px`, lineHeight: 1.2 }}
        >
          <div>$ echo "Hello, World!"</div>
          <div>Hello, World!</div>
          <div>$ ls -la</div>
          <div>drwxr-xr-x 5 user staff 160 Jan 11 10:00 .</div>
        </div>
      </SettingsGroup>
    </SettingsSection>
  )
}
