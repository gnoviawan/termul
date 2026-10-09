import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { type PendingQuestion, useAcpStore } from '@/stores/acp-store'
import { CHAT_GUTTER_X } from './chat-layout'
import { QuestionStepper } from './QuestionStepper'

interface AskUserQuestionProps {
  question: PendingQuestion
}

/** True when any option declares `cardinality: "multi"` (multi-select). */
function isMulti(question: PendingQuestion): boolean {
  return question.options.some((o) => o.cardinality === 'multi')
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
export function AskUserQuestion({ question }: AskUserQuestionProps): React.JSX.Element {
  const answer = useAcpStore((s) => s.answerQuestion)
  const multi = useMemo(() => isMulti(question), [question])
  const [selected, setSelected] = useState<string[]>([])

  const toggle = useCallback(
    (value: string) => {
      setSelected((prev) => {
        if (multi) {
          return prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
        }
        return [value]
      })
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
    if (selected.length > 0) submit(selected)
  }, [selected, submit])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  return (
    <div
      role="dialog"
      aria-label={question.question}
      className={cn(CHAT_GUTTER_X, 'pb-6 pt-3')}
      data-testid="ask-user-question"
    >
      {/* Composer-surface chrome (rounded-2xl border bg-card, max-w-3xl): the
          composer morphs into the question dialog rather than surfacing a
          separate warning-tinted notice. */}
      <section
        aria-labelledby={`ask-user-question-title-${question.questionId}`}
        aria-live="polite"
        className={cn(
          'mx-auto w-full max-w-3xl rounded-2xl border border-border/60 bg-card transition-[border-color,box-shadow]',
          'focus-within:border-border focus-within:ring-1 focus-within:ring-inset focus-within:ring-foreground/20'
        )}
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
          isLast
          onPrimary={sendAnswer}
          onClose={cancel}
        />
      </section>
    </div>
  )
}
