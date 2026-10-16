import { createContext, forwardRef, useContext } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  MessageQuestion,
  Minus,
  Pencil,
  Sparkles,
  X
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { INNER_FIELD_FOCUS_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { QUESTION_PANEL_MAX_H } from './chat-layout'

/** Where one question of a batch stands, for the header progress track. */
export type QuestionStepState = 'answered' | 'skipped' | 'pending'

interface QuestionPanelContextValue {
  /** Current step, 0-based. */
  index: number
  total: number
  steps: QuestionStepState[]
  submitting: boolean
  onNavigate: (index: number) => void
}

const QuestionPanelContext = createContext<QuestionPanelContextValue | null>(null)

function useQuestionPanel(part: string): QuestionPanelContextValue {
  const context = useContext(QuestionPanelContext)
  if (!context) throw new Error(`${part} must be rendered inside <QuestionPanel>`)
  return context
}

/** Rows that ↑/↓ move focus between: the options and the Other field. */
export const QUESTION_ROW_SELECTOR = '[data-question-row]'

/** Agents mark their suggested option with a trailing "(Recommended)" in the label. */
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i

function parseOptionLabel(label: string): { text: string; recommended: boolean } {
  return RECOMMENDED_SUFFIX.test(label)
    ? { text: label.replace(RECOMMENDED_SUFFIX, ''), recommended: true }
    : { text: label, recommended: false }
}

interface QuestionPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  index: number
  total: number
  /** One entry per question; the track stays empty without it. */
  steps?: QuestionStepState[]
  submitting?: boolean
  onNavigate: (index: number) => void
}

/**
 * Root of the compound question panel. It shares the step position with the
 * parts below it; the layout is the caller's JSX.
 */
export const QuestionPanel = forwardRef<HTMLDivElement, QuestionPanelProps>(function QuestionPanel(
  { index, total, steps, submitting = false, onNavigate, className, children, ...props },
  ref
) {
  const value: QuestionPanelContextValue = {
    index,
    total,
    steps: steps ?? [],
    submitting,
    onNavigate
  }
  return (
    <QuestionPanelContext.Provider value={value}>
      <div ref={ref} className={cn('min-w-0', className)} {...props}>
        {children}
      </div>
    </QuestionPanelContext.Provider>
  )
})

/** The "Agent questions" label with its icon. */
export function QuestionPanelTitle(): React.JSX.Element {
  const { total } = useQuestionPanel('QuestionPanelTitle')
  return (
    <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
      <MessageQuestion size={14} aria-hidden="true" />
      <span className="text-xs font-medium">
        {total > 1 ? 'Agent questions' : 'Agent question'}
      </span>
    </span>
  )
}

const STEP_CLASS: Record<QuestionStepState, string> = {
  answered: 'bg-muted-foreground',
  skipped: 'bg-muted-foreground/20',
  pending: 'bg-border'
}

/** Thin step track: answered, skipped, pending, and a longer bar for the current step. */
export function QuestionProgress(): React.JSX.Element | null {
  const { index, total, steps } = useQuestionPanel('QuestionProgress')
  if (total < 2) return null
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center gap-[3px]">
      {steps.map((state, step) => (
        <span
          key={step}
          className={cn(
            'h-[3px] rounded-full',
            step === index ? 'w-[22px] bg-primary' : cn('w-3.5', STEP_CLASS[state])
          )}
        />
      ))}
    </span>
  )
}

/** `2 / 4` on screen, "Question 2 of 4" for screen readers. */
function StepCount({ className }: { className?: string }): React.JSX.Element {
  const { index, total } = useQuestionPanel('StepCount')
  return (
    <span className={cn('font-mono text-2xs tabular-nums', className)}>
      <span aria-hidden="true">
        {index + 1} / {total}
      </span>
      <span className="sr-only">
        Question {index + 1} of {total}
      </span>
    </span>
  )
}

/** `‹ 2 / 4 ›` pager. Hidden for a single question. */
export function QuestionPager(): React.JSX.Element | null {
  const { index, total, submitting, onNavigate } = useQuestionPanel('QuestionPager')
  if (total < 2) return null
  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Previous question"
        disabled={index === 0 || submitting}
        onClick={() => onNavigate(index - 1)}
        className="text-muted-foreground pointer-coarse:size-9"
      >
        <ChevronLeft size={14} />
      </Button>
      <span aria-live="polite">
        <StepCount className="block min-w-9 text-center text-muted-foreground" />
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Next question"
        disabled={index >= total - 1 || submitting}
        onClick={() => onNavigate(index + 1)}
        className="text-muted-foreground pointer-coarse:size-9"
      >
        <ChevronRight size={14} />
      </Button>
    </div>
  )
}

interface QuestionWindowActionsProps {
  onMinimize: () => void
  onClose: () => void
  minimizeRef?: React.Ref<HTMLButtonElement>
  closeRef?: React.Ref<HTMLButtonElement>
}

