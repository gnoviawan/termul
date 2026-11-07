import { Link2, Plus, RefreshCw, Trash2 } from '@/components/icons'
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { Button } from '@/components/ui/button'
import { PANEL_FIELD_CLASS, QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

interface SymlinksSectionProps {
  dirs: string[]
  syncing: boolean
  /** Sync reads .gitignore, so it needs a git project. */
  canSync: boolean
  onSync: () => void
  onAdd: () => void
  onChange: (index: number, dir: string) => void
  onRemove: (index: number) => void
}

export function SymlinksSection({
  dirs,
  syncing,
  canSync,
  onSync,
  onAdd,
  onChange,
  onRemove
}: SymlinksSectionProps): React.JSX.Element {
  const actions = (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        onClick={onSync}
        disabled={syncing || !canSync}
      >
        {syncing ? <Spinner size={14} decorative /> : <RefreshCw size={14} />}
        Sync from .gitignore
      </Button>
      <Button type="button" size="sm" className="h-8" onClick={onAdd}>
        <Plus size={14} /> Add directory
      </Button>
    </>
  )

  return (
    <SettingsSection id="symlinks">
      {dirs.length === 0 ? (
        <SettingsEmptyState
          icon={<Link2 size={20} />}
          title="No linked directories"
          description="New worktrees link these from the project root instead of reinstalling them. Sync finds ignored folders such as node_modules."
          action={actions}
        />
      ) : (
        <SettingsGroup
          title={dirs.length === 1 ? '1 directory' : `${dirs.length} directories`}
          actions={actions}
        >
          <SettingsCard>
            {dirs.map((dir, index) => {
              const name = dir || `directory ${index + 1}`
              return (
                <div key={index} className="flex items-center gap-2 px-4 py-2">
                  <input
                    type="text"
                    aria-label={`Path of ${name}`}
                    autoComplete="off"
                    spellCheck={false}
                    value={dir}
                    onChange={(event) => onChange(index, event.target.value)}
                    placeholder="node_modules"
                    className={cn(PANEL_FIELD_CLASS, 'h-8 min-w-0 flex-1 px-2.5 font-mono')}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => onRemove(index)}
                    className={cn(
                      QUIET_ICON_BUTTON_CLASS,
                      'size-8 shrink-0 hover:text-destructive'
                    )}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )
            })}
          </SettingsCard>
        </SettingsGroup>
      )}
    </SettingsSection>
  )
}
