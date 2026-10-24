import type { BrowserActionClass, BrowserPreapproval } from '@shared/types/browser-policy.types'
import { useState } from 'react'
import { Plus, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { BrowserPolicyFailure } from '@/lib/browser-policy-api'
import { ACTION_LABELS, describeFailure } from './browser-policy-copy'
import { SettingsCard, SettingsGroup } from './SettingsGroup'
import { SettingsNotice } from './SettingsNotice'

const ENTRY_CLASS = 'flex min-w-0 items-center gap-3 px-4 py-2.5'
const FORM_CLASS = 'flex flex-col gap-2 px-4 py-3 sm:flex-row'

function EntryList({
  label,
  isEmpty,
  children
}: {
  label: string
  isEmpty: boolean
  children: React.ReactNode
}): React.JSX.Element {
  if (isEmpty) return <p className="px-4 py-3 text-xs text-muted-foreground">None yet.</p>
  return (
    <ul aria-label={`${label} list`} className="divide-y divide-border">
      {children}
    </ul>
  )
}

function RemoveButton({
  label,
  disabled,
  onClick
}: {
  label: string
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className="size-7 text-muted-foreground"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
    >
      <X size={14} />
    </Button>
  )
}

function AddButton({ disabled }: { disabled: boolean }): React.JSX.Element {
  return (
    <Button type="submit" size="sm" variant="secondary" disabled={disabled}>
      <Plus size={14} />
      Add
    </Button>
  )
}

interface EditorShellProps {
  id: string
  label: string
  description: string
  error: string | null
  children: React.ReactNode
}

function EditorShell({
  id,
  label,
  description,
  error,
  children
}: EditorShellProps): React.JSX.Element {
  return (
    <SettingsGroup id={id} title={label} footnote={description} className="scroll-mt-4">
      <SettingsCard>{children}</SettingsCard>
      {error && (
        <SettingsNotice tone="danger" role="alert">
          {error}
        </SettingsNotice>
      )}
    </SettingsGroup>
  )
}

/** Runs one list edit and tracks the busy flag and the failure sentence. */
function useListEdit(): {
  busy: boolean
  error: string | null
  run: (edit: () => Promise<BrowserPolicyFailure | null>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (edit: () => Promise<BrowserPolicyFailure | null>): Promise<boolean> => {
    setBusy(true)
    const failure = await edit()
    setBusy(false)
    setError(failure ? describeFailure(failure) : null)
    return failure === null
  }
  return { busy, error, run }
}

interface OriginListEditorProps {
  /** Anchor id for settings search. */
  id: string
  label: string
  description: string
  placeholder: string
  entries: string[]
  disabled: boolean
  onAdd: (origin: string) => Promise<BrowserPolicyFailure | null>
  onRemove: (origin: string) => Promise<BrowserPolicyFailure | null>
}

/** A list of origins with a field to add one. */
export function OriginListEditor({
  id,
  label,
  description,
  placeholder,
  entries,
  disabled,
  onAdd,
  onRemove
}: OriginListEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const { busy, error, run } = useListEdit()

  const submit = async (): Promise<void> => {
    const origin = draft.trim()
    if (!origin) return
    if (await run(() => onAdd(origin))) setDraft('')
  }

  return (
    <EditorShell id={id} label={label} description={description} error={error}>
      <EntryList label={label} isEmpty={entries.length === 0}>
        {entries.map((origin) => (
          <li key={origin} className={ENTRY_CLASS}>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {origin}
            </span>
            <RemoveButton
              label={`Remove ${origin}`}
              disabled={disabled || busy}
              onClick={() => void run(() => onRemove(origin))}
            />
          </li>
        ))}
      </EntryList>
      <form
        className={FORM_CLASS}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Input
          aria-label={label}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 font-mono text-sm"
        />
        <AddButton disabled={disabled || busy || !draft.trim()} />
      </form>
    </EditorShell>
  )
}

interface PreapprovalEditorProps {
  /** Anchor id for settings search. */
  id: string
  label: string
  description: string
  /** Action classes the scope may pre-approve. */
  actions: readonly BrowserActionClass[]
  entries: BrowserPreapproval[]
  disabled: boolean
  onAdd: (preapproval: BrowserPreapproval) => Promise<BrowserPolicyFailure | null>
  onRemove: (preapproval: BrowserPreapproval) => Promise<BrowserPolicyFailure | null>
}

/** Pre-approvals keyed by (action, origin), with a form to add one. */
export function PreapprovalEditor({
  id,
  label,
  description,
  actions,
  entries,
  disabled,
  onAdd,
  onRemove
}: PreapprovalEditorProps): React.JSX.Element {
  const [action, setAction] = useState<BrowserActionClass>(actions[0])
  const [origin, setOrigin] = useState('')
  const { busy, error, run } = useListEdit()

  const submit = async (): Promise<void> => {
    const trimmed = origin.trim()
    if (!trimmed) return
    if (await run(() => onAdd({ action, origin: trimmed }))) setOrigin('')
  }

  return (
    <EditorShell id={id} label={label} description={description} error={error}>
      <EntryList label={label} isEmpty={entries.length === 0}>
        {entries.map((entry) => (
          <li key={`${entry.action}|${entry.origin}`} className={ENTRY_CLASS}>
            <span className="min-w-0 flex-1 text-xs text-foreground">
              <span>{ACTION_LABELS[entry.action]}</span>
              <span className="text-muted-foreground"> on </span>
              <span className="break-all font-mono">{entry.origin}</span>
            </span>
            <RemoveButton
              label={`Remove ${ACTION_LABELS[entry.action]} on ${entry.origin}`}
              disabled={disabled || busy}
              onClick={() => void run(() => onRemove(entry))}
            />
          </li>
        ))}
      </EntryList>
      <form
        className={FORM_CLASS}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Select
          value={action}
          onValueChange={(value) => setAction(value as BrowserActionClass)}
          disabled={disabled}
        >
          <SelectTrigger className="h-9 sm:w-60" aria-label="Action to pre-approve">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {actions.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                {ACTION_LABELS[candidate]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label={label}
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://example.com"
          disabled={disabled}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 font-mono text-sm"
        />
        <AddButton disabled={disabled || busy || !origin.trim()} />
      </form>
    </EditorShell>
  )
}