/** Divider plus the minimize and `×` (cancel the whole prompt) buttons. */
export function QuestionWindowActions({
  onMinimize,
  onClose,
  minimizeRef,
  closeRef
}: QuestionWindowActionsProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-0.5">
      <span aria-hidden="true" className="mx-1 h-3.5 w-px bg-border" />
      <Button
        ref={minimizeRef}
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Minimize questions"
        onClick={onMinimize}
        className="text-muted-foreground pointer-coarse:size-9"
      >
        <Minus size={14} />
      </Button>
      <Button
        ref={closeRef}
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Cancel"
        data-question-cancel=""
        onClick={onClose}
        className="text-muted-foreground pointer-coarse:size-9"
      >
        <X size={14} />
      </Button>
    </div>
  )
}

/** Header row: title and progress on the left, pager and window actions on the right. */
export function QuestionPanelHeader({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <div className="flex items-center gap-2.5 pl-4 pr-2 pt-2.5">{children}</div>
}

interface QuestionPromptProps {
  heading: string
  headingId: string
  /** Short field title shown above the heading when it adds information. */
  eyebrow?: string
  children?: React.ReactNode
}

/** Field title, the question as the step heading, and optional hint lines. */
export function QuestionPrompt({
  heading,
  headingId,
  eyebrow,
  children
}: QuestionPromptProps): React.JSX.Element {
  const showEyebrow = Boolean(eyebrow?.trim()) && eyebrow !== heading
  return (
    <div className="space-y-1.5 px-5 pb-1.5 pt-3.5">
      {showEyebrow ? (
        <p
          aria-hidden="true"
          className="font-mono text-3xs font-medium uppercase tracking-[0.08em] text-muted-foreground/70"
        >
          {eyebrow}
        </p>
      ) : null}
      <h2 id={headingId} className="text-base font-semibold leading-snug text-foreground">
        {heading}
      </h2>
      {children}
    </div>
  )
}

/** Muted line under the heading (request message, "Select all that apply."). */
export function QuestionHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

/** Scroll region for the option rows and the Other field; the footer stays outside. */
export function QuestionOptions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className={cn(
        'scroller-thin flex flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pb-1.5 pt-1.5',
        QUESTION_PANEL_MAX_H
      )}
    >
      {children}
    </div>
  )
}

