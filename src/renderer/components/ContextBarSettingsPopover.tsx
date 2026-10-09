import { Settings } from '@/components/icons'
import { STATUS_BAR_HIT_GLYPH, STATUS_BAR_HIT_TARGET } from '@/components/status-bar-hit'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useUpdateContextBarSetting } from '@/hooks/use-context-bar-settings'
import { cn } from '@/lib/utils'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import type { ContextBarSettings } from '@/types/settings'

interface SettingToggleProps {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

function SettingToggle({ label, checked, onCheckedChange }: SettingToggleProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export function ContextBarSettingsPopover(): React.JSX.Element {
  const settings = useContextBarSettingsStore((state) => state.settings)
  const updateContextBarSetting = useUpdateContextBarSetting()

  const handleToggle = (element: keyof ContextBarSettings): void => {
    void updateContextBarSetting(element)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(STATUS_BAR_HIT_TARGET, 'cursor-pointer')}
          aria-label="Context bar settings"
        >
          <span className={STATUS_BAR_HIT_GLYPH}>
            <Settings size={12} className="shrink-0" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-56">
        <div className="space-y-1">
          <h4 className="font-medium text-sm mb-2">Show in Context Bar</h4>
          <SettingToggle
            label="Git Branch"
            checked={settings.showGitBranch}
            onCheckedChange={() => handleToggle('showGitBranch')}
          />
          <SettingToggle
            label="Git Status"
            checked={settings.showGitStatus}
            onCheckedChange={() => handleToggle('showGitStatus')}
          />
          <SettingToggle
            label="Working Directory"
            checked={settings.showWorkingDirectory}
            onCheckedChange={() => handleToggle('showWorkingDirectory')}
          />
          <SettingToggle
            label="Exit Code"
            checked={settings.showExitCode}
            onCheckedChange={() => handleToggle('showExitCode')}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
