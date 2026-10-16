import { type Ref, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  QUESTION_ROW_SELECTOR,
  QuestionHint,
  QuestionMinimizedBar,
  QuestionOption,
  QuestionOptions,
  QuestionOtherField,
  QuestionPager,
  QuestionPanel,
  QuestionPanelFooter,
  QuestionPanelHeader,
  QuestionPanelTitle,
  QuestionPrimaryButton,
  QuestionProgress,
  QuestionPrompt,
  QuestionShortcuts,
  type QuestionStepState,
  QuestionWindowActions
} from './question-panel'

/** Normalized selectable option shared by both question surfaces. */
export interface StepperOption {
  value: string
  label: string
  description?: string
}

interface QuestionStepperProps {
  /** The question text rendered as the step heading. */
  heading: string
  /** Id on the heading element — the outer dialog section's `aria-labelledby`. */
  headingId: string
  /** Accessible group name for the options (the short field title); defaults to `heading`. Shown above the heading. */
  legend?: string
  /** Muted context line under the heading (e.g. the elicitation request message). */
  note?: string
  /** Current step, 0-based. */
  index: number
  total: number
  /** State of every step for the progress track and the Submit count. */
  steps?: QuestionStepState[]
  onNavigate: (index: number) => void
  options: StepperOption[]
  /** True → toggles are additive (multi-select); false → radio semantics. */
  multi: boolean
  selected: ReadonlySet<string>
  onToggle: (value: string) => void
  /** Renders the free-text "Other" row under the options. */
  allowOther?: boolean
  otherText?: string
  otherLabel?: string
  otherTestId?: string
  onOtherChange?: (text: string) => void
  /** Skip → advance/submit with this question left unanswered. Hidden when absent. */
  onSkip?: () => void
  isLast: boolean
  submitting?: boolean
  /** Footer primary: "Next" mid-flow, "Submit" on the last step. */
  onPrimary: () => void
  /** Header × — cancels the whole prompt. */
  onClose: () => void
  firstOptionRef?: Ref<HTMLButtonElement>
  /** Ref to the header × button, for callers that move focus to it when there are no options. */
  closeRef?: Ref<HTMLButtonElement>
  /** data-testid for the stepper root (e.g. `elicitation-questions`). */
  testId?: string
  /** data-testid for the current question's fieldset (e.g. `elicitation-question-q0`). */
  questionTestId?: string
}

/** Plural-aware "Submit N answers"; plain "Submit" when there is nothing to count. */
function submitLabel(total: number, steps: QuestionStepState[] | undefined): string {
  if (total < 2 || !steps) return 'Submit'
  const answered = steps.filter((state) => state === 'answered').length
  if (answered === 0) return 'Submit'
  return `Submit ${answered} ${answered === 1 ? 'answer' : 'answers'}`
}

/**
 * One-question-at-a-time prompt rendered inside the composer card, so the
 * composer reads as transformed into the question. Built from the compound
 * parts in `question-panel.tsx`: a header with the step track, the
 * `‹ i / N ›` pager, minimize and `×`; the field title and question; numbered
 * option rows with a Recommended badge and a radio or checkbox indicator; an
 * "Other" row; and a footer with keyboard hints, `Skip` and the embossed
 * `Next` / `Submit`. `Next` stays disabled until the current question has an
 * answer (Skip is the explicit way past it). Minimize collapses the panel to
 * one bar with `Resume`.
 *
 * Keyboard: 1–9 pick an option and the next number focuses Other, ↑/↓ move
 * between rows, ←/→ page, Enter runs the primary action, Esc cancels.
 *
 * Shared by `AskUserQuestion` (issue #411, always one required step) and
 * `ElicitationQuestions` (GH-935, one step per schema field).
 */
