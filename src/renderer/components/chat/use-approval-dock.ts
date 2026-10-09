import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { logFrontendError } from '@/lib/log-api'

const PROMPT_SELECTOR = '[data-approval-prompt]'
const COMPOSER_SELECTOR = '[data-chat-composer="true"]'
const QUESTION_PROMPT_SELECTOR = '[data-approval-prompt^="question:"]'
// The stepper's pager and × buttons precede the options, so name the options
// first (`aria-pressed` toggles) and fall back to the first enabled button
// (× Cancel) for a question with no options.
const QUESTION_FIRST_OPTION_SELECTOR = `${QUESTION_PROMPT_SELECTOR} button[aria-pressed]`
const QUESTION_FIRST_BUTTON_SELECTOR = `${QUESTION_PROMPT_SELECTOR} button:not(:disabled)`
// Chat tabs stay mounted while hidden (PaneContent), so a question can sit in a
// pane the user is not looking at; only the visible one counts.
const VISIBLE_CHAT_TAB_SELECTOR = '[data-chat-tab-state="visible"]'

/**
 * The control to focus in an open question inside `root`: its first option
 * (`aria-pressed` toggle), else its first enabled button (× Cancel) for a
 * question with no options. Never just the first button: the stepper renders
 * its pager and × before the options. Null when no question is open.
 */
export function findQuestionFocusTarget(root: ParentNode | null | undefined): HTMLElement | null {
  if (!root) return null
  return (
    root.querySelector<HTMLElement>(QUESTION_FIRST_OPTION_SELECTOR) ??
    root.querySelector<HTMLElement>(QUESTION_FIRST_BUTTON_SELECTOR)
  )
}

/**
 * `findQuestionFocusTarget` over the chat tab on screen only: a question open in
 * a hidden chat tab is ignored.
 */
export function findVisibleQuestionFocusTarget(): HTMLElement | null {
  for (const pane of Array.from(document.querySelectorAll(VISIBLE_CHAT_TAB_SELECTOR))) {
    const target = findQuestionFocusTarget(pane)
    if (target) return target
  }
  return null
}

interface UseApprovalDockOptions {
  /** The chat panel root: scopes focus tracking and the composer / question lookups. */
  rootRef: RefObject<HTMLElement | null>
  /** Mobile shell with a visible pane. Everything below is inert when false. */
  enabled: boolean
  /** The on-screen keyboard is open. */
  oskOpen: boolean
  /** Ids of the pending prompts, each null when that prompt is not rendered. */
  permissionId: string | null
  questionId: string | null
  elicitationId: string | null
}

interface ApprovalDock {
  /** True while the keyboard is up with an approval pending: collapse the plan and changed-files bars. */
  compactDock: boolean
  /** Spread on the panel root. Records where focus sits inside a prompt. */
  onFocus: (event: React.FocusEvent<HTMLElement>) => void
  /** Spread on the panel root. Forgets a recorded prompt focus once the user taps away. */
  onBlur: (event: React.FocusEvent<HTMLElement>) => void
}

/**
 * Mobile chat dock behaviour around approvals (permission, question,
 * elicitation):
 *
 * - `compactDock` while the keyboard is open and an approval is pending, so the
 *   dock bars free room; a focused approval button scrolls into view
 *   (`block: 'nearest'`).
 * - Focus return: when a prompt that held focus resolves, focus moves to the
 *   composer card (never the editor, so the keyboard does not rise), or to the
 *   open question's first option when a question has replaced the composer.
 *   Focus that had already left the prompt is never moved.
 *
 * The prompts themselves are not touched here; they only carry a
 * `data-approval-prompt` attribute naming their kind and id.
 */
export function useApprovalDock({
  rootRef,
  enabled,
  oskOpen,
  permissionId,
  questionId,
  elicitationId
}: UseApprovalDockOptions): ApprovalDock {
  const approvalPending = permissionId !== null || questionId !== null || elicitationId !== null
  const compactDock = enabled && oskOpen && approvalPending
  // Last focus seen inside a prompt (null once focus lands anywhere else in the root).
  const focusedPromptRef = useRef<{ el: HTMLElement; promptKey: string } | null>(null)

  const onFocus = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (!enabled) return
      const target = event.target
      const prompt = target.closest<HTMLElement>(PROMPT_SELECTOR)
      focusedPromptRef.current = prompt
        ? { el: target, promptKey: prompt.dataset.approvalPrompt ?? '' }
        : null
      if (prompt && compactDock && target instanceof HTMLButtonElement) {
        target.scrollIntoView?.({ block: 'nearest' })
      }
    },
    [enabled, compactDock]
  )

  // Focus that drops to nothing (relatedTarget null) is either the user
  // tapping away or the prompt's own element being removed on resolve. Only the
  // first should clear the record, so decide once the frame has settled: a
  // removed element is no longer connected (the focus-return effect keeps its
  // record), a tapped-away one is connected and no longer active. Focus moving
  // to another element inside the root is recorded by that element's onFocus
  // instead; focus moving to an element outside the root is never seen by the
  // root, so forget the prompt focus here (a later drop to <body> must not read
  // as the prompt's own element being removed).
  const onBlur = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (!enabled) return
      const recorded = focusedPromptRef.current
      if (!recorded || event.target !== recorded.el) return
      const next = event.relatedTarget
      if (next) {
        if (!(next instanceof Node && rootRef.current?.contains(next))) {
          focusedPromptRef.current = null
        }
        return
      }
      const { el } = recorded
      requestAnimationFrame(() => {
        if (
          focusedPromptRef.current?.el === el &&
          el.isConnected &&
          document.activeElement !== el
        ) {
          focusedPromptRef.current = null
        }
      })
    },
    [enabled, rootRef]
  )

  // The dock just compacted (keyboard rose with an approval pending) while an
  // approval button already holds focus: bring it back into view once the bars
  // have collapsed.
  useEffect(() => {
    if (!compactDock) return
    const active = document.activeElement
    if (!(active instanceof HTMLButtonElement)) return
    if (!active.closest(PROMPT_SELECTOR) || !rootRef.current?.contains(active)) return
    const frame = requestAnimationFrame(() => active.scrollIntoView?.({ block: 'nearest' }))
    return () => cancelAnimationFrame(frame)
  }, [compactDock, rootRef])

  // Focus return when the prompt that held focus resolves (its id changed or
  // became null).
  useLayoutEffect(() => {
    if (!enabled) {
      focusedPromptRef.current = null
      return
    }
    const recorded = focusedPromptRef.current
    if (!recorded) return
    const pendingKeys = [
      permissionId && `permission:${permissionId}`,
      questionId && `question:${questionId}`,
      elicitationId && `elicitation:${elicitationId}`
    ]
    if (pendingKeys.includes(recorded.promptKey)) return
    focusedPromptRef.current = null

    // Focus still sits on the recorded element (a same-key button can survive a
    // request change), or it fell to <body> because that element was removed.
    // Anywhere else the user moved on: leave it.
    const active = document.activeElement
    const droppedToBody = !recorded.el.isConnected && (active === document.body || active === null)
    if (active !== recorded.el && !droppedToBody) return

    const root = rootRef.current
    const target =
      root?.querySelector<HTMLElement>(COMPOSER_SELECTOR) ?? findQuestionFocusTarget(root)
    if (!target) {
      void logFrontendError({
        level: 'warn',
        source: 'useApprovalDock',
        message: `No focus target after prompt ${recorded.promptKey.split(':')[0]} resolved`
      })
      return
    }
    target.focus()
  }, [enabled, permissionId, questionId, elicitationId, rootRef])

  return { compactDock, onFocus, onBlur }
}
