import { Check } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { type PendingQuestion, useAcpStore } from '@/stores/acp-store'
import { CHAT_GUTTER_X } from './chat-layout'

interface AskUserQuestionProps {
  question: PendingQuestion
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

  return (
    <div
      role="dialog"
      aria-label={question.question}
      className={cn(CHAT_GUTTER_X, 'border-t bg-card pb-2 pt-3')}
      data-testid="ask-user-question"
    >
      <div className="mx-auto w-full max-w-3xl rounded-2xl border border-border/60 bg-card px-4 py-3">
        <p className="text-sm font-medium">{question.question}</p>
        {question.options.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">The agent provided no options.</p>
        )}
        <div className="mt-2 flex flex-col gap-1.5">
          {question.options.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={multi ? selected.includes(option.value) : selected[0] === option.value}
              onClick={() => toggle(option.value)}
              className={cn(
                'flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2.5 text-left text-sm',
                selected.includes(option.value) || selected[0] === option.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:bg-accent'
              )}
            >
              {multi && (
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    selected.includes(option.value)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border'
                  )}
                >
                  {selected.includes(option.value) && <Check className="h-3 w-3" />}
                </span>
              )}
              <span className="min-w-0">
                <span className="block font-medium">{option.label}</span>
                {option.description && (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                )}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={selected.length === 0} onClick={() => submit(selected)}>
            {multi ? 'Confirm' : 'Choose'}
          </Button>
        </div>
      </div>
    </div>
  )
}
