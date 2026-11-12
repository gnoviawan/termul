import type {
  AutomationDetail,
  AutomationOp,
  Edge,
  Issue,
  NodeKind
} from '@shared/types/automation.types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { AlertCircle, ArrowLeft, ChevronDown, ChevronUp, Loader2, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { approveAutomation } from '@/lib/automation-api'
import { cn } from '@/lib/utils'
import { automationState, STATE_PRESENTATION } from '../automation-format'
import type { ConnectRefusal } from './draft/apply-op'
import { addGesture, movePatch, removeGesture } from './draft/gestures'
import { useDraft } from './draft/use-draft'
import { AutomationFlow } from './flow/AutomationFlow'
import type { AddRequest, FlowEdit } from './flow/flow-edit'
import { AddNodeMenu } from './palette/AddNodeMenu'
import { chainPort, NODE_KINDS, newNode } from './palette/node-kinds'

const NO_CHAIN = (Object.keys(NODE_KINDS) as NodeKind[]).filter((kind) => chainPort(kind) === null)

const SAVING = 'Saving. Try that again once it finishes.'

const REFUSALS: Record<ConnectRefusal, string> = {
  illegal_port: 'That step has no such port.',
  duplicate_edge: 'Those ports are already connected.',
  cycle: 'That edge would make a loop.',
  unknown_node: 'That step no longer exists.'
}

function describeOp(op: AutomationOp, label: (id: string) => string): string {
  const edge = (e: Edge) =>
    `${label(e.from)} → ${label(e.to)}${e.port === 'out' ? '' : ` (${e.port})`}`
  switch (op.op) {
    case 'add_node':
      return `Add ${op.node.label}`
    case 'update_node':
      return `Edit ${label(op.id)}`
    case 'remove_node':
      return `Delete ${label(op.id)}`
    case 'connect':
      return `Connect ${edge(op.edge)}`
    case 'disconnect':
      return `Disconnect ${edge(op.edge)}`
    case 'set_trigger':
      return 'Change the trigger'
    case 'rename':
      return `Rename to ${op.name}`
    case 'set_isolation':
      return 'Change the isolation'
  }
}

/** The phone header has room only for the count beside the state pill at 390 px. */
function changesLabel(count: number, phone: boolean): string {
  if (count === 0) return 'No unsaved changes'
  if (phone) return `${count} unsaved`
  return `Draft · ${count} unsaved ${count === 1 ? 'change' : 'changes'}`
}

/**
 * The automation canvas in edit mode, at full pane size: the draft's header
 * (unsaved count, Discard, Save, Approve), the canvas and its toolbar, and
 * the Issues dock. Edits stay in the draft until Save.
 */
