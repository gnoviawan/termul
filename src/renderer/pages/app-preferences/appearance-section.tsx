import { SettingsSection } from '@/components/settings/SettingsLayout'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { isTauriContext } from '@/lib/tauri-runtime'
import {
  type AppSettings,
  BUFFER_SIZE_OPTIONS,
  FONT_FAMILY_OPTIONS,
  MAX_TERMINALS_OPTIONS,
  TERMINAL_RENDERER_OPTIONS,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_STEP
} from '@/types/settings'

interface AppearanceSectionProps {
  fontFamily: string
  fontSize: number
  uiZoomLevel: number
  bufferSize: number
  terminalRenderer: AppSettings['terminalRenderer']
  screenReaderMode: boolean
  maxTerminals: number
  handleFontFamilyChange: (value: string) => void
  handleFontSizeChange: (value: number) => void
  handleUiZoomChange: (value: number) => void
  handleUiZoomReset: () => void
  handleBufferSizeChange: (value: number) => void
  handleRendererChange: (value: string) => void
  handleScreenReaderModeChange: (enabled: boolean) => void
  handleMaxTerminalsChange: (value: number) => void
}

export function AppearanceSection({
  fontFamily,
  fontSize,
  uiZoomLevel,
  bufferSize,
  terminalRenderer,
  screenReaderMode,
  maxTerminals,
  handleFontFamilyChange,
  handleFontSizeChange,
  handleUiZoomChange,
  handleUiZoomReset,
  handleBufferSizeChange,
  handleRendererChange,
  handleScreenReaderModeChange,
  handleMaxTerminalsChange
}: AppearanceSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="appearance">
      <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
        <div className="w-full pt-1 md:w-1/3">
          <h2 className="text-lg font-medium text-foreground">Terminal Appearance</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Customize the look and feel of your terminal.
          </p>
        </div>
        <div className="w-full space-y-4 md:w-full md:w-2/3">
          {/* UI Zoom Level (whole interface) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-secondary-foreground">
                UI Zoom Level
              </label>
              <button
                type="button"
                onClick={handleUiZoomReset}
                className="text-xs text-primary hover:underline disabled:opacity-50"
                disabled={uiZoomLevel === UI_ZOOM_DEFAULT}
              >
                Reset to 100%
              </button>
            </div>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={UI_ZOOM_MIN}
                max={UI_ZOOM_MAX}
                step={UI_ZOOM_STEP}
                value={uiZoomLevel}
                onChange={(e) => handleUiZoomChange(parseFloat(e.target.value))}
                className="flex-1 h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <span className="text-sm text-muted-foreground w-14 text-right">
                {Math.round(uiZoomLevel * 100)}%
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {isTauriContext()
                ? 'Zoom the entire interface (50–300%). Also adjustable with Ctrl+=, Ctrl+-, Ctrl+0.'
                : // Web (#858): Ctrl+=/-/0 are the browser zoom keys — the
                  // web defaults bind Alt+=/-/0 instead.
                  'Zoom the entire interface (50–300%). Also adjustable with Alt+=, Alt+-, Alt+0.'}
            </p>
          </div>

          {/* Font Family */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Font Family
            </label>
            <select
              value={fontFamily}
              onChange={(e) => handleFontFamilyChange(e.target.value)}
              className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm pointer-coarse:text-base text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
            >
              {FONT_FAMILY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              Choose a monospace font for terminal text.
            </p>
          </div>

          {/* Font Size */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Font Size: {fontSize}px
            </label>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={10}
                max={24}
                value={fontSize}
                onChange={(e) => handleFontSizeChange(parseInt(e.target.value, 10))}
                className="flex-1 h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <span className="text-sm text-muted-foreground w-12 text-right">{fontSize}px</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Adjust terminal text size (10-24px).
            </p>
          </div>

          {/* Buffer Size */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Scrollback Buffer Size
            </label>
            <select
              value={bufferSize}
              onChange={(e) => handleBufferSizeChange(parseInt(e.target.value, 10))}
              className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm pointer-coarse:text-base text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
            >
              {BUFFER_SIZE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              Number of lines to keep in terminal history. Higher values use more memory. Changes
              apply to new terminals.
            </p>
          </div>

          {/* Max Terminals */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Max Terminals Per Project
            </label>
            <select
              value={maxTerminals}
              onChange={(e) => handleMaxTerminalsChange(parseInt(e.target.value, 10))}
              className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm pointer-coarse:text-base text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
            >
              {MAX_TERMINALS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              Maximum number of terminal tabs allowed per project.
            </p>
          </div>

          {/* Terminal Renderer */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Terminal Renderer
            </label>
            <select
              value={terminalRenderer}
              onChange={(e) => handleRendererChange(e.target.value)}
              className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm pointer-coarse:text-base text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
            >
              {TERMINAL_RENDERER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              GPU-accelerated rendering for terminal output. WebGL provides best performance.
              Changes apply to new terminals.
            </p>
          </div>

          {/* Screen reader mode */}
          <div className="flex min-h-11 items-center justify-between gap-4 rounded-md border border-border bg-secondary/30 px-4 py-3">
            <div className="flex-1">
              <Label htmlFor="terminal-screen-reader-mode">Screen reader mode</Label>
              <p
                id="terminal-screen-reader-mode-help"
                className="mt-0.5 text-xs text-muted-foreground"
              >
                Makes terminal output readable by screen readers. Can repeat typed characters in
                some setups. Changes apply to new terminals.
              </p>
            </div>
            <Switch
              id="terminal-screen-reader-mode"
              aria-describedby="terminal-screen-reader-mode-help"
              checked={screenReaderMode}
              onCheckedChange={handleScreenReaderModeChange}
            />
          </div>

          {/* Preview */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Preview
            </label>
            <div
              className="bg-terminal-bg border border-border rounded-md p-4 text-terminal-fg"
              style={{
                fontFamily: fontFamily,
                fontSize: `${fontSize}px`,
                lineHeight: 1.2
              }}
            >
              <div>$ echo "Hello, World!"</div>
              <div>Hello, World!</div>
              <div>$ ls -la</div>
              <div>drwxr-xr-x 5 user staff 160 Jan 11 10:00 .</div>
            </div>
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}
