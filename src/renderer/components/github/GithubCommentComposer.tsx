import type { IpcResult } from '@shared/types/ipc.types'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { WriteGate } from '@/components/ui/write-gate'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { cn } from '@/lib/utils'

interface GithubCommentComposerProps {
  label: string
  /** Show the label (the conversation box) or keep it for screen readers only (a thread reply). */
  showLabel?: boolean
  submitLabel: string
  placeholder: string
  /** Post the markdown; a failure keeps the text and shows the error. */
  onSubmit: (body: string) => Promise<IpcResult<unknown>>
  onCancel?: () => void
  autoFocus?: boolean
  className?: string
}

/**
 * Markdown box that posts to GitHub (CAP-11 comments, PR review-thread
 * replies). Cmd/Ctrl+Enter submits. The text clears only once GitHub accepts
 * the comment; the panel then shows the comment GitHub returned.
 */
export function GithubCommentComposer({
  label,
  showLabel = false,
  submitLabel,
  placeholder,
  onSubmit,
  onCancel,
  autoFocus,
  className
}: GithubCommentComposerProps): React.JSX.Element {
  const id = useId()
  const gated = !useServerAdmitsRemoteWrites()
  const buttonSize = useMobileWebShell() ? 'touch' : 'sm'
  const [body, setBody] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canSubmit = !gated && !posting && body.trim().length > 0

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setPosting(true)
    setError(null)
    const result = await onSubmit(body)
    setPosting(false)
    if (result.success) {
      setBody('')
      onCancel?.()
    } else {
      setError(result.error || "GitHub didn't accept the comment.")
    }
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <Label htmlFor={id} className={showLabel ? 'text-sm font-medium' : 'sr-only'}>
        {label}
      </Label>
      <Textarea
        id={id}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          } else if (event.key === 'Escape' && onCancel && !posting) {
            event.preventDefault()
            onCancel()
          }
        }}
        placeholder={placeholder}
        disabled={gated}
        autoFocus={autoFocus}
        aria-describedby={error ? `${id}-error` : undefined}
        className="min-h-[72px] resize-y"
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button
            variant="ghost"
            size={buttonSize}
            className="px-3"
            onClick={onCancel}
            disabled={posting}
          >
            Cancel
          </Button>
        )}
        <WriteGate gated={gated}>
          <Button
            variant="secondary"
            size={buttonSize}
            className="px-3"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {posting ? 'Posting…' : submitLabel}
          </Button>
        </WriteGate>
      </div>
    </div>
  )
}
