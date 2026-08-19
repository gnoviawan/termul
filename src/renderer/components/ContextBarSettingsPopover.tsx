import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useUpdateContextBarSetting } from '@/hooks/use-context-bar-settings'
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
  const { t } = useTranslation('shell')
  const settings = useContextBarSettingsStore((state) => state.settings)
  const updateContextBarSetting = useUpdateContextBarSetting()

  const handleToggle = (element: keyof ContextBarSettings): void => {
    void updateContextBarSetting(element)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex items-center hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors"
          aria-label={t('contextBar.settings')}
        >
          <Settings size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-56">
        <div className="space-y-1">
          <h4 className="font-medium text-sm mb-2">{t('contextBar.showInBar')}</h4>
          <SettingToggle
            label={t('contextBar.gitBranch')}
            checked={settings.showGitBranch}
            onCheckedChange={() => handleToggle('showGitBranch')}
          />
          <SettingToggle
            label={t('contextBar.gitStatus')}
            checked={settings.showGitStatus}
            onCheckedChange={() => handleToggle('showGitStatus')}
          />
          <SettingToggle
            label={t('contextBar.workingDirectory')}
            checked={settings.showWorkingDirectory}
            onCheckedChange={() => handleToggle('showWorkingDirectory')}
          />
          <SettingToggle
            label={t('contextBar.exitCode')}
            checked={settings.showExitCode}
            onCheckedChange={() => handleToggle('showExitCode')}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
