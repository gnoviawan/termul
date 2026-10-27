import { McpCatalogBrowser } from '@/components/settings/McpCatalogBrowser'
import { McpServersSettings } from '@/components/settings/McpServersSettings'
import { SettingsSection } from '@/components/settings/SettingsLayout'

export function McpServersSection(): React.JSX.Element {
  return (
    <SettingsSection id="mcp-servers">
      <McpServersSettings />
      <McpCatalogBrowser />
    </SettingsSection>
  )
}
