import { useState } from 'react'
import type { ElicitationField } from '@/lib/acp-api'
import type { PendingElicitation } from '@/stores/acp-store'
import { questionShape } from './elicitation-shape'
import { QuestionStepper } from './QuestionStepper'
import type { QuestionStepState } from './question-panel'

interface ElicitationQuestionsProps {
  pending: PendingElicitation
  submitting: boolean
  /** Id applied to the current step's heading — the dialog's `aria-labelledby`. */
  headingId: string
  /** Muted context line under the header (the request message when informative). */
  note?: string
  onSubmit: (answers: Record<string, string | string[]>) => void
  onCancel: () => void
}

/** Trimmed free-text "Other" answer for a field, or '' when unused. */
function trimmedOther(otherText: Record<string, string>, name: string): string {
  return (otherText[name] ?? '').trim()
}

const NO_SELECTION: ReadonlySet<string> = new Set()

/**
 * Paginated multi-question panel for question-shaped elicitation requests
 * (GH-935): one field at a time through `QuestionStepper` — a step track
 * (answered, skipped, pending) and `‹ i / N ›` navigation in the header,
 * numbered option rows for `enum`/`multi-enum`,
 * an inline free-text row when the agent permits custom answers
 * (`_meta["cognition.ai/allowOther"]`), and `Skip`/`Next` actions. Picking a
 * single-select option auto-advances to the next question; `Skip` leaves
 * the current question unanswered and moves on.
 *
 * `onSubmit` receives only answered questions keyed by field `name`:
 * `string` for `enum` (the option value, or the Other text when typed) and
 * `string[]` for `multi-enum` (checked values plus appended Other text).
 * Untouched or skipped questions are omitted — absent means skipped.
 */
export function ElicitationQuestions({
  pending,
  submitting,
  headingId,
  note,
  onSubmit,
  onCancel
}: ElicitationQuestionsProps): React.JSX.Element | null {
  const [index, setIndex] = useState(0)
  // `single` holds the picked option value per `enum` field; `multi` holds
  // the toggled option-value set per `multi-enum` field. Both persist across
  // steps so `<` navigation restores earlier picks.
  const [single, setSingle] = useState<Record<string, string>>({})
  const [multi, setMulti] = useState<Record<string, Set<string>>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  // Fields the user passed with Skip, for the progress track. An answer given
  // later wins over the skip mark.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(NO_SELECTION)

  const shape = questionShape(pending.fields)
  const questions = shape?.questions ?? pending.fields
  const customFor = shape?.customFor ?? {}
  const field = questions[index]
  if (!field) return null
  const total = questions.length
  const isLast = index === total - 1
  const isMulti = field.kind === 'multi-enum'
  const title = field.title?.trim() ? field.title : field.name
  // The schema `description` carries the full question text; `title` is the
  // short header label, kept as the options' accessible group name.
  const heading = field.description?.trim() ? field.description : title

  const selectOption = (current: ElicitationField, value: string): void => {
    if (current.kind === 'multi-enum') {
      setMulti((state) => {
        const next = new Set(state[current.name] ?? [])
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return { ...state, [current.name]: next }
      })
      return
    }
    // Re-clicking the picked option deselects it — the only way back to
    // "skipped" for an optional single-select question.
    const deselecting = single[current.name] === value
    setSingle((state) => {
      const next = { ...state }
      if (deselecting) delete next[current.name]
      else next[current.name] = value
      return next
    })
    if (!deselecting) {
      // Picking a real option dismisses the "Other" answer for that question.
      setOtherText((state) => ({ ...state, [current.name]: '' }))
      // Wizard flow: a decisive single-select pick moves to the next question.
      if (!isLast) setIndex((step) => Math.min(step + 1, total - 1))
    }
  }

  const changeOther = (current: ElicitationField, text: string): void => {
    setOtherText((state) => ({ ...state, [current.name]: text }))
    // Single-select: a non-blank Other answer deselects the option (they
    // are exclusive; whitespace alone must not drop the pick since it
    // submits as empty anyway). Multi-select: Other text is independent —
    // it is appended to the checked values at submit time.
    if (current.kind === 'enum' && text.trim() !== '') {
      setSingle((state) => {
        const next = { ...state }
        delete next[current.name]
        return next
      })
    }
  }

  /** Erase every answer state for a field (Skip semantics). */
  const clearField = (name: string): void => {
    setSingle((state) => {
      const next = { ...state }
      delete next[name]
      return next
    })
    setMulti((state) => {
      const next = { ...state }
      delete next[name]
      return next
    })
    setOtherText((state) => ({ ...state, [name]: '' }))
  }

  /**
   * Assemble the answer map; `skipName` excludes one field regardless of
   * recorded state (Skip on the last step submits without a state flush).
   */
  const buildAnswers = (skipName?: string): Record<string, string | string[]> => {
    const answers: Record<string, string | string[]> = {}
    for (const f of questions) {
      if (f.name === skipName) continue
      const other = trimmedOther(otherText, f.name)
      const customName = customFor[f.name]
      if (customName) {
        // The agent reads the free text from its own companion field (it folds
        // it into a multi-select, or notes it beside a single pick) — send the
        // pick and the text separately instead of merging them.
        if (other) answers[customName] = other
        if (f.kind === 'multi-enum') {
          const values = Array.from(multi[f.name] ?? [])
          if (values.length > 0) answers[f.name] = values
        } else if (f.name in single) answers[f.name] = single[f.name]
        continue
      }
      if (f.kind === 'multi-enum') {
        const values = Array.from(multi[f.name] ?? [])
        if (other && !values.includes(other)) values.push(other)
        if (values.length > 0) answers[f.name] = values
        continue
      }
      if (other) answers[f.name] = other
      else if (f.name in single) answers[f.name] = single[f.name]
    }
    return answers
  }

  const hasAnswer = (f: ElicitationField): boolean =>
    trimmedOther(otherText, f.name) !== '' || (multi[f.name]?.size ?? 0) > 0 || f.name in single

  const steps: QuestionStepState[] = questions.map((f) =>
    hasAnswer(f) ? 'answered' : skipped.has(f.name) ? 'skipped' : 'pending'
  )

  const skip = (): void => {
    if (submitting) return
    setSkipped((state) => new Set(state).add(field.name))
    if (isLast) {
      onSubmit(buildAnswers(field.name))
      return
    }
    clearField(field.name)
    setIndex(index + 1)
  }

  const primary = (): void => {
    if (submitting) return
    if (isLast) {
      onSubmit(buildAnswers())
      return
    }
    setIndex(index + 1)
  }

  const selected = isMulti
    ? (multi[field.name] ?? NO_SELECTION)
    : field.name in single
      ? new Set([single[field.name]])
      : NO_SELECTION

  return (
    <QuestionStepper
      testId="elicitation-questions"
      questionTestId={`elicitation-question-${field.name}`}
      heading={heading}
      headingId={headingId}
      legend={title}
      note={note}
      index={index}
      total={total}
      steps={steps}
      onNavigate={setIndex}
      options={field.options}
      multi={isMulti}
      selected={selected}
      onToggle={(value) => selectOption(field, value)}
      allowOther={pending.allowOther || customFor[field.name] !== undefined}
      otherText={otherText[field.name] ?? ''}
      otherLabel={`Other answer for ${title}`}
      otherTestId={`elicitation-other-${field.name}`}
      onOtherChange={(text) => changeOther(field, text)}
      onSkip={skip}
      isLast={isLast}
      submitting={submitting}
      onPrimary={primary}
      onClose={onCancel}
    />
  )
}
