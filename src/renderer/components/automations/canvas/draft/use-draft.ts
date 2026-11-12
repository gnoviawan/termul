import type {
  AutomationDetail,
  AutomationLayout,
  AutomationOp
} from '@shared/types/automation.types'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  applyAutomationOps,
  getAutomation,
  onAutomationChanged,
  previewAutomationOps,
  setAutomationLayout
} from '@/lib/automation-api'
import { logFrontendError } from '@/lib/log-api'
import type { OpRejection } from './apply-op'
import {
  changedPositions,
  type Draft,
  draftReducer,
  type LayoutPatch,
  openDraft,
  patchLayout,
  pendingOps,
  planGesture,
  type Step
} from './draft'

const SOURCE = 'automation-canvas:draft'
/** A dry run waits for the gesture burst to settle. */
const PREVIEW_DELAY_MS = 250

function log(level: 'info' | 'warn', message: string): void {
  void logFrontendError({ level, source: SOURCE, message })
}

/** JSON with object keys sorted, so two encoders of one value compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  )
}

/** Why a gesture did not apply: the host would refuse its ops, or a Save is running. */
export type ApplyRefusal = OpRejection | { code: 'saving' }

/** What to tell the user when an edit arrives while Save runs. */
export const SAVING_MESSAGE = 'Saving. Try that again once it finishes.'

export interface DraftEditor {
  draft: Draft
  saving: boolean
  /** The host refused the pending ops in its dry run; Save would fail the same way. */
  refusal: string | null
  /** Applies a gesture, or says why the host would refuse its ops. */
  apply: (ops: AutomationOp[], layout?: LayoutPatch) => ApplyRefusal | null
  undo: () => void
  redo: () => void
  save: () => Promise<void>
  discard: () => void
  dismissConflict: () => void
}

/**
 * The draft of one automation: gestures apply locally at once, a debounced
 * dry run (`preview_ops`) brings the host's issues, and Save sends every
 * pending op as one `apply_ops` on the draft's base revision, then the
 * positions through `set_layout`. A Save or dry run that meets a newer head
 * replays the draft on it.
 */
export function useDraft(detail: AutomationDetail, onSaved: () => void): DraftEditor {
  const [draft, dispatch] = useReducer(draftReducer, detail, openDraft)
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<{ pending: Step[]; message: string } | null>(null)
  const latest = useRef({ draft, saving, rebasing: false, by: null as string | null })
  latest.current.draft = draft
  latest.current.saving = saving

  const id = detail.automation.id
  useEffect(() => dispatch({ type: 'head', head: detail }), [detail])
  useEffect(
    () =>
      onAutomationChanged((change) => {
        if (change?.automation_id === id) latest.current.by = change.proposed_by ?? null
      }),
    [id]
  )

  const rebaseOnHead = useCallback(async (): Promise<void> => {
    if (latest.current.rebasing) return
    latest.current.rebasing = true
    const head = await getAutomation(id)
    latest.current.rebasing = false
    if (!head.success) {
      toast.error(`Could not load the latest version: ${head.error}`)
      return
    }
    const before = latest.current.draft
    log(
      'info',
      `draft on revision ${before.base.revision} rebased onto ${head.data.automation.revision} (${pendingOps(before).length} ops)`
    )
    dispatch({ type: 'rebased', head: head.data, by: latest.current.by })
  }, [id])

  const { pending, base } = draft
  useEffect(() => {
    if (pending.length === 0) return
    const ops = pending.flatMap((step) => step.ops)
    if (ops.length === 0) return
    const local = latest.current.draft.doc.graph
    const timer = setTimeout(() => {
      void previewAutomationOps(base.id, base.revision, ops).then((result) => {
        // A reply for steps the draft has moved past (or a Save has taken) says nothing now.
        if (latest.current.draft.pending !== pending || latest.current.saving) return
        if (result.success) {
          if (canonical(result.data.automation.graph) !== canonical(local)) {
            log('warn', `local op mirror drifted from the host on ${ops.length} ops`)
          }
          setRefusal(null)
          dispatch({ type: 'previewed', pending, issues: result.data.issues })
        } else if (result.code === 'revision_conflict') {
          void rebaseOnHead()
        } else {
          log('warn', `dry run of ${ops.length} ops on ${base.id} refused: code=${result.code}`)
          setRefusal({ pending, message: result.error })
        }
      })
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pending, base, rebaseOnHead])

  const apply = useCallback(
    (ops: AutomationOp[], layout: LayoutPatch = {}): ApplyRefusal | null => {
      if (latest.current.saving) return { code: 'saving' }
      const gesture = planGesture(latest.current.draft, ops, layout)
      if (!('forward' in gesture)) return gesture
      dispatch({ type: 'gesture', gesture })
      return null
    },
    []
  )

  const save = useCallback(async (): Promise<void> => {
    const current = latest.current.draft
    if (latest.current.saving || current.pending.length === 0) return
    setSaving(true)
    latest.current.saving = true
    try {
      let automation = current.base
      let issues = current.issues
      const ops = pendingOps(current)
      if (ops.length > 0) {
        const saved = await applyAutomationOps(id, current.base.revision, ops)
        if (!saved.success) {
          if (saved.code === 'revision_conflict') await rebaseOnHead()
          else toast.error(`Could not save: ${saved.error}`)
          return
        }
        automation = saved.data.automation
        issues = saved.data.issues
      } else {
        // `set_layout` has no revision check: positions alone save only onto the head they were moved on.
        const head = await getAutomation(id)
        if (!head.success) {
          toast.error(`Could not save: ${head.error}`)
          return
        }
        if (head.data.automation.revision !== current.base.revision) {
          await rebaseOnHead()
          return
        }
      }
      const changed = changedPositions(current.base.layout, current.layout)
      let unsavedLayout: LayoutPatch | null = null
      if (Object.keys(changed).length > 0) {
        // `set_layout` replaces the whole map and has no revision check, so write only this
        // draft's positions onto the head's layout, read just before the write: positions other
        // authors stored survive. A layout written by someone else between this read and our
        // write is still overwritten; the window is one round trip.
        const fresh = await getAutomation(id)
        const onto = fresh.success ? fresh.data.automation.layout : automation.layout
        const placed = await setAutomationLayout(id, patchLayout(onto, changed))
        if (placed.success) automation = placed.data
        else {
          toast.error(`Saved, but the positions were not: ${placed.error}`)
          unsavedLayout = changed
        }
      }
      log('info', `saved ${ops.length} ops on ${id}: revision ${automation.revision}`)
      dispatch({ type: 'saved', automation, issues })
      // Keep positions the host refused pending, so a second Save retries them.
      if (unsavedLayout) dispatch({ type: 'requeue', layout: unsavedLayout })
      onSaved()
    } finally {
      latest.current.saving = false
      setSaving(false)
    }
  }, [id, onSaved, rebaseOnHead])

  return {
    draft,
    saving,
    refusal: refusal && refusal.pending === pending ? refusal.message : null,
    apply,
    // While Save runs, the history must not move under the request.
    undo: useCallback(() => {
      if (!latest.current.saving) dispatch({ type: 'undo' })
    }, []),
    redo: useCallback(() => {
      if (!latest.current.saving) dispatch({ type: 'redo' })
    }, []),
    save,
    discard: useCallback(() => {
      if (!latest.current.saving) dispatch({ type: 'discard' })
    }, []),
    dismissConflict: useCallback(() => dispatch({ type: 'dismiss_conflict' }), [])
  }
}
