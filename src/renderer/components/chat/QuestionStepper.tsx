import type { Ref } from 'react'
import { ChevronLeft, ChevronRight, Edit2, HelpCircle, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { QUESTION_PANEL_MAX_H } from './chat-layout'

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
  /** Accessible group name for the options (the short field title); defaults to `heading`. */
  legend?: string
  /** Muted context line under the header (e.g. the elicitation request message). */
  note?: string
  /** Current step, 0-based. */
  index: number
  total: number
  onNavigate: (index: number) => void
  options: StepperOption[]
  /** True → toggles are additive (multi-select); false → radio semantics. */
  multi: boolean
  selected: ReadonlySet<string>
  onToggle: (value: string) => void
  /** Renders the footer's free-text "write your own response" input. */
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
  /** data-testid for the stepper root (e.g. `elicitation-questions`). */
  testId?: string
  /** data-testid for the current question's fieldset (e.g. `elicitation-question-q0`). */
  questionTestId?: string
}

/**
 * Compact one-question-at-a-time prompt rendered inside the composer card,
 * so the composer reads as transformed into the question: a muted
 * `? Question` header with the `‹ i of N ›` pager and `×`, the bold question,
 * borderless numbered option rows (1–9 select via keyboard), and a footer
 * laid out like the composer toolbar — a borderless "Or write your own
 * response" field on the left, `Skip` / `Next` pills on the right. `Next`
 * uses the composer send-button chrome and stays disabled until the current
 * question has an answer (Skip is the explicit way past it).
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
  testId,
  questionTestId
}: QuestionStepperProps): React.JSX.Element {
  const hasOptions = options.length > 0
  const canAnswer = hasOptions || allowOther
  const answered = selected.size > 0 || otherText.trim() !== ''
  const primaryDisabled = submitting || !answered

  const primary = (): void => {
    if (!primaryDisabled) onPrimary()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      primary()
      return
    }
    // Number/arrow shortcuts must not fire while typing in the Other input.
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest('input, textarea, select, [contenteditable="true"]')
    ) {
      return
    }
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
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
      const option = options[digit - 1]
      if (option) {
        event.preventDefault()
        onToggle(option.value)
      }
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only scopes keyboard shortcuts (1–9, arrows, Enter, Esc); every shortcut is mirrored by a real control inside it
    <div className="min-w-0" data-testid={testId} onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 pl-4 pr-2 pt-2.5 text-muted-foreground">
        <HelpCircle size={15} aria-hidden="true" />
        <span className="text-sm">Question</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous question"
            disabled={index === 0 || submitting}
            onClick={() => onNavigate(index - 1)}
            className="pointer-coarse:size-9"
          >
            <ChevronLeft size={14} />
          </Button>
          <span aria-live="polite" className="min-w-10 text-center text-xs tabular-nums">
            {index + 1} of {total}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next question"
            disabled={index >= total - 1 || submitting}
            onClick={() => onNavigate(index + 1)}
            className="pointer-coarse:size-9"
          >
            <ChevronRight size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Cancel"
            onClick={onClose}
            className="pointer-coarse:size-9"
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      {note ? <p className="px-4 text-xs text-muted-foreground">{note}</p> : null}
      <fieldset className="mt-2.5 min-w-0 px-2" data-testid={questionTestId}>
        <legend className="sr-only">{legend ?? heading}</legend>
        <h2 id={headingId} className="px-2 text-sm font-semibold text-foreground">
          {heading}
        </h2>
        {multi ? (
          <p className="px-2 text-xs text-muted-foreground">Select all that apply.</p>
        ) : null}
        {hasOptions ? (
          <div
            className={cn(
              'scroller-thin mt-1.5 flex flex-col gap-0.5 overflow-y-auto overscroll-contain',
              QUESTION_PANEL_MAX_H
            )}
          >
            {options.map((option, optionIndex) => {
              const isSelected = selected.has(option.value)
              return (
                <button
                  key={option.value}
                  ref={optionIndex === 0 ? firstOptionRef : undefined}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onToggle(option.value)}
                  className={cn(
                    'flex min-h-8 items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150 ease-out pointer-coarse:min-h-11',
                    FOCUS_RING_CLASS,
                    // Borderless variant of `pressedToggleClass`: same washes.
                    isSelected ? 'bg-foreground/10' : 'hover:bg-foreground/[0.03]'
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-md text-2xs font-medium tabular-nums',
                      isSelected
                        ? 'bg-foreground text-background'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {optionIndex + 1}
                  </span>
                  <span className="min-w-0 leading-5">
                    <span className="font-medium text-foreground">{option.label}</span>
                    {option.description ? (
                      <span className="text-muted-foreground"> — {option.description}</span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <p className="mt-1.5 px-2 text-xs text-muted-foreground">
            The agent provided no options.
          </p>
        )}
      </fieldset>
      <div className="mt-1.5 flex items-center gap-2 px-2 pb-2">
        {allowOther ? (
          <div className="relative min-w-0 flex-1">
            <Edit2
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={otherText}
              onChange={(event) => onOtherChange?.(event.target.value)}
              placeholder="Or write your own response"
              aria-label={otherLabel}
              className="h-8 w-full min-w-0 rounded-lg bg-transparent pl-8 pr-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none pointer-coarse:h-11"
              data-testid={otherTestId}
            />
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {onSkip ? (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-8 rounded-full px-3 text-sm pointer-coarse:min-h-11"
              disabled={submitting}
              onClick={onSkip}
            >
              Skip
            </Button>
          ) : null}
          {canAnswer ? (
            <Button
              type="button"
              variant="composer"
              size="xs"
              className="h-8 rounded-full px-3.5 text-sm pointer-coarse:min-h-11"
              disabled={primaryDisabled}
              onClick={primary}
            >
              {isLast ? 'Submit' : 'Next'}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
