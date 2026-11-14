import { useEffect, useId, useState } from 'react'
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
import { codexAccountsApi } from '@/lib/codex-accounts-api'

const MAX_NAME_CHARS = 40

/** Add a signed-out Codex Account. Sign-in is a separate step. */
export function CodexAddAccountDialog({
  open,
  onOpenChange,
  onAdded
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (account: { id: string; name: string }) => Promise<void>
}): React.JSX.Element {
  const inputId = useId()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName('')
      setError(null)
    }
  }, [open])

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter a name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await codexAccountsApi.add(trimmed)
      await onAdded(created)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Add Codex account</DialogTitle>
          <DialogDescription>
            The account starts signed out. You sign it in with ChatGPT next.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-1.5 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Label htmlFor={inputId} className="text-xs">
            Name
          </Label>
          <Input
            id={inputId}
            value={name}
            maxLength={MAX_NAME_CHARS}
            autoFocus
            placeholder="e.g. Work, Personal"
            onChange={(event) => setName(event.target.value)}
            className="h-9"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Adding…' : 'Add account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
