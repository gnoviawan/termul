import { useId, useRef, useState } from 'react'
import { ChevronRight, Plus, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  blankRow,
  type DraftErrors,
  type KeyValueRow,
  liftEnvPrefix,
  type McpServerDraft,
  type RemoteTransport,
  rowProblem,
  withAuth,
  withUrl
} from '@/lib/mcp-server-draft'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'

const KINDS = [
  {
    kind: 'remote',
    title: 'On the internet',
    description: 'The server is hosted for you. You paste a link and sign in.',
    example: 'https://mcp.linear.app/mcp'
  },
  {
    kind: 'local',
    title: 'On this computer',
    description: 'Termul starts the server with a command, like npx or uvx.',
    example: 'npx -y @modelcontextprotocol/server-github'
  }
] as const

const COMMAND_STARTERS = ['npx -y', 'uvx', 'docker run -i --rm']

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i

const HINT_CLASS = 'text-xs text-muted-foreground'

function FieldMessage({ id, text }: { id: string; text?: string }): React.JSX.Element | null {
  return text ? (
    <p id={id} className="text-xs text-destructive">
      {text}
    </p>
  ) : null
}

function KindPicker({
  kind,
  onChange
}: {
  kind: McpServerDraft['kind']
  onChange: (kind: McpServerDraft['kind']) => void
}): React.JSX.Element {
  const choose = (next: McpServerDraft['kind'], target: HTMLElement | null) => {
    onChange(next)
    target?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label="Where the server runs"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onKeyDown={(event) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
        if (!step) return
        event.preventDefault()
        const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
        const at = KINDS.findIndex((option) => option.kind === kind)
        const nextAt = (at + step + KINDS.length) % KINDS.length
        choose(KINDS[nextAt]?.kind ?? kind, radios[nextAt] ?? null)
      }}
    >
      {KINDS.map((option) => {
        const selected = option.kind === kind
        return (
          // biome-ignore lint/a11y/useSemanticElements: option card, not a native radio input
          <button
            key={option.kind}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.kind)}
            className={cn(
              'flex min-w-0 flex-col gap-1 rounded-xl border p-4 text-left transition-colors duration-150 ease-out',
              selected ? 'keycap border-transparent' : 'border-border hover:bg-foreground/[0.03]',
              FOCUS_RING_CLASS
            )}
          >
            <span className="text-sm font-medium text-foreground">{option.title}</span>
            <span className={HINT_CLASS}>{option.description}</span>
            <span className="mt-1 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {option.example}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function KeyValueRows({
  rows,
  onChange,
  noun,
  namePlaceholder,
  valuePlaceholder
}: {
  rows: KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  noun: 'Header' | 'Environment variable'
  namePlaceholder: string
  valuePlaceholder: string
}): React.JSX.Element {
  const idPrefix = useId()
  const update = (id: string, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const remove = (id: string) => {
    const rest = rows.filter((row) => row.id !== id)
    onChange(rest.length > 0 ? rest : [blankRow()])
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => {
        const label = `${noun} ${index + 1}`
        const problem = rowProblem(row)
        const problemId = `${idPrefix}-${row.id}-problem`
        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <Input
                  aria-label={`${label} name`}
                  value={row.name}
                  onChange={(event) => update(row.id, { name: event.target.value })}
                  placeholder={namePlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={problem === 'Needs a name.'}
                  aria-describedby={problem ? problemId : undefined}
                />
                <Input
                  aria-label={`${label} value`}
                  type={SECRET_NAME.test(row.name) ? 'password' : 'text'}
                  value={row.value}
                  onChange={(event) => update(row.id, { value: event.target.value })}
                  placeholder={valuePlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={problem === 'Needs a value.'}
                  aria-describedby={problem ? problemId : undefined}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${label.toLowerCase()}`}
                onClick={() => remove(row.id)}
              >
                <X size={14} />
              </Button>
            </div>
            {problem ? (
              <p id={problemId} className="text-xs text-warning">
                {problem}
              </p>
            ) : null}
          </div>
        )
      })}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onChange([...rows, blankRow()])}
        >
          <Plus size={13} /> Add
        </Button>
      </div>
    </div>
  )
}

function RemoteFields({
  remote,
  errors,
  onChange
}: {
  remote: McpServerDraft['remote']
  errors: DraftErrors
  onChange: (remote: McpServerDraft['remote']) => void
}): React.JSX.Element {
  const id = useId()
  const headersInAdvanced = remote.auth === 'browser'
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      remote.transportPinned ||
      (headersInAdvanced && remote.headers.some((row) => row.name.trim() !== ''))
  )
  const headers = (
    <KeyValueRows
      rows={remote.headers}
      onChange={(rows) => onChange({ ...remote, headers: rows })}
      noun="Header"
      namePlaceholder={headersInAdvanced ? 'Header name' : 'Authorization'}
      valuePlaceholder={headersInAdvanced ? 'Value' : 'Bearer …'}
    />
  )
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-url`}>Server URL</Label>
        <Input
          id={`${id}-url`}
          value={remote.url}
          onChange={(event) => onChange(withUrl(remote, event.target.value))}
          placeholder="https://mcp.example.com/mcp"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          aria-invalid={Boolean(errors.url)}
          aria-describedby={`${id}-url-hint${errors.url ? ` ${id}-url-error` : ''}`}
        />
        <FieldMessage id={`${id}-url-error`} text={errors.url} />
        <p id={`${id}-url-hint`} className={HINT_CLASS}>
          The address the server's docs give you. It usually ends in{' '}
          <span className="font-mono">/mcp</span> or <span className="font-mono">/sse</span>.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-auth`}>Sign-in</Label>
        <Select
          value={remote.auth}
          onValueChange={(auth) => onChange(withAuth(remote, auth as typeof remote.auth))}
        >
          <SelectTrigger id={`${id}-auth`} aria-describedby={`${id}-auth-hint`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="browser">Browser sign-in, if the server asks</SelectItem>
            <SelectItem value="token">API key or token</SelectItem>
          </SelectContent>
        </Select>
        <p id={`${id}-auth-hint`} className={HINT_CLASS}>
          Most hosted servers (Linear, Notion, Asana) use browser sign-in. Pick API key only if the
          docs give you one.
        </p>
      </div>
      {headersInAdvanced ? null : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium leading-none">Headers</legend>
          {headers}
        </fieldset>
      )}
      <Collapsible
        open={advancedOpen || (headersInAdvanced && Boolean(errors.headers))}
        onOpenChange={setAdvancedOpen}
        className="border-y border-border"
      >
        <CollapsibleTrigger
          className={cn(
            'group flex w-full items-center gap-1.5 rounded-md py-3 text-sm text-secondary-foreground hover:text-foreground',
            FOCUS_RING_CLASS
          )}
        >
          <ChevronRight
            size={14}
            className="transition-transform duration-150 group-data-[state=open]:rotate-90"
          />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-4 pb-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-transport`}>Connection type</Label>
            <Select
              value={remote.transport}
              onValueChange={(transport) =>
                onChange({
                  ...remote,
                  transport: transport as RemoteTransport,
                  transportPinned: true
                })
              }
            >
              <SelectTrigger id={`${id}-transport`} aria-describedby={`${id}-transport-hint`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">Streamable HTTP (recommended)</SelectItem>
                <SelectItem value="sse">SSE (older servers)</SelectItem>
              </SelectContent>
            </Select>
            <p id={`${id}-transport-hint`} className={HINT_CLASS}>
              Picked from the URL. Change it only if the docs say SSE and the URL does not end in
              /sse.
            </p>
          </div>
          {headersInAdvanced ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium leading-none">Custom headers</legend>
              {headers}
            </fieldset>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </>
  )
}

function LocalFields({
  local,
  errors,
  onChange
}: {
  local: McpServerDraft['local']
  errors: DraftErrors
  onChange: (local: McpServerDraft['local']) => void
}): React.JSX.Element {
  const id = useId()
  const commandRef = useRef<HTMLInputElement>(null)
  const start = (starter: string) => {
    const rest = local.commandLine.trimStart()
    const commandLine = rest.startsWith(starter) ? rest : `${starter} ${rest}`
    onChange({ ...local, commandLine })
    requestAnimationFrame(() => {
      const input = commandRef.current
      input?.focus()
      input?.setSelectionRange(commandLine.length, commandLine.length)
    })
  }
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-command`}>Command</Label>
        <Input
          ref={commandRef}
          id={`${id}-command`}
          value={local.commandLine}
          onChange={(event) => onChange({ ...local, commandLine: event.target.value })}
          onBlur={() => {
            const lifted = liftEnvPrefix(local)
            if (lifted !== local) onChange(lifted)
          }}
          placeholder="npx -y @scope/mcp-server"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="font-mono"
          aria-invalid={Boolean(errors.commandLine)}
          aria-describedby={`${id}-command-hint${errors.commandLine ? ` ${id}-command-error` : ''}`}
        />
        <FieldMessage id={`${id}-command-error`} text={errors.commandLine} />
        <p id={`${id}-command-hint`} className={HINT_CLASS}>
          What you would type in a terminal to start the server.{' '}
          {isTauriContext()
            ? 'Termul runs it on this computer.'
            : 'Termul runs it on the computer that hosts this workspace.'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className={HINT_CLASS}>Common:</span>
          {COMMAND_STARTERS.map((starter) => (
            <Button
              key={starter}
              type="button"
              variant="outline"
              size="xs"
              className="font-mono"
              onClick={() => start(starter)}
            >
              {starter} …
            </Button>
          ))}
        </div>
      </div>
      <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-env-hint`}>
        <legend className="mb-2 text-sm font-medium leading-none">Environment variables</legend>
        <KeyValueRows
          rows={local.env}
          onChange={(env) => onChange({ ...local, env })}
          noun="Environment variable"
          namePlaceholder="NAME"
          valuePlaceholder="value"
        />
        <p id={`${id}-env-hint`} className={HINT_CLASS}>
          API keys and settings the server reads. Values stay in Termul's app data. Write{' '}
          <span className="font-mono">$VARIABLE</span> to read one from your shell instead.
        </p>
      </fieldset>
    </>
  )
}

export function McpServerForm({
  formId,
  draft,
  errors,
  onChange,
  onSubmit
}: {
  formId: string
  draft: McpServerDraft
  errors: DraftErrors
  onChange: (draft: McpServerDraft) => void
  onSubmit: () => void
}): React.JSX.Element {
  const id = useId()
  return (
    <form
      id={formId}
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <KindPicker kind={draft.kind} onChange={(kind) => onChange({ ...draft, kind })} />
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="e.g. linear"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={`${id}-name-hint${errors.name ? ` ${id}-name-error` : ''}`}
        />
        <FieldMessage id={`${id}-name-error`} text={errors.name} />
        <p id={`${id}-name-hint`} className={HINT_CLASS}>
          Shown in the server list and in chat tool calls.
        </p>
      </div>
      {draft.kind === 'remote' ? (
        <RemoteFields
          remote={draft.remote}
          errors={errors}
          onChange={(remote) => onChange({ ...draft, remote })}
        />
      ) : (
        <LocalFields
          local={draft.local}
          errors={errors}
          onChange={(local) => onChange({ ...draft, local })}
        />
      )}
    </form>
  )
}
