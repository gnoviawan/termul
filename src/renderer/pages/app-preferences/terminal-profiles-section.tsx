import type { DetectedShells } from '@shared/types/ipc.types'
import { useId, useState } from 'react'
import { Pencil, Plus, Terminal, TerminalSquare, Trash2 } from '@/components/icons'
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { showUndoToast } from '@/components/settings/undo-toast'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useUpdateAppSetting } from '@/hooks/use-app-settings'
import { logFrontendError } from '@/lib/log-api'
import {
  EMPTY_TERMINAL_PROFILE_DRAFT,
  parseTerminalProfileDraft,
  type TerminalProfileDraft,
  type TerminalProfileDraftErrors,
  terminalProfileCommandLine,
  terminalProfileToDraft
} from '@/lib/terminal-profiles'
import { useAppSettingsLoaded, useAppSettingsStore } from '@/stores/app-settings-store'
import type { TerminalProfile } from '@/types/settings'

// Radix Select reserves the empty string, so the default shell needs a value of its own.
const DEFAULT_SHELL_VALUE = '__default__'
const OTHER_SHELL_VALUE = '__other__'

type EditorState = { mode: 'add' } | { mode: 'edit'; profile: TerminalProfile }

interface TerminalProfilesSectionProps {
  availableShells: DetectedShells | null
}

