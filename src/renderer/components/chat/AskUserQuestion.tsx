import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PROMPT_CARD_FOCUS_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { type PendingQuestion, useAcpStore } from '@/stores/acp-store'
import { CHAT_GUTTER_X, PROMPT_PANEL_CLASS } from './chat-layout'
import { QuestionStepper } from './QuestionStepper'

interface AskUserQuestionProps {
  question: PendingQuestion
  /**
   * Move focus to the first option (or the `×` Cancel button when there are none) whenever
   * this becomes true: on mount in a visible mobile chat, and when the pane
   * becomes visible with the question open.
   */
  autoFocusFirstOption?: boolean
}

/** True when the question allows several picks (`ask_user` flag or option cardinality). */
function isMulti(question: PendingQuestion): boolean {
  return question.multiSelect === true || question.options.some((o) => o.cardinality === 'multi')
}

/**
 * Morphing inline panel for a structured agent question (issue #411). Replaces
 * the free-text composer for the duration of the question, keeping the
 * composer's own surface chrome so it reads as the composer transformed —
 * the same one-step `QuestionStepper` chrome as the multi-question
 * elicitation pager: numbered option rows, `‹ 1 of 1 ›` header, `×` cancel.
 *
 * The structured-question contract requires a pick, so there is no Skip —
 * Submit stays disabled until an option is selected, and `×` resolves the
 * question as cancelled. Answers flow back through
 * `answerQuestion(questionId, values)` exactly once (optimistic delete; a
 * racing second answer is a no-op).
 */
export function AskUserQuestion({
  question,
  autoFocusFirstOption = false
}: AskUserQuestionProps): React.JSX.Element {
  const answer = useAcpStore((s) => s.answerQuestion)
  const multi = useMemo(() => isMulti(question), [question])
  const [selected, setSelected] = useState<string[]>([])
  // Free-text "Other" answer (issue #784 `ask_user`; the `_session/question`
  // path leaves `allowFreeText` unset, so the row stays hidden there).
  const [otherText, setOtherText] = useState('')
  const allowOther = question.allowFreeText === true
  const firstOptionRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!autoFocusFirstOption) return
    const target = firstOptionRef.current ?? closeRef.current
    target?.focus()
  }, [autoFocusFirstOption])

  const toggle = useCallback(
    (value: string) => {
      // Picking a real option on a single-choice question replaces a typed answer.
      if (!multi) setOtherText('')
      setSelected((prev) => {
        if (multi) {
          return prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
        }
        return [value]
      })
    },
    [multi]
  )

  const changeOther = useCallback(
    (text: string) => {
      setOtherText(text)
      // Typing an answer on a single-choice question deselects the option.
      if (!multi && text.trim() !== '') setSelected([])
    },
    [multi]
  )

  const submit = useCallback(
    (values?: string[]) => {
      const payload = values && values.length > 0 ? values : undefined
      void answer(question.questionId, payload).catch(() => {
        toast.error('Could not send your answer. Try again.')
      })
    },
    [answer, question.questionId]
  )

  const cancel = useCallback(() => submit(undefined), [submit])

  const sendAnswer = useCallback(() => {
    const typed = otherText.trim()
    const values = typed === '' ? selected : [...selected, typed]
    if (values.length > 0) submit(values)
  }, [otherText, selected, submit])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  return (
    <div
      role="dialog"
      aria-label={question.question}
      className={cn(CHAT_GUTTER_X, 'pb-6 pt-3')}
      data-testid="ask-user-question"
      data-approval-prompt={`question:${question.questionId}`}
    >
      {/* Composer-surface chrome (rounded-2xl border bg-card, max-w-3xl): the
          composer morphs into the question dialog rather than surfacing a
          separate warning-tinted notice. */}
      <section
        aria-labelledby={`ask-user-question-title-${question.questionId}`}
        aria-live="polite"
        className={cn('mx-auto w-full max-w-3xl', PROMPT_PANEL_CLASS, PROMPT_CARD_FOCUS_CLASS)}
      >
        <QuestionStepper
          heading={question.question}
          headingId={`ask-user-question-title-${question.questionId}`}
          index={0}
          total={1}
          onNavigate={() => {}}
          options={question.options}
          multi={multi}
          selected={selectedSet}
          onToggle={toggle}
          allowOther={allowOther}
          otherText={otherText}
          otherLabel="Your own answer"
          onOtherChange={changeOther}
          isLast
          onPrimary={sendAnswer}
          onClose={cancel}
          firstOptionRef={firstOptionRef}
          closeRef={closeRef}
        />
      </section>
    </div>
  )
}