/** Number key on a row; it doubles as the keyboard shortcut. */
function RowKey({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[5px] border px-1 font-mono text-2xs font-medium tabular-nums transition-colors duration-150 ease-out',
        active
          ? 'border-primary/25 bg-primary/20 text-primary'
          : 'border-foreground/[0.08] bg-muted text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

interface QuestionOptionProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** 1-based shortcut number shown in the key. */
  shortcut: number
  label: string
  description?: string
  selected: boolean
  /** Square indicator for multi-select, round for single-select. */
  multi: boolean
  /** Dims the label while a typed Other answer replaces the pick. */
  muted?: boolean
}

/** One selectable row: key, label with an optional Recommended badge, description, indicator. */
export const QuestionOption = forwardRef<HTMLButtonElement, QuestionOptionProps>(
  function QuestionOption(
    { shortcut, label, description, selected, multi, muted = false, className, ...props },
    ref
  ) {
    const { text, recommended } = parseOptionLabel(label)
    return (
      <button
        ref={ref}
        type="button"
        aria-pressed={selected}
        // A full-width row scales too far under the document press rule; the
        // fill and indicator already show the pick.
        data-press-feedback="off"
        data-question-row=""
        className={cn(
          'flex min-h-9 w-full items-start gap-3 rounded-lg py-2 pl-2.5 pr-3 text-left transition-colors duration-150 ease-out pointer-coarse:min-h-11',
          'focus-visible:outline-hidden focus-visible:bg-secondary focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/25',
          selected
            ? 'bg-primary/[0.07] ring-1 ring-inset ring-primary/30'
            : 'hover:bg-foreground/[0.03]',
          className
        )}
        {...props}
      >
        <span className="flex h-5 items-center">
          <RowKey active={selected}>{shortcut}</RowKey>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={cn(
                'text-sm font-medium leading-5',
                muted && !selected ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              {text}
            </span>
            {recommended ? (
              <span className="inline-flex h-[18px] items-center gap-1 rounded-full bg-primary/12 px-1.5 text-2xs font-medium text-primary">
                <Sparkles size={10} aria-hidden="true" />
                Recommended
              </span>
            ) : null}
          </span>
          {description ? (
            <span className="mt-0.5 block text-xs leading-normal text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
        <span className="flex h-5 items-center">
          <span
            aria-hidden="true"
            className={cn(
              'flex size-4 items-center justify-center border-[1.5px] transition-colors duration-150 ease-out',
              multi ? 'rounded-[5px]' : 'rounded-full',
              selected
                ? 'border-primary-fill bg-primary-fill text-primary-foreground'
                : 'border-foreground/15'
            )}
          >
            {selected ? <Check size={10} strokeWidth={2.5} /> : null}
          </span>
        </span>
      </button>
    )
  }
)

interface QuestionOtherFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  shortcut: number
  value: string
  onValueChange: (text: string) => void
}

/** Free-text answer row, last in the list and reached with the next number key. */
export const QuestionOtherField = forwardRef<HTMLInputElement, QuestionOtherFieldProps>(
  function QuestionOtherField({ shortcut, value, onValueChange, className, ...props }, ref) {
    const typed = value.trim() !== ''
    return (
      <label
        className={cn(
          'flex min-h-9 cursor-text items-center gap-3 rounded-lg py-2 pl-2.5 pr-3 transition-colors duration-150 ease-out pointer-coarse:min-h-11',
          'focus-within:bg-background focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/40',
          className
        )}
      >
        <RowKey>{shortcut}</RowKey>
        <Pencil
          size={13}
          aria-hidden="true"
          className={cn('shrink-0', typed ? 'text-muted-foreground' : 'text-muted-foreground/70')}
        />
        <input
          ref={ref}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder="Something else? Type your own answer"
          data-question-row=""
          className={cn(
            'h-5 min-w-0 flex-1 bg-transparent text-sm text-foreground caret-foreground placeholder:text-muted-foreground/70 pointer-coarse:text-base',
            INNER_FIELD_FOCUS_CLASS
          )}
          {...props}
        />
      </label>
    )
  }
)

/** Footer: keyboard hints on the left, status and actions on the right. */
export function QuestionPanelFooter({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-t border-border py-2.5 pl-5 pr-2.5 pointer-coarse:pl-3">
      {children}
    </div>
  )
}

/** `↑↓ move · 1–N pick · esc close`, hidden on touch screens. */
export function QuestionShortcuts({ count }: { count: number }): React.JSX.Element {
  const hints: Array<[string, string]> = [
    ['↑↓', 'move'],
    [count > 1 ? `1–${count}` : '1', 'pick'],
    ['esc', 'close']
  ]
  return (
    <div
      aria-hidden="true"
      className="flex min-w-0 items-center gap-3.5 overflow-hidden pointer-coarse:hidden"
    >
      {hints.map(([key, word]) => (
        <span key={word} className="flex shrink-0 items-center gap-1.5">
          <Kbd className="flex h-5 min-w-5 items-center justify-center bg-muted px-1.5">{key}</Kbd>
          <span className="text-2xs text-muted-foreground/70">{word}</span>
        </span>
      ))}
    </div>
  )
}

interface QuestionPrimaryButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode
}

/** Next / Submit: the view's one filled primary, with an Enter key chip. */
export const QuestionPrimaryButton = forwardRef<HTMLButtonElement, QuestionPrimaryButtonProps>(
  function QuestionPrimaryButton({ children, className, ...props }, ref) {
    return (
      <Button
        ref={ref}
        type="button"
        size="xs"
        className={cn(
          'h-8 gap-2 rounded-lg pl-3.5 pr-1.5 text-sm pointer-coarse:min-h-11',
          className
        )}
        {...props}
      >
        {children}
        <span
          aria-hidden="true"
          className="flex size-5 items-center justify-center rounded-[5px] bg-primary-foreground/15 text-2xs"
        >
          ↵
        </span>
      </Button>
    )
  }
)

interface QuestionMinimizedBarProps {
  heading: string
  headingId: string
  onResume: () => void
  resumeRef?: React.Ref<HTMLButtonElement>
}

/** Collapsed panel: title, progress, the current question, and Resume. */
export function QuestionMinimizedBar({
  heading,
  headingId,
  onResume,
  resumeRef
}: QuestionMinimizedBarProps): React.JSX.Element {
  const { total } = useQuestionPanel('QuestionMinimizedBar')
  return (
    <div className="flex h-12 items-center gap-2.5 pl-4 pr-2 pointer-coarse:h-14">
      <QuestionPanelTitle />
      <QuestionProgress />
      <h2 id={headingId} className="min-w-0 flex-1 truncate text-[13px] text-secondary-foreground">
        {heading}
      </h2>
      {total > 1 ? <StepCount className="shrink-0 text-muted-foreground/70" /> : null}
      <Button
        ref={resumeRef}
        type="button"
        variant="secondary"
        size="xs"
        onClick={onResume}
        className="h-8 gap-1.5 rounded-lg pl-3 pr-2.5 text-[13px] pointer-coarse:min-h-11"
      >
        Resume
        <ChevronUp size={14} aria-hidden="true" className="text-muted-foreground" />
      </Button>
    </div>
  )
}
