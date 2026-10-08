import { useState } from 'react'
import { Check, Plus } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ElicitationField } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { PendingElicitation } from '@/stores/acp-store'

interface ElicitationQuestionsProps {
  pending: PendingElicitation
  submitting: boolean
  onSubmit: (answers: Record<string, string | string[]>) => void
  onCancel: () => void
}

/** Trimmed free-text "Other" answer for a field, or '' when unused. */
function trimmedOther(otherText: Record<string, string>, name: string): string {
  return (otherText[name] ?? '').trim()
}

/**
 * Styled multi-question panel for question-shaped elicitation requests
 * (GH-935): one card per field with a header chip (`title`, never the raw
 * `qN` field name), the question text, option cards for single-select
 * (`enum`) and checkbox rows for multi-select (`multi-enum`), plus a
 * free-text "Other" row when the agent permits custom answers
 * (`_meta["cognition.ai/allowOther"]`).
 *
 * Mirrors the AskUserQuestion (#411) option-card idiom: `min-h-11` toggle
 * rows, `border-foreground bg-secondary` selected state, Check glyph in a
 * small box (round for single-select, square for multi-select).
 *
 * `onSubmit` receives only answered questions keyed by field `name`:
 * `string` for `enum` (the option value, or the Other text when typed) and
 * `string[]` for `multi-enum` (checked values plus appended Other text).
 * Untouched optional questions are omitted — absent means skipped.
 */
export function ElicitationQuestions({
  pending,
  submitting,
  onSubmit,
  onCancel
}: ElicitationQuestionsProps): React.JSX.Element {
  // `single` holds the picked option value per `enum` field; `multi` holds
  // the toggled option-value set per `multi-enum` field.
  const [single, setSingle] = useState<Record<string, string>>({})
  const [multi, setMulti] = useState<Record<string, Set<string>>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({})

  const selectOption = (field: ElicitationField, value: string): void => {
    if (field.kind === 'multi-enum') {
      setMulti((current) => {
        const next = new Set(current[field.name] ?? [])
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return { ...current, [field.name]: next }
      })
      return
    }
    setSingle((current) => {
      const next = { ...current }
      // Clicking the picked option again deselects it — the only way back
      // to "skipped" for an optional single-select question.
      if (next[field.name] === value) delete next[field.name]
      else next[field.name] = value
      return next
    })
    // Picking a real option dismisses the "Other" answer for that question.
    setOtherText((current) => ({ ...current, [field.name]: '' }))
    setOtherOpen((current) => ({ ...current, [field.name]: false }))
  }

  const changeOther = (field: ElicitationField, text: string): void => {
    setOtherText((current) => ({ ...current, [field.name]: text }))
    // Single-select: a non-blank Other answer deselects the option (they
    // are exclusive; whitespace alone must not drop the pick since it
    // submits as empty anyway). Multi-select: Other text is independent —
    // it is appended to the checked values at submit time.
    if (field.kind === 'enum' && text.trim() !== '') {
      setSingle((current) => {
        const next = { ...current }
        delete next[field.name]
        return next
      })
    }
  }

  const openOther = (field: ElicitationField): void => {
    setOtherOpen((current) => ({ ...current, [field.name]: true }))
  }

  const isAnswered = (field: ElicitationField): boolean => {
    if (trimmedOther(otherText, field.name) !== '') return true
    if (field.kind === 'multi-enum') return (multi[field.name]?.size ?? 0) > 0
    return field.name in single
  }

  const missingRequired = pending.fields.some((field) => field.required && !isAnswered(field))
  // Never block submit on unanswered required questions — the agent treats
  // omitted keys as skipped (GH-935 spec), so Send stays enabled.
  const sendDisabled = submitting

  const send = (): void => {
    if (sendDisabled) return
    const answers: Record<string, string | string[]> = {}
    for (const field of pending.fields) {
      const other = trimmedOther(otherText, field.name)
      if (field.kind === 'multi-enum') {
        const values = Array.from(multi[field.name] ?? [])
        if (other && !values.includes(other)) values.push(other)
        if (values.length > 0) answers[field.name] = values
        continue
      }
      if (other) answers[field.name] = other
      else if (field.name in single) answers[field.name] = single[field.name]
    }
    onSubmit(answers)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="elicitation-questions">
      {pending.fields.map((field) => {
        const isMulti = field.kind === 'multi-enum'
        const title = field.title?.trim() ? field.title : field.name
        const isOtherOpen = otherOpen[field.name] ?? false
        return (
          <div
            key={field.name}
            className="rounded-lg border border-border/60 p-3"
            data-testid={`elicitation-question-${field.name}`}
          >
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="max-w-full truncate">
                {title}
              </Badge>
              {field.required ? (
                <span className="text-xs text-muted-foreground">required</span>
              ) : null}
            </div>
            {field.description ? <p className="mt-1.5 text-sm">{field.description}</p> : null}
            <div className="mt-2 flex flex-col gap-1.5">
              {field.options.map((option) => {
                const isSelected = isMulti
                  ? (multi[field.name]?.has(option.value) ?? false)
                  : single[field.name] === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => selectOption(field, option.value)}
                    className={cn(
                      'flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      isSelected
                        ? 'border-foreground bg-secondary'
                        : 'border-border hover:bg-secondary/60'
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border',
                        isMulti ? 'rounded' : 'rounded-full',
                        isSelected
                          ? 'border-foreground bg-secondary text-foreground'
                          : 'border-border'
                      )}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">{option.label}</span>
                      {option.description ? (
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                )
              })}
              {pending.allowOther ? (
                isOtherOpen ? (
                  <Input
                    value={otherText[field.name] ?? ''}
                    onChange={(event) => changeOther(field, event.target.value)}
                    placeholder="Type your own answer"
                    aria-label={`Other answer for ${title}`}
                    className="min-h-11"
                    data-testid={`elicitation-other-${field.name}`}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => openOther(field)}
                    className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    data-testid={`elicitation-other-toggle-${field.name}`}
                  >
                    <Plus className="h-4 w-4" />
                    Other
                  </button>
                )
              ) : null}
            </div>
          </div>
        )
      })}
      {missingRequired ? (
        <p className="text-xs text-muted-foreground">
          Required questions left blank are sent as skipped.
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" className="min-h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button className="min-h-11" onClick={send} disabled={sendDisabled}>
          Send answers
        </Button>
      </div>
    </div>
  )
}
