import { BrowserAppPolicy } from '@/components/settings/BrowserPolicySettings'
import { SettingsSection } from '@/components/settings/SettingsLayout'

export function BrowserSection(): React.JSX.Element {
  return (
    <SettingsSection id="browser">
      <BrowserAppPolicy />
    </SettingsSection>
  )
}
