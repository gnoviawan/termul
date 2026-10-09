import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { openerApi } from '@/lib/api'
import type { PendingElicitation } from '@/stores/acp-store'
import { useAcpStore } from '@/stores/acp-store'
import { CHAT_GUTTER_X } from './chat-layout'
import { ElicitationQuestions } from './ElicitationQuestions'

/**
 * Small form or URL prompt for an ACP elicitation request.
 * Primitive fields only: string, number, boolean, enum, and multi-enum.
 *
 * GH-935: a form whose fields are all titled `enum`/`multi-enum` questions
 * is an agent `ask_user_question` batch — it renders the styled
 * multi-question panel (`ElicitationQuestions`) instead of the generic
 * field loop. Untitled forms keep the generic path.
 */
export function ElicitationPrompt({ request }: { request: PendingElicitation }): React.JSX.Element {
  const respond = useAcpStore((s) => s.respondElicitation)
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({})
  const [submitting, setSubmitting] = useState(false)

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

  const submit = (action: 'accept' | 'decline' | 'cancel'): void => {
    const content: Record<string, string | number | boolean | string[]> = {}
    if (action === 'accept' && request.mode === 'form') {
      for (const field of request.fields) {
        const raw = values[field.name]
        const label = field.title?.trim() ? field.title : field.name
        if (field.kind === 'boolean') {
          if (raw === true || raw === false) content[field.name] = raw
          else if (field.required) {
            toast.error(`${label} is required.`)
            return
          }
          continue
        }
        if (field.kind === 'number' || field.kind === 'integer') {
          const number = Number(raw)
          const empty = raw === undefined || raw === ''
          if (empty) {
            if (field.required) {
              toast.error(`${label} is required.`)
              return
            }
            continue
          }
          if (!Number.isFinite(number) || (field.kind === 'integer' && !Number.isInteger(number))) {
            toast.error(
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
              toast.error(`${label} is required.`)
              return
            }
            continue
          }
          content[field.name] = list
          continue
        }
        const text = typeof raw === 'string' ? raw : ''
        if (!text && field.required) {
          toast.error(`${label} is required.`)
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

  return (
    <div
      role="dialog"
      aria-label={request.message}
      className={`${CHAT_GUTTER_X} border-t bg-card pb-2 pt-3`}
      data-testid="elicitation-prompt"
    >
      <div className="mx-auto w-full max-w-3xl space-y-3 rounded-2xl border border-border/60 bg-card px-4 py-3">
        {showMessage ? <p className="text-sm font-medium">{request.message}</p> : null}
        {questionShaped ? (
          <ElicitationQuestions
            pending={request}
            submitting={submitting}
            onSubmit={submitAnswers}
            onCancel={() => submit('cancel')}
          />
        ) : (
          <>
            {request.mode === 'url' && request.url ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (request.url) void openerApi.openUrlWithSystemBrowser(request.url)
                }}
              >
                Open link
              </Button>
            ) : null}
            {request.mode === 'form'
              ? request.fields.map((field) => (
                  <label key={field.name} className="block space-y-1 text-xs">
                    <span className="text-muted-foreground">
                      {field.title?.trim() ? field.title : field.name}
                    </span>
                    {field.description ? (
                      <span className="block text-muted-foreground/80">{field.description}</span>
                    ) : null}
                    {field.kind === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={values[field.name] === true}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [field.name]: event.target.checked
                          }))
                        }
                      />
                    ) : field.kind === 'enum' ? (
                      <select
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                        value={
                          typeof values[field.name] === 'string' ? String(values[field.name]) : ''
                        }
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [field.name]: event.target.value
                          }))
                        }
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
                        {field.options.map((option) => {
                          const list = Array.isArray(values[field.name])
                            ? (values[field.name] as string[])
                            : []
                          return (
                            <span key={option.value} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={list.includes(option.value)}
                                onChange={(event) =>
                                  setValues((current) => {
                                    const currentList = Array.isArray(current[field.name])
                                      ? (current[field.name] as string[])
                                      : []
                                    return {
                                      ...current,
                                      [field.name]: event.target.checked
                                        ? [...currentList, option.value]
                                        : currentList.filter((v) => v !== option.value)
                                    }
                                  })
                                }
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
                        type={
                          field.kind === 'number' || field.kind === 'integer' ? 'number' : 'text'
                        }
                        step={field.kind === 'integer' ? 1 : undefined}
                        value={
                          typeof values[field.name] === 'string' ? String(values[field.name]) : ''
                        }
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [field.name]: event.target.value
                          }))
                        }
                      />
                    )}
                  </label>
                ))
              : null}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => submit('cancel')}>
                Cancel
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => submit('decline')}>
                Decline
              </Button>
              <Button type="button" size="sm" onClick={() => submit('accept')}>
                {request.mode === 'url' ? 'Done' : 'Submit'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
