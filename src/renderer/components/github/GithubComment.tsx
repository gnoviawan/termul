import type { GithubComment as GithubCommentData } from '@shared/types/github.types'
import { AgentProse } from '@/components/chat/chat-agent-prose'
import { formatRelativeTime } from '@/lib/relative-time'

/** GitHub markdown, rendered by the chat's hardened renderer (links confirm before opening). */
export function GithubMarkdown({
  text,
  scope
}: {
  text: string
  /** Stable key for the external-link confirm (the comment id). */
  scope: string
}): React.JSX.Element {
  return <AgentProse text={text} streaming={false} reduced linkScope={scope} />
}

/** One conversation or review comment: author and time, then the markdown body. */
export function GithubComment({ comment }: { comment: GithubCommentData }): React.JSX.Element {
  return (
    <article className="min-w-0 rounded-lg border border-border bg-card">
      <header className="flex min-w-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate font-medium text-foreground">{comment.author}</span>
        <time
          dateTime={comment.createdAt}
          title={new Date(comment.createdAt).toLocaleString()}
          className="shrink-0 tabular-nums text-muted-foreground"
        >
          {formatRelativeTime(comment.createdAt)}
        </time>
      </header>
      <div className="min-w-0 px-3 py-2">
        {comment.body.trim() ? (
          <GithubMarkdown text={comment.body} scope={comment.id} />
        ) : (
          <p className="text-xs italic text-muted-foreground">No content.</p>
        )}
      </div>
    </article>
  )
}
