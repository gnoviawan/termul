import { KeyRound } from '@/components/icons'
import { ProviderSettings } from '@/components/settings/provider/ProviderSettings'
import { SettingsSection } from '@/components/settings/SettingsLayout'

export function ProviderSection(): React.JSX.Element {
  return (
    <SettingsSection id="provider">
      <div className="flex flex-col gap-6 border-b border-border pb-6 md:flex-row md:items-start">
        <div className="w-full pt-1 md:w-1/3">
          <div className="flex items-center gap-2">
            <KeyRound size={18} className="text-primary" />
            <h2 className="text-lg font-medium text-foreground">Provider</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            The Claude accounts that Claude Agent chats use, and how much of each limit is used.
          </p>
        </div>
        <div className="w-full md:w-2/3">
          <ProviderSettings />
        </div>
      </div>
    </SettingsSection>
  )
}
