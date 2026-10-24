import { BrowserProjectPolicy } from '@/components/settings/BrowserPolicySettings'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsNotice } from '@/components/settings/SettingsNotice'

export function ProjectBrowserSection({
  projectId
}: {
  projectId: string | undefined
}): React.JSX.Element {
  return (
    <SettingsSection id="browser">
      {projectId ? (
        <BrowserProjectPolicy key={projectId} projectId={projectId} />
      ) : (
        <SettingsNotice>Open a project to set its browser rules.</SettingsNotice>
      )}
    </SettingsSection>
  )
}
