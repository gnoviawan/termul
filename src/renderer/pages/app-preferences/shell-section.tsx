import type { DetectedShells } from '@shared/types/ipc.types'
import { SettingsSection } from '@/components/settings/SettingsLayout'

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
      <div className="grid grid-cols-1 items-start gap-6 border-b border-border pb-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="w-full pt-1">
          <h2 className="text-lg font-medium text-foreground">Default Shell</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Set the default shell for new terminals.
          </p>
        </div>
        <div className="w-full space-y-4">
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
              className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
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