export function TerminalProfilesSection({
  availableShells
}: TerminalProfilesSectionProps): React.JSX.Element {
  const profiles = useAppSettingsStore((state) => state.settings.terminalProfiles)
  const isLoaded = useAppSettingsLoaded()
  const updateSetting = useUpdateAppSetting()
  const [editor, setEditor] = useState<EditorState | null>(null)

  const save = async (profile: TerminalProfile): Promise<void> => {
    const exists = profiles.some((entry) => entry.id === profile.id)
    const next = exists
      ? profiles.map((entry) => (entry.id === profile.id ? profile : entry))
      : [...profiles, profile]
    await updateSetting('terminalProfiles', next)
    setEditor(null)
  }

  const remove = (profile: TerminalProfile): void => {
    const index = profiles.findIndex((entry) => entry.id === profile.id)
    void updateSetting(
      'terminalProfiles',
      profiles.filter((entry) => entry.id !== profile.id)
    )
    void logFrontendError({
      level: 'info',
      source: 'TerminalProfilesSection.delete',
      message: 'Terminal profile deleted; undo offered'
    })
    showUndoToast(`Deleted ${profile.name}`, () => {
      const current = useAppSettingsStore.getState().settings.terminalProfiles
      if (current.some((entry) => entry.id === profile.id)) return
      const restored = [...current]
      restored.splice(Math.min(index, restored.length), 0, profile)
      void updateSetting('terminalProfiles', restored)
      void logFrontendError({
        level: 'info',
        source: 'TerminalProfilesSection.undoDelete',
        message: 'Terminal profile restored by undo'
      })
    })
  }

  const addButton = (
    <Button type="button" size="sm" disabled={!isLoaded} onClick={() => setEditor({ mode: 'add' })}>
      <Plus size={14} /> Add profile
    </Button>
  )

  return (
    <SettingsSection id="terminal-profiles">
      {profiles.length === 0 ? (
        <SettingsEmptyState
          icon={<Terminal size={20} />}
          title="No terminal profiles"
          description="A profile opens a terminal with your shell, folder and variables in one step."
          action={addButton}
        />
      ) : (
        <SettingsGroup
          title={profiles.length === 1 ? '1 profile' : `${profiles.length} profiles`}
          actions={addButton}
        >
          <SettingsCard>
            {profiles.map((profile) => (
              <div key={profile.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-secondary-foreground"
                >
                  <TerminalSquare size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{profile.name}</div>
                  <div className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
                    <span
                      className="truncate font-mono"
                      title={terminalProfileCommandLine(profile)}
                    >
                      {terminalProfileCommandLine(profile)}
                    </span>
                    {profile.cwd && (
                      <span className="hidden min-w-0 truncate sm:inline" title={profile.cwd}>
                        · {profile.cwd}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  onClick={() => setEditor({ mode: 'edit', profile })}
                  aria-label={`Edit ${profile.name}`}
                >
                  <Pencil size={14} />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  onClick={() => remove(profile)}
                  aria-label={`Delete ${profile.name}`}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </SettingsCard>
        </SettingsGroup>
      )}
      {editor && (
        <TerminalProfileDialog
          key={editor.mode === 'edit' ? editor.profile.id : 'add'}
          profile={editor.mode === 'edit' ? editor.profile : null}
          availableShells={availableShells}
          onSave={save}
          onClose={() => setEditor(null)}
        />
      )}
    </SettingsSection>
  )
}

interface TerminalProfileDialogProps {
  /** `null` creates a new profile. */
  profile: TerminalProfile | null
  availableShells: DetectedShells | null
  onSave: (profile: TerminalProfile) => Promise<void>
  onClose: () => void
}

function TerminalProfileDialog({
  profile,
  availableShells,
  onSave,
  onClose
}: TerminalProfileDialogProps): React.JSX.Element {
  const baseId = useId()
  const fieldId = (field: keyof TerminalProfileDraft): string => `${baseId}-${field}`
  const [draft, setDraft] = useState<TerminalProfileDraft>(
    profile ? terminalProfileToDraft(profile) : EMPTY_TERMINAL_PROFILE_DRAFT
  )
  const [errors, setErrors] = useState<TerminalProfileDraftErrors>({})
  const [saving, setSaving] = useState(false)

  const shells = availableShells?.available ?? []
  const [otherShell, setOtherShell] = useState(
    () => draft.shell !== '' && !shells.some((shell) => shell.path === draft.shell)
  )

  const update = (field: keyof TerminalProfileDraft, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const submit = async (): Promise<void> => {
    const parsed = parseTerminalProfileDraft(draft, profile?.id)
    if (!parsed.ok) {
      setErrors(parsed.errors)
      return
    }
    setErrors({})
    setSaving(true)
    try {
      await onSave(parsed.profile)
    } finally {
      setSaving(false)
    }
  }

  const errorText = (field: keyof TerminalProfileDraftErrors): React.JSX.Element | null =>
    errors[field] ? (
      <p id={`${fieldId(field)}-error`} role="alert" className="text-xs text-destructive">
        {errors[field]}
      </p>
    ) : null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{profile ? 'Edit terminal profile' : 'New terminal profile'}</DialogTitle>
          <DialogDescription>
            Empty fields use what New Terminal uses: the default shell and the active folder.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={fieldId('name')} className="text-xs">
              Name
            </Label>
            <Input
              id={fieldId('name')}
              value={draft.name}
              onChange={(event) => update('name', event.target.value)}
              placeholder="e.g. Node dev"
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? `${fieldId('name')}-error` : undefined}
              className="h-9"
            />
            {errorText('name')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fieldId('shell')} className="text-xs">
              Shell
            </Label>
            <Select
              value={otherShell ? OTHER_SHELL_VALUE : draft.shell || DEFAULT_SHELL_VALUE}
              onValueChange={(value) => {
                setOtherShell(value === OTHER_SHELL_VALUE)
                if (value !== OTHER_SHELL_VALUE) {
                  update('shell', value === DEFAULT_SHELL_VALUE ? '' : value)
                }
              }}
            >
              <SelectTrigger id={fieldId('shell')} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_SHELL_VALUE}>Default shell</SelectItem>
                {shells.map((shell) => (
                  <SelectItem key={shell.path} value={shell.path}>
                    {shell.displayName}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER_SHELL_VALUE}>Other path or name</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {otherShell && (
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId('shell')}-path`} className="text-xs">
                Shell path or name
              </Label>
              <Input
                id={`${fieldId('shell')}-path`}
                value={draft.shell}
                onChange={(event) => update('shell', event.target.value)}
                placeholder="e.g. nu or C:\tools\nu.exe"
                className="h-9 font-mono"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={fieldId('args')} className="text-xs">
              Arguments
            </Label>
            <Textarea
              id={fieldId('args')}
              rows={3}
              value={draft.args}
              onChange={(event) => update('args', event.target.value)}
              placeholder={'-NoProfile'}
              aria-invalid={Boolean(errors.args)}
              aria-describedby={`${fieldId('args')}-help`}
              className="font-mono"
            />
            <p id={`${fieldId('args')}-help`} className="text-xs text-muted-foreground">
              One argument per line. Each line reaches the shell as one argument.
            </p>
            {errorText('args')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fieldId('cwd')} className="text-xs">
              Start folder
            </Label>
            <Input
              id={fieldId('cwd')}
              value={draft.cwd}
              onChange={(event) => update('cwd', event.target.value)}
              placeholder="Active project or worktree folder"
              className="h-9 font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fieldId('env')} className="text-xs">
              Environment variables
            </Label>
            <Textarea
              id={fieldId('env')}
              rows={4}
              value={draft.env}
              onChange={(event) => update('env', event.target.value)}
              placeholder="NODE_ENV=development"
              aria-invalid={Boolean(errors.env)}
              aria-describedby={`${fieldId('env')}-help`}
              className="font-mono"
            />
            <p id={`${fieldId('env')}-help`} className="text-xs text-muted-foreground">
              One KEY=value per line. They override project variables of the same name and are saved
              in plain text with your settings, so keep secrets out.
            </p>
            {errorText('env')}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
