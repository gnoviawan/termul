import { useMemo } from 'react'
import { renderChatMarkdown } from '@/lib/chat-markdown'

/** The release notes body of the What's New modal, a scroll box of GitHub-flavored markdown. */
export function WhatsNewNotes({ notes }: { notes: string | null }): React.JSX.Element {
  // Rendered to sanitized HTML (DOMPurify via the shared chat-markdown
  // renderer) so headings, lists, and links display instead of raw markup.
  const notesHtml = useMemo(() => (notes ? renderChatMarkdown(notes) : null), [notes])

  return (
    <div className="max-h-[320px] overflow-y-auto pr-1">
      {notesHtml ? (
        <div
          className="chat-prose text-xs leading-relaxed text-foreground"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via renderChatMarkdown (DOMPurify)
          dangerouslySetInnerHTML={{ __html: notesHtml }}
        />
      ) : (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Release notes aren't available for this version.
        </p>
      )}
    </div>
  )
}