export function AutomationEditor({
  detail,
  phone,
  onClose,
  onChanged,
  leave = null,
  onStay
}: {
  detail: AutomationDetail
  phone: boolean
  onClose: () => void
  onChanged: () => void
  /** Something else asks to take the pane: close, after a discard confirm when there are edits. */
  leave?: { nonce: number } | null
  /** The user kept their edits instead of leaving. */
  onStay?: () => void
}): React.JSX.Element {
  const editor = useDraft(detail, onChanged)
  const { draft } = editor
  const [confirmClose, setConfirmClose] = useState(false)
  const [approving, setApproving] = useState(false)
  // Each request gets its own id: the menu is keyed by it, and only that request's menu may close it.
  const [adding, setAdding] = useState<{ id: number; request: AddRequest } | null>(null)
  const requests = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  // Undo and redo listen on the editor root, so it takes focus when the editor opens.
  useEffect(() => root.current?.focus({ preventScroll: true }), [])
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null)
  const automation = draft.base
  const count = draft.pending.length
  const dirty = count > 0
  const state = STATE_PRESENTATION[automationState(automation)]
  const needsApproval = automation.approved_revision !== automation.revision
  // Every label seen this session: a dropped edit can name a step the new head no longer has.
  const seen = useRef(new Map<string, string>())
  for (const node of [...draft.base.graph.nodes, ...draft.doc.graph.nodes]) {
    seen.current.set(node.id, node.label)
  }
  const labels = (nodeId: string): string =>
    nodeId === 'trigger' ? 'Trigger' : (seen.current.get(nodeId) ?? nodeId)

  const { graph, trigger } = draft.doc
  const shown = useMemo(
    () => ({ graph, trigger, layout: draft.layout }),
    [graph, trigger, draft.layout]
  )

  /** Applies a gesture; says why when it cannot. */
  const apply = (
    ops: Parameters<typeof editor.apply>[0],
    layout?: Parameters<typeof editor.apply>[1],
    refused?: () => void
  ): boolean => {
    const refusal = editor.apply(ops, layout)
    if (!refusal) return true
    if (refusal.code === 'saving') toast(SAVING)
    else if (refused) refused()
    else toast.error(`The host would refuse that edit: ${refusal.code}`)
    return false
  }

  const add = (kind: NodeKind, placement: Omit<AddRequest, 'screen'>): void => {
    const node = newNode(kind, graph)
    const { ops, layout } = addGesture(graph, draft.layout, node, chainPort(kind), placement)
    if (apply(ops, layout)) setFocus({ id: node.id, nonce: Date.now() })
  }

  const edit: FlowEdit = {
    connect: (edge) => {
      apply([{ op: 'connect', edge }], {}, () => toast(REFUSALS.duplicate_edge))
    },
    refused: (reason) => toast(REFUSALS[reason]),
    move: (moved) => {
      const patch = movePatch(graph, draft.layout, moved)
      if (patch) apply([], patch)
    },
    remove: (nodes, edges) => {
      const { ops, layout } = removeGesture(graph, draft.layout, nodes, edges)
      if (ops.length > 0) apply(ops, layout)
    },
    requestAdd: (request) => {
      if (editor.saving) return
      requests.current += 1
      setAdding({ id: requests.current, request })
    },
    drop: (kind, at) => {
      setAdding(null)
      add(kind, { at })
    },
    undo: editor.undo,
    redo: editor.redo,
    locked: editor.saving,
    canUndo: !editor.saving && draft.undo.length > 0,
    canRedo: !editor.saving && draft.redo.length > 0
  }

  const approve = async (): Promise<void> => {
    setApproving(true)
    const result = await approveAutomation(automation.id, automation.revision)
    setApproving(false)
    if (!result.success) toast.error(`Could not approve: ${result.error}`)
    onChanged()
  }
  // Save must finish first: closing would unmount the editor under the request.
  const close = (): void => {
    if (editor.saving) return
    if (dirty) setConfirmClose(true)
    else onClose()
  }
  const leaveNonce = leave?.nonce
  const closeRef = useRef(close)
  closeRef.current = close
  // A request that lands during Save is taken up once Save answers.
  const saving = editor.saving
  useEffect(() => {
    if (leaveNonce !== undefined && !saving) closeRef.current()
  }, [leaveNonce, saving])

  const saveButton = (
    <Button
      size="sm"
      variant={dirty ? 'default' : 'outline'}
      className="pointer-coarse:h-11"
      disabled={!dirty || editor.saving}
      onClick={() => void editor.save()}
    >
      {editor.saving ? <Loader2 size={14} className="animate-spin" /> : null}
      Save
    </Button>
  )
  // Approval arms the saved revision, so it waits for a clean draft.
  const approveButton = needsApproval && (
    <Button
      size="sm"
      variant={dirty ? 'outline' : 'default'}
      className="pointer-coarse:h-11"
      disabled={dirty || draft.issues.length > 0 || approving}
      title={dirty ? 'Save first' : draft.issues.length > 0 ? 'Fix the issues first' : undefined}
      onClick={() => void approve()}
    >
      {approving ? 'Approving…' : automation.enabled && !phone ? 'Approve and arm' : 'Approve'}
    </Button>
  )

  return (
    <div
      role="group"
      aria-label={`Edit ${automation.name}`}
      data-testid="automation-editor"
      // A tab stop inside the editor, so its shortcuts never reach other panes.
      tabIndex={-1}
      ref={root}
      className="flex h-full min-h-0 flex-col bg-background outline-none"
      onPointerDownCapture={(event) => {
        const host = event.currentTarget
        // React bubbles events from portals (the add menu) here too; those keep their own focus.
        if (!host.contains(event.target as Node)) return
        if (!host.contains(document.activeElement)) host.focus({ preventScroll: true })
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement
        if (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return
        const key = event.key.toLowerCase()
        if (key === 'z' && !event.shiftKey) editor.undo()
        else if ((key === 'z' && event.shiftKey) || key === 'y') editor.redo()
        else return
        event.preventDefault()
      }}
    >
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button
          variant="ghost"
          size={phone ? 'touch' : 'icon-sm'}
          className={phone ? 'w-11' : undefined}
          aria-label="Close the editor"
          title={editor.saving ? 'Saving…' : 'Close the editor'}
          disabled={editor.saving}
          onClick={close}
        >
          <ArrowLeft size={16} />
        </Button>
        <div className={cn('flex min-w-0 flex-1', phone ? 'flex-col' : 'items-center gap-2')}>
          <h2 className="truncate text-sm font-medium text-foreground">{automation.name}</h2>
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'shrink-0 rounded-full px-2 text-3xs font-medium leading-5',
                state.className
              )}
            >
              {state.label}
            </span>
            <span className="truncate text-xs text-muted-foreground" data-testid="draft-status">
              {changesLabel(count, phone)}
            </span>
          </span>
        </div>
        {/* At 390 px the phone has room for one action group: edits, or approval. */}
        {(!phone || dirty) && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={!dirty || editor.saving}
              onClick={editor.discard}
            >
              Discard
            </Button>
            {saveButton}
          </>
        )}
        {(!phone || !dirty) && approveButton}
      </header>

      <div className="relative min-h-0 flex-1">
        <AutomationFlow
          automation={shown}
          phone={phone}
          issues={draft.issues}
          edit={edit}
          focus={focus}
        />
        {draft.conflict && (
          <ConflictBanner
            by={draft.conflict.by}
            dropped={draft.conflict.dropped.map((op) => describeOp(op, labels))}
            onDismiss={editor.dismissConflict}
          />
        )}
      </div>

      <AddNodeMenu
        // One menu per request: a menu still closing cannot dismiss the next one.
        key={adding?.id ?? 'closed'}
        anchor={adding?.request.screen ?? null}
        phone={phone}
        // A step in the middle of an edge has to pass the run on.
        exclude={adding?.request.split ? NO_CHAIN : []}
        onPick={(kind) => {
          const request = adding
          if (!request) return
          setAdding((current) => (current?.id === request.id ? null : current))
          add(kind, request.request)
        }}
        onClose={() => {
          const id = adding?.id
          setAdding((current) => (current?.id === id ? null : current))
        }}
      />

      <IssuesDock
        issues={draft.issues}
        refusal={editor.refusal}
        label={labels}
        phone={phone}
        onShow={(id) => setFocus({ id, nonce: Date.now() })}
      />

      <ConfirmDialog
        isOpen={confirmClose}
        title="Discard unsaved changes"
        message={`Close the editor and discard ${count === 1 ? '1 unsaved change' : `${count} unsaved changes`}?`}
        confirmLabel="Discard"
        variant="danger"
        isLoading={editor.saving}
        onConfirm={() => {
          if (editor.saving) return
          setConfirmClose(false)
          editor.discard()
          onClose()
        }}
        onCancel={() => {
          setConfirmClose(false)
          onStay?.()
        }}
      />
    </div>
  )
}

