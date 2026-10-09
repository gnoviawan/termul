import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { pressedToggleClass } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { type PendingQuestion, useAcpStore } from '@/stores/acp-store'
import { CHAT_GUTTER_X } from './chat-layout'

interface AskUserQuestionProps {
  question: PendingQuestion
  /**
   * Move focus to the first option (or "Cancel" when there are none) whenever
   * this becomes true: on mount in a visible mobile chat, and when the pane
   * becomes visible with the question open.
   */
  autoFocusFirstOption?: boolean
}

/** True when any option declares `cardinality: "multi"` (multi-select). */
function isMulti(question: PendingQuestion): boolean {
  return question.options.some((o) => o.cardinality === 'multi')
}

/**
 * Morphing inline panel for a structured agent question (issue #411). Replaces
 * the free-text composer for the duration of the question: choice cards for
 * single-select, checkboxes for multi-select, approval buttons for yes/no.
 *
 * Answers flow back through `answerQuestion(questionId, values)` exactly once
 * (optimistic delete; a racing second answer is a no-op). Cancel resolves the
 * question as cancelled.
 */
export function AskUserQuestion({
  question,
  autoFocusFirstOption = false
}: AskUserQuestionProps): React.JSX.Element {
  const answer = useAcpStore((s) => s.answerQuestion)
  const multi = useMemo(() => isMulti(question), [question])
  const [selected, setSelected] = useState<string[]>([])
  const [invalid, setInvalid] = useState(false)
  const firstOptionRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!autoFocusFirstOption) return
    const target = firstOptionRef.current ?? cancelRef.current
    target?.focus()
  }, [autoFocusFirstOption])

  const toggle = useCallback(
    (value: string) => {
      setInvalid(false)
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
    if (selected.length === 0) {
      setInvalid(true)
      firstOptionRef.current?.focus()
      return
    }
    setInvalid(false)
    submit(selected)
  }, [selected, submit])

  return (
    <div
      role="dialog"
      aria-label={question.question}
      className={cn(CHAT_GUTTER_X, 'border-t bg-card pb-2 pt-3')}
      data-testid="ask-user-question"
      data-approval-prompt={`question:${question.questionId}`}
    >
      <div className="mx-auto w-full max-w-3xl rounded-2xl border border-border/60 bg-card px-4 py-3">
        <p className="text-sm font-medium">{question.question}</p>
        {question.options.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">The agent provided no options.</p>
        )}
        <div
          className="mt-2 flex flex-col gap-1.5"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'ask-user-question-error' : undefined}
        >
          {question.options.map((option, index) => {
            const isSelected = selected.includes(option.value)
            return (
              <button
                key={option.value}
                ref={index === 0 ? firstOptionRef : undefined}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggle(option.value)}
                className={cn(
                  'flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  pressedToggleClass(isSelected)
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    isSelected ? 'border-border bg-foreground/10 text-foreground' : 'border-border'
                  )}
                >
                  {isSelected && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">{option.label}</span>
                  {option.description && (
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
        {invalid && (
          <p id="ask-user-question-error" role="alert" className="mt-2 text-xs text-destructive">
            Select an option.
          </p>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" className="min-h-11" onClick={cancel}>
            Cancel
          </Button>
          <Button className="min-h-11" onClick={sendAnswer}>
            Send answer
          </Button>
        </div>
      </div>
    </div>
  )
}
