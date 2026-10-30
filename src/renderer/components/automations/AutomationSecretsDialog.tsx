import { useCallback, useEffect, useState } from 'react'
import { KeyRound } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  deleteAutomationSecret,
  listAutomationSecrets,
  setAutomationSecret
} from '@/lib/automation-api'

interface AutomationSecretsDialogProps {
  projectId: string
  /** Secret names the automation's graph references. */
  referenced: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Set, replace or delete the project's automation secrets. Values go to the
 * host keyring and are never read back: the dialog only knows which names
 * are set, and it drops a typed value as soon as it is sent.
 */
export function AutomationSecretsDialog({
  projectId,
  referenced,
  open,
  onOpenChange
}: AutomationSecretsDialogProps): React.JSX.Element {
  const [stored, setStored] = useState<Set<string> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const result = await listAutomationSecrets(projectId)
    if (result.success) setStored(new Set(result.data))
    else setError(result.error)
  }, [projectId])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  const names = [...new Set([...referenced, ...(stored ?? [])])].sort()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Secrets</DialogTitle>
          <DialogDescription>
            Kept on the machine that runs this project, in its keychain or, without one, an
            owner-only file. Only HTTP steps can use them, and a saved value is never shown again.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {names.length === 0 ? (
          <p className="text-sm text-muted-foreground">This automation uses no secrets.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {names.map((name) => (
              <SecretRow
                key={name}
                projectId={projectId}
                name={name}
                isSet={stored?.has(name) ?? false}
                isReferenced={referenced.includes(name)}
                onChanged={reload}
                onError={setError}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SecretRow({
  projectId,
  name,
  isSet,
  isReferenced,
  onChanged,
  onError
}: {
  projectId: string
  name: string
  isSet: boolean
  isReferenced: boolean
  onChanged: () => Promise<void>
  onError: (error: string | null) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const inputId = `automation-secret-${name}`

  const save = async (): Promise<void> => {
    const value = draft
    setDraft('')
    setBusy(true)
    const result = await setAutomationSecret(projectId, name, value)
    setBusy(false)
    onError(result.success ? null : result.error)
    if (result.success) {
      setEditing(false)
      await onChanged()
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    const result = await deleteAutomationSecret(projectId, name)
    setBusy(false)
    onError(result.success ? null : result.error)
    if (result.success) await onChanged()
  }

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex min-h-9 items-center gap-2">
        <KeyRound size={14} className="shrink-0 text-muted-foreground" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{name}</code>
        <span className={isSet ? 'text-xs text-success' : 'text-xs text-warning'}>
          {isSet ? 'Saved' : 'Missing'}
        </span>
        {!isReferenced && <span className="text-xs text-muted-foreground">Unused</span>}
        {!editing && (
          <Button
            variant="outline"
            size="xs"
            className="pointer-coarse:h-11"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            {isSet ? 'Replace' : 'Set'}
          </Button>
        )}
        {isSet && !editing && (
          <Button
            variant="ghost"
            size="xs"
            className="text-destructive pointer-coarse:h-11"
            disabled={busy}
            onClick={() => void remove()}
          >
            Delete
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (draft) void save()
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Label htmlFor={inputId} className="text-xs">
              Value for {name}
            </Label>
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="h-9"
              autoFocus
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => {
              setDraft('')
              setEditing(false)
            }}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" className="pointer-coarse:h-11" disabled={!draft || busy}>
            Save
          </Button>
        </form>
      )}
    </li>
  )
}