function ConflictBanner({
  by,
  dropped,
  onDismiss
}: {
  by: string | null
  dropped: string[]
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-xl items-start gap-3 rounded-xl border border-border bg-popover px-4 py-3 text-sm shadow-lg"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium text-warning">
          Updated by {by ?? 'someone else'} while you edited
        </p>
        <p className="text-xs text-muted-foreground">
          Your edits now sit on the latest version. Review them, then Save.
        </p>
        {dropped.length > 0 && (
          <>
            <p className="text-xs text-foreground">
              {dropped.length === 1 ? '1 edit' : `${dropped.length} edits`} no longer apply:
            </p>
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {dropped.map((line, index) => (
                // The same edit text can repeat.
                <li key={index}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}>
        <X size={14} />
      </Button>
    </div>
  )
}

/** The bottom dock. This PR has its Issues tab; Runs and Output come with the run overlay. */
function IssuesDock({
  issues,
  refusal,
  label,
  phone,
  onShow
}: {
  issues: Issue[]
  refusal: string | null
  label: (id: string) => string
  phone: boolean
  onShow: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const count = issues.length + (refusal ? 1 : 0)
  const expanded = open && count > 0
  return (
    <section aria-label="Dock" className="shrink-0 border-t border-border bg-background">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <Button
          variant="ghost"
          size={phone ? 'touch' : 'sm'}
          className={cn(expanded && 'keycap text-foreground')}
          aria-expanded={expanded}
          aria-controls="automation-editor-issues"
          disabled={count === 0}
          onClick={() => setOpen((value) => !value)}
        >
          <AlertCircle size={14} className={count > 0 ? 'text-destructive' : undefined} />
          Issues ({count})
        </Button>
        {count > 0 && (
          <Button
            variant="ghost"
            size={phone ? 'touch' : 'icon-sm'}
            className={cn('ml-auto', phone && 'w-11')}
            aria-label={expanded ? 'Collapse the dock' : 'Expand the dock'}
            onClick={() => setOpen((value) => !value)}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </Button>
        )}
      </div>
      {expanded && (
        <ul
          id="automation-editor-issues"
          className="flex max-h-48 flex-col gap-1 overflow-y-auto px-3 pb-3"
        >
          {refusal && (
            <li className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle size={14} className="mt-px shrink-0" />
              <span className="min-w-0 break-words">The host refuses these edits: {refusal}</span>
            </li>
          )}
          {issues.map((issue, index) => (
            <li
              // Issues carry no id; the same code can repeat on one node.
              key={`${issue.code}-${issue.node_id ?? ''}-${index}`}
              className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
            >
              <AlertCircle size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                {issue.node_id && <span className="font-medium">{label(issue.node_id)}: </span>}
                {issue.message}
              </span>
              <Button
                variant="outline"
                size={phone ? 'touch' : 'xs'}
                onClick={() => onShow(issue.node_id ?? 'trigger')}
              >
                Show
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
