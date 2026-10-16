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

const MAX_NAME_CHARS = 40

interface AccountNameDialogProps {
  open: boolean
  initialName?: string
  onOpenChange: (open: boolean) => void
  /** Resolves when the host accepted the name; a rejection keeps the dialog open. */
  onSubmit: (name: string) => Promise<void>
}

/** Rename an Account. Adding one uses `AddAccountDialog`. */
export function AccountNameDialog({
  open,
  initialName = '',
  onOpenChange,
  onSubmit
}: AccountNameDialogProps): React.JSX.Element {
  const inputId = useId()
  const [name, setName] = useState(initialName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName(initialName)
      setError(null)
    }
  }, [open, initialName])

  const trimmed = name.trim()

  const submit = async (): Promise<void> => {
    if (!trimmed) {
      setError('Enter a name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSubmit(trimmed)
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
          <DialogTitle>Rename account</DialogTitle>
          <DialogDescription>
            Termul shows this name instead of the email address.
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
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
