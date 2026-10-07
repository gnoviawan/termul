import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { openerApi } from '@/lib/api'
import type { PendingElicitation } from '@/stores/acp-store'
import { useAcpStore } from '@/stores/acp-store'
import { CHAT_GUTTER_X } from './chat-layout'

/**
 * Small form or URL prompt for an ACP elicitation request.
 * Primitive fields only: string, number, boolean, and enum.
 */
export function ElicitationPrompt({ request }: { request: PendingElicitation }): React.JSX.Element {
  const respond = useAcpStore((s) => s.respondElicitation)
  const [values, setValues] = useState<Record<string, string | boolean>>({})

  const submit = (action: 'accept' | 'decline' | 'cancel'): void => {
    const content: Record<string, string | number | boolean> = {}
    if (action === 'accept' && request.mode === 'form') {
      for (const field of request.fields) {
        const raw = values[field.name]
        if (field.kind === 'boolean') {
          if (raw === true || raw === false) content[field.name] = raw
          else if (field.required) {
            toast.error(`${field.name} is required.`)
            return
          }
          continue
        }
        if (field.kind === 'number' || field.kind === 'integer') {
          const number = Number(raw)
          const empty = raw === undefined || raw === ''
          if (empty) {
            if (field.required) {
              toast.error(`${field.name} is required.`)
              return
            }
            continue
          }
          if (!Number.isFinite(number) || (field.kind === 'integer' && !Number.isInteger(number))) {
            toast.error(
              field.kind === 'integer'
                ? `${field.name} must be a whole number.`
                : `${field.name} must be a finite number.`
            )
            return
          }
          content[field.name] = number
          continue
        }
        const text = typeof raw === 'string' ? raw : ''
        if (!text && field.required) {
          toast.error(`${field.name} is required.`)
          return
        }
        if (text) content[field.name] = text
      }
    }
    void respond(request.requestId, action, action === 'accept' ? content : undefined).catch(() => {
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
        <p className="text-sm font-medium">{request.message}</p>
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
                <span className="text-muted-foreground">{field.name}</span>
                {field.kind === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={values[field.name] === true}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.name]: event.target.checked }))
                    }
                  />
                ) : field.kind === 'enum' ? (
                  <select
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    value={typeof values[field.name] === 'string' ? String(values[field.name]) : ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.name]: event.target.value }))
                    }
                  >
                    <option value="">Select</option>
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={field.kind === 'number' || field.kind === 'integer' ? 'number' : 'text'}
                    step={field.kind === 'integer' ? 1 : undefined}
                    value={typeof values[field.name] === 'string' ? String(values[field.name]) : ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.name]: event.target.value }))
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
      </div>
    </div>
  )
}
