import { Braces, Plus, Trash2, Upload } from '@/components/icons'
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { Button } from '@/components/ui/button'
import { PANEL_FIELD_CLASS, QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import type { EnvVariable } from '@/types/project'

interface EnvVarsSectionProps {
  envVars: EnvVariable[]
  importError: string | null
  importWarnings: string | null
  onImport: () => void
  onAdd: () => void
  onChange: (index: number, patch: Partial<EnvVariable>) => void
  onRemove: (index: number) => void
}

export function EnvVarsSection({
  envVars,
  importError,
  importWarnings,
  onImport,
  onAdd,
  onChange,
  onRemove
}: EnvVarsSectionProps): React.JSX.Element {
  const actions = (
    <>
      <Button type="button" variant="outline" size="sm" className="h-8" onClick={onImport}>
        <Upload size={14} /> Import from .env
      </Button>
      <Button type="button" size="sm" className="h-8" onClick={onAdd}>
        <Plus size={14} /> Add variable
      </Button>
    </>
  )
  const notices = (
    <>
      {importError && <SettingsNotice tone="danger">{importError}</SettingsNotice>}
      {importWarnings && (
        <SettingsNotice tone="warning">
          <span className="whitespace-pre-line">{importWarnings}</span>
        </SettingsNotice>
      )}
    </>
  )

  return (
    <SettingsSection id="env-vars">
      {envVars.length === 0 ? (
        <div className="flex flex-col gap-2">
          {notices}
          <SettingsEmptyState
            icon={<Braces size={20} />}
            title="No environment variables"
            description="Add variables by hand, or import them from the .env file in the project root."
            action={actions}
          />
        </div>
      ) : (
        <SettingsGroup
          title={envVars.length === 1 ? '1 variable' : `${envVars.length} variables`}
          actions={actions}
        >
          {notices}
          <SettingsCard>
            {envVars.map((envVar, index) => {
              const name = envVar.key || `variable ${index + 1}`
              return (
                <div key={index} className="flex items-center gap-2 px-4 py-2">
                  <input
                    type="text"
                    aria-label={`Name of ${name}`}
                    autoComplete="off"
                    spellCheck={false}
                    value={envVar.key}
                    onChange={(event) => onChange(index, { key: event.target.value })}
                    placeholder="KEY"
                    className={cn(PANEL_FIELD_CLASS, 'h-8 w-2/5 min-w-0 px-2.5 font-mono')}
                  />
                  <input
                    type={envVar.isSecret ? 'password' : 'text'}
                    aria-label={`Value of ${name}`}
                    autoComplete="off"
                    spellCheck={false}
                    value={envVar.value}
                    onChange={(event) => onChange(index, { value: event.target.value })}
                    placeholder="value"
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
