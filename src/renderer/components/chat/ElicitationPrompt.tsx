import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FileQuestion } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { ElicitationField } from '@/lib/acp-api'
import { openerApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { PendingElicitation } from '@/stores/acp-store'
import { useAcpStore } from '@/stores/acp-store'
import { CHAT_GUTTER_X } from './chat-layout'
import { ElicitationQuestions } from './ElicitationQuestions'

interface ElicitationPromptProps {
  request: PendingElicitation
  /**
   * Mobile: move focus into the prompt when it mounts: the "Request from the
   * agent" heading of a generic form, or the dialog itself (named by the
   * message) for a question batch. Read at mount only; both targets are
   * focusable on the mobile shell alone.
   */
  autoFocusHeading?: boolean
}

type FieldValue = string | boolean | string[]

/**
 * Small form or URL prompt for an ACP elicitation request.
 * Primitive fields only: string, number, boolean, enum, and multi-enum.
 *
 * GH-935: a form whose fields are all titled `enum`/`multi-enum` questions
 * is an agent `ask_user_question` batch — it replaces the composer with the
 * one-question-at-a-time stepper (`ElicitationQuestions`) instead of the
 * generic field loop. Untitled forms keep the generic path.
 *
 * On the mobile shell the "Request from the agent" heading is focusable,
 * buttons and fields are touch sized, and a failed validation shows inline
 * (`role="alert"`) next to the field as well as in the toast. The question
 * stepper already ships touch sized rows and buttons, so only its arrival
 * focus changes (the dialog, named by the message, takes it).
 */
export function ElicitationPrompt({
  request,
  autoFocusHeading = false
}: ElicitationPromptProps): React.JSX.Element {
  const respond = useAcpStore((s) => s.respondElicitation)
  const isMobileShell = useMobileWebShell()
  const [values, setValues] = useState<Record<string, FieldValue>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ field: string; message: string } | null>(null)
  const errorId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({})
  const focusAtMount = useRef(autoFocusHeading)

  const questionShaped =
    request.mode === 'form' &&
    request.fields.length > 0 &&
    request.fields.every(
      (field) =>
        (field.kind === 'enum' || field.kind === 'multi-enum') && Boolean(field.title?.trim())
    )
  // The wire `message` often repeats a field `description` verbatim (Devin
  // sends the first question as the message) — skip the duplicate heading.
  const showMessage =
    !questionShaped || request.fields.every((field) => field.description !== request.message)

  useEffect(() => {
    if (!focusAtMount.current)
      return // A question batch has no "Request from the agent" heading: land on the
      // dialog (named by the message) so the arrival still announces the prompt
      // instead of leaving focus behind.
    ;(headingRef.current ?? dialogRef.current)?.focus()
  }, [])

  const setValue = (name: string, value: FieldValue): void => {
    setValues((current) => ({ ...current, [name]: value }))
    setError((current) => (current?.field === name ? null : current))
  }

  /** Toast the validation message; on mobile also show it inline and focus the field. */
  const fail = (field: ElicitationField, message: string): void => {
    toast.error(message)
    if (!isMobileShell) return
    setError({ field: field.name, message })
    fieldRefs.current[field.name]?.focus()
  }

  const submit = (action: 'accept' | 'decline' | 'cancel'): void => {
    const content: Record<string, string | number | boolean | string[]> = {}
    if (action === 'accept' && request.mode === 'form') {
      for (const field of request.fields) {
        const raw = values[field.name]
        const label = field.title?.trim() ? field.title : field.name
        if (field.kind === 'boolean') {
          if (raw === true || raw === false) content[field.name] = raw
          else if (field.required) {
            fail(field, `${label} is required.`)
            return
          }
          continue
        }
        if (field.kind === 'number' || field.kind === 'integer') {
          const number = Number(raw)
          const empty = raw === undefined || raw === ''
          if (empty) {
            if (field.required) {
              fail(field, `${label} is required.`)
              return
            }
            continue
          }
          if (!Number.isFinite(number) || (field.kind === 'integer' && !Number.isInteger(number))) {
            fail(
              field,
              field.kind === 'integer'
                ? `${label} must be a whole number.`
                : `${label} must be a finite number.`
            )
            return
          }
          content[field.name] = number
          continue
        }
        if (field.kind === 'multi-enum') {
          const list = Array.isArray(raw) ? raw : []
          if (list.length === 0) {
            if (field.required) {
              fail(field, `${label} is required.`)
              return
            }
            continue
          }
          content[field.name] = list
          continue
        }
        const text = typeof raw === 'string' ? raw : ''
        if (!text && field.required) {
          fail(field, `${label} is required.`)
          return
        }
        if (text) content[field.name] = text
      }
    }
    void respond(request.requestId, action, action === 'accept' ? content : undefined).catch(() => {
      toast.error('Could not send your answer. Try again.')
    })
  }

  // Question mode: the card panel builds the answer map (`string` for enum,
  // `string[]` for multi-enum) — accept resolves with only answered keys.
  const submitAnswers = (answers: Record<string, string | string[]>): void => {
    setSubmitting(true)
    void respond(request.requestId, 'accept', answers).catch(() => {
      setSubmitting(false)
      toast.error('Could not send your answer. Try again.')
    })
  }

  const buttonSize = isMobileShell ? 'touch' : 'sm'
  const questionHeadingId = `elicitation-question-heading-${request.requestId}`

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label={request.message}
      tabIndex={isMobileShell ? -1 : undefined}
      className={cn(CHAT_GUTTER_X, 'pb-6 pt-3', isMobileShell && 'outline-none')}
      data-testid="elicitation-prompt"
      data-approval-prompt={`elicitation:${request.requestId}`}
    >
      {/* Composer-surface chrome (rounded-2xl border bg-card, max-w-3xl): the
          composer morphs into the question dialog rather than surfacing a
          separate warning-tinted notice. */}
      <section
        aria-labelledby={
          questionShaped ? questionHeadingId : `elicitation-title-${request.requestId}`
        }
        aria-live="polite"
        className={cn(
          'mx-auto w-full max-w-3xl rounded-2xl border border-border/60 bg-card transition-[border-color,box-shadow]',
          'focus-within:border-border focus-within:ring-1 focus-within:ring-inset focus-within:ring-foreground/20',
          !questionShaped && 'px-3.5 py-3 sm:px-4'
        )}
      >
        {questionShaped ? (
          <ElicitationQuestions
            pending={request}
            submitting={submitting}
            headingId={questionHeadingId}
            note={showMessage ? request.message : undefined}
            onSubmit={submitAnswers}
            onCancel={() => submit('cancel')}
          />
        ) : (
          <>
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-secondary text-muted-foreground">
                <FileQuestion size={13} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  ref={headingRef}
                  id={`elicitation-title-${request.requestId}`}
                  tabIndex={isMobileShell ? -1 : undefined}
                  className={cn(
                    'text-xs font-semibold leading-5 text-foreground',
                    isMobileShell && 'outline-none'
                  )}
                >
                  Request from the agent
                </h2>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {request.message}
                </p>
              </div>
            </div>
            <div className="mt-3 space-y-3">
              {request.mode === 'url' && request.url ? (
                <Button
                  type="button"
                  size={buttonSize}
                  variant="outline"
                  onClick={() => {
                    if (request.url) void openerApi.openUrlWithSystemBrowser(request.url)
                  }}
                >
                  Open link
                </Button>
              ) : null}
              {request.mode === 'form'
                ? request.fields.map((field) => {
                    const label = field.title?.trim() ? field.title : field.name
                    const invalid = isMobileShell && error?.field === field.name
                    // Mobile-only field semantics; desktop keeps its baseline attributes.
                    const fieldA11y = isMobileShell
                      ? {
                          'aria-required': field.required ? true : undefined,
                          'aria-invalid': invalid ? true : undefined,
                          'aria-describedby': invalid ? errorId : undefined
                        }
                      : {}
                    const registerField = (el: HTMLElement | null): void => {
                      fieldRefs.current[field.name] = el
                    }
                    const value =
                      typeof values[field.name] === 'string' ? String(values[field.name]) : ''
                    const mobileBooleanRow = isMobileShell && field.kind === 'boolean'
                    const caption = (
                      <>
                        <span className="text-muted-foreground">{label}</span>
                        {field.description ? (
                          <span className="block text-muted-foreground/80">
                            {field.description}
                          </span>
                        ) : null}
                      </>
                    )
                    return (
                      <Fragment key={field.name}>
                        {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is nested inside this label (implicit association); the kind-conditional defeats the rule's static analysis */}
                        <label
                          className={cn(
                            'text-xs',
                            mobileBooleanRow
                              ? 'flex min-h-11 items-center justify-between gap-3'
                              : 'block space-y-1'
                          )}
                        >
                          {mobileBooleanRow ? <span className="min-w-0">{caption}</span> : caption}
                          {field.kind === 'boolean' ? (
                            isMobileShell ? (
                              <Switch
                                ref={registerField}
                                checked={values[field.name] === true}
                                onCheckedChange={(checked) => setValue(field.name, checked)}
                                {...fieldA11y}
                              />
                            ) : (
                              <input
                                type="checkbox"
                                checked={values[field.name] === true}
                                onChange={(event) => setValue(field.name, event.target.checked)}
                              />
                            )
                          ) : field.kind === 'enum' ? (
                            <select
                              ref={registerField}
                              className={cn(
                                'w-full rounded-md border border-border bg-background px-2 py-1',
                                isMobileShell
                                  ? 'min-h-11 text-base'
                                  : 'text-sm pointer-coarse:text-base'
                              )}
                              value={value}
                              onChange={(event) => setValue(field.name, event.target.value)}
                              {...fieldA11y}
                            >
                              <option value="">Select</option>
                              {field.options.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                  {option.description ? ` — ${option.description}` : ''}
                                </option>
                              ))}
                            </select>
                          ) : field.kind === 'multi-enum' ? (
                            <span className="block space-y-1">
                              {field.options.map((option, index) => {
                                const list = Array.isArray(values[field.name])
                                  ? (values[field.name] as string[])
                                  : []
                                return (
                                  <span
                                    key={option.value}
                                    className={cn(
                                      'flex items-center gap-2 text-sm',
                                      isMobileShell && 'min-h-11'
                                    )}
                                  >
                                    <input
                                      ref={index === 0 ? registerField : undefined}
                                      type="checkbox"
                                      checked={list.includes(option.value)}
                                      onChange={(event) =>
                                        setValue(
                                          field.name,
                                          event.target.checked
                                            ? [...list, option.value]
                                            : list.filter((v) => v !== option.value)
                                        )
                                      }
                                      {...(index === 0 ? fieldA11y : {})}
                                    />
                                    <span>
                                      {option.label}
                                      {option.description ? (
                                        <span className="text-muted-foreground">
                                          {' '}
                                          — {option.description}
                                        </span>
                                      ) : null}
                                    </span>
                                  </span>
                                )
                              })}
                            </span>
                          ) : (
                            <Input
                              ref={registerField}
                              type={
                                field.kind === 'number' || field.kind === 'integer'
                                  ? 'number'
                                  : 'text'
                              }
                              step={field.kind === 'integer' ? 1 : undefined}
                              className={isMobileShell ? 'h-11 md:text-base' : undefined}
                              value={value}
                              onChange={(event) => setValue(field.name, event.target.value)}
                              {...fieldA11y}
                            />
                          )}
                        </label>
                        {invalid && error ? (
                          <p id={errorId} role="alert" className="text-xs text-destructive">
                            {error.message}
                          </p>
                        ) : null}
                      </Fragment>
                    )
                  })
                : null}
              <div className={cn('flex justify-end', isMobileShell ? 'gap-3' : 'gap-2')}>
                <Button
                  type="button"
                  size={buttonSize}
                  variant="outline"
                  onClick={() => submit('cancel')}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size={buttonSize}
                  variant="outline"
                  onClick={() => submit('decline')}
                >
                  Decline
                </Button>
                <Button type="button" size={buttonSize} onClick={() => submit('accept')}>
                  {request.mode === 'url' ? 'Done' : 'Submit'}
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
