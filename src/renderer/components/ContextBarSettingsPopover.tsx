import { Settings } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import { CONTEXT_BAR_SETTINGS_KEY } from '@/types/settings'
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
  const toggleElement = useContextBarSettingsStore((state) => state.toggleElement)

  const handleToggle = (element: keyof ContextBarSettings): void => {
    toggleElement(element)
    // Persist to disk with debounce
    const newSettings = { ...settings, [element]: !settings[element] }
    window.api.persistence.writeDebounced(CONTEXT_BAR_SETTINGS_KEY, newSettings)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex items-center hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors"
          aria-label="Context bar settings"
        >
          <Settings size={14} />
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