export function QuestionStepper({
  heading,
  headingId,
  legend,
  note,
  index,
  total,
  steps,
  onNavigate,
  options,
  multi,
  selected,
  onToggle,
  allowOther = false,
  otherText = '',
  otherLabel,
  otherTestId,
  onOtherChange,
  onSkip,
  isLast,
  submitting = false,
  onPrimary,
  onClose,
  firstOptionRef,
  closeRef,
  testId,
  questionTestId
}: QuestionStepperProps): React.JSX.Element {
  const [minimized, setMinimized] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)
  const minimizeRef = useRef<HTMLButtonElement>(null)
  const resumeRef = useRef<HTMLButtonElement>(null)
  const focusAfterToggle = useRef(false)

  const hasOptions = options.length > 0
  const canAnswer = hasOptions || allowOther
  const typedOther = otherText.trim() !== ''
  const answered = selected.size > 0 || typedOther
  const primaryDisabled = submitting || !answered
  const otherShortcut = options.length + 1
  const pickCount = allowOther ? otherShortcut : options.length
  const skippedCount = steps?.filter((state) => state === 'skipped').length ?? 0
  const status =
    multi && selected.size > 0
      ? `${selected.size} selected`
      : isLast && skippedCount > 0
        ? `${skippedCount} skipped`
        : null

  const toggleMinimized = (next: boolean): void => {
    focusAfterToggle.current = true
    setMinimized(next)
  }

  // Keep focus on the control that replaced the one the user pressed.
  useEffect(() => {
    if (!focusAfterToggle.current) return
    focusAfterToggle.current = false
    ;(minimized ? resumeRef : minimizeRef).current?.focus()
  }, [minimized])

  const primary = (): void => {
    if (!primaryDisabled) onPrimary()
  }

  /** Move focus to the previous or next option row or the Other field. */
  const moveRow = (from: EventTarget, step: 1 | -1): void => {
    const rows = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(QUESTION_ROW_SELECTOR) ?? []
    )
    if (rows.length === 0) return
    const current = rows.findIndex((row) => row === from)
    const next = current === -1 ? (step === 1 ? 0 : rows.length - 1) : current + step
    rows[Math.max(0, Math.min(rows.length - 1, next))].focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      onClose()
      return
    }
    if (minimized) return
    const target = event.target
    if (event.key === 'Enter') {
      // IME candidate confirmation must not advance/submit half-typed text,
      // and buttons keep their native Enter activation (× cancels, an
      // option toggles) instead of being hijacked into Next/Submit.
      if (event.nativeEvent.isComposing) return
      if (target instanceof HTMLElement && target.closest('button')) return
      event.preventDefault()
      primary()
      return
    }
    const inField =
      target instanceof HTMLElement &&
      Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // From the Other field only ↑ leaves it (back to the options).
      if (inField && event.key === 'ArrowDown') return
      event.preventDefault()
      moveRow(target, event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    // Number/arrow shortcuts must not fire while typing in the Other input.
    if (inField) return
    if (event.key === 'ArrowRight' && index < total - 1) {
      event.preventDefault()
      onNavigate(index + 1)
      return
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      onNavigate(index - 1)
      return
    }
    const digit = Number(event.key)
    if (!Number.isInteger(digit) || digit < 1 || digit > 9) return
    const option = options[digit - 1]
    if (option) {
      event.preventDefault()
      onToggle(option.value)
      return
    }
    if (allowOther && digit === otherShortcut) {
      event.preventDefault()
      otherRef.current?.focus()
    }
  }

  return (
    <QuestionPanel
      ref={rootRef}
      index={index}
      total={total}
      steps={steps}
      submitting={submitting}
      onNavigate={onNavigate}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {minimized ? (
        <QuestionMinimizedBar
          heading={heading}
          headingId={headingId}
          onResume={() => toggleMinimized(false)}
          resumeRef={resumeRef}
        />
      ) : (
        <>
          <QuestionPanelHeader>
            <QuestionPanelTitle />
            <QuestionProgress />
            <div className="ml-auto flex items-center">
              <QuestionPager />
              <QuestionWindowActions
                onMinimize={() => toggleMinimized(true)}
                onClose={onClose}
                minimizeRef={minimizeRef}
                closeRef={closeRef}
              />
            </div>
          </QuestionPanelHeader>
          <fieldset className="min-w-0" data-testid={questionTestId}>
            <legend className="sr-only">{legend ?? heading}</legend>
            <QuestionPrompt heading={heading} headingId={headingId} eyebrow={legend}>
              {note ? <QuestionHint>{note}</QuestionHint> : null}
              {multi ? <QuestionHint>Select all that apply.</QuestionHint> : null}
            </QuestionPrompt>
            {canAnswer ? (
              <QuestionOptions>
                {options.map((option, optionIndex) => (
                  <QuestionOption
                    key={option.value}
                    ref={optionIndex === 0 ? firstOptionRef : undefined}
                    shortcut={optionIndex + 1}
                    label={option.label}
                    description={option.description}
                    selected={selected.has(option.value)}
                    multi={multi}
                    muted={!multi && typedOther}
                    onClick={() => onToggle(option.value)}
                  />
                ))}
                {allowOther ? (
                  <QuestionOtherField
                    ref={otherRef}
                    shortcut={otherShortcut}
                    value={otherText}
                    onValueChange={(text) => onOtherChange?.(text)}
                    aria-label={otherLabel}
                    data-testid={otherTestId}
                  />
                ) : null}
              </QuestionOptions>
            ) : (
              <p className="px-5 pb-3 text-xs text-muted-foreground">
                The agent provided no options.
              </p>
            )}
          </fieldset>
          {canAnswer || onSkip ? (
            <QuestionPanelFooter>
              {canAnswer ? <QuestionShortcuts count={pickCount} /> : null}
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {status ? (
                  <span className="mr-1 text-xs text-muted-foreground/70">{status}</span>
                ) : null}
                {onSkip ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-8 rounded-full px-3 text-[13px] text-muted-foreground pointer-coarse:min-h-11"
                    disabled={submitting}
                    onClick={onSkip}
                  >
                    Skip
                  </Button>
                ) : null}
                {canAnswer ? (
                  <QuestionPrimaryButton disabled={primaryDisabled} onClick={primary}>
                    {isLast ? submitLabel(total, steps) : 'Next'}
                  </QuestionPrimaryButton>
                ) : null}
              </div>
            </QuestionPanelFooter>
          ) : null}
        </>
      )}
    </QuestionPanel>
  )
}
