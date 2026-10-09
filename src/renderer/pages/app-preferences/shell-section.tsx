import type { DetectedShells } from '@shared/types/ipc.types'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { PANEL_FIELD_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

interface ShellSectionProps {
  defaultShell: string
  availableShells: DetectedShells | null
  handleDefaultShellChange: (value: string) => void
}

export function ShellSection({
  defaultShell,
  availableShells,
  handleDefaultShellChange
}: ShellSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="shell">
      <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
        <div className="w-full pt-1 md:w-1/3">
          <h2 className="text-lg font-medium text-foreground">Default Shell</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Set the default shell for new terminals.
          </p>
        </div>
        <div className="w-full space-y-4 md:w-full md:w-2/3">
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Shell
            </label>
            <select
              value={(() => {
                // Normalize the stored defaultShell for display
                // If it's a path, use it directly; if it's a name, find matching shell's path
                if (!defaultShell) return ''
                if (defaultShell.includes('\\') || defaultShell.includes('/')) {
                  return defaultShell
                }
                // Find shell by name or by basename of path
                const match = availableShells?.available.find((s) => {
                  if (s.name === defaultShell) return true
                  const pathBasename = s.path.split(/[\\/]/).pop()
                  return pathBasename === defaultShell
                })
                return match?.path ?? defaultShell
              })()}
              onChange={(e) => handleDefaultShellChange(e.target.value)}
              className={cn(PANEL_FIELD_CLASS, 'w-full px-3 py-2 text-sm')}
            >
              <option value="">System Default</option>
              {availableShells?.available?.map((shell) => (
                <option key={shell.path} value={shell.path}>
                  {shell.displayName}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              This can be overridden per-project in project settings.
            </p>
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}
