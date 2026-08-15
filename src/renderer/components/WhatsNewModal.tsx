import { AnimatePresence, motion } from 'framer-motion'
import { ExternalLink, Sparkles, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { renderChatMarkdown } from '@/lib/chat-markdown'
import { openerApi } from '@/lib/tauri-opener-api'

interface WhatsNewModalProps {
  isOpen: boolean
  version: string
  notes?: string | null
  htmlUrl?: string | null
  onClose: () => void
}

export function WhatsNewModal({
  isOpen,
  version,
  notes,
  htmlUrl,
  onClose
}: WhatsNewModalProps): React.JSX.Element {
  const { t } = useTranslation('shell')

  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose]
  )

  const handleViewOnGitHub = useCallback(() => {
    // Only hand http(s) URLs to the system opener; htmlUrl originates from a
    // network response, so guard against unexpected schemes.
    if (htmlUrl && /^https?:\/\//i.test(htmlUrl)) {
      void openerApi.openUrlWithSystemBrowser(htmlUrl)
    }
  }, [htmlUrl])

  // Release notes are GitHub-flavored markdown; render to sanitized HTML
  // (DOMPurify via the shared chat-markdown renderer) so headings, lists, and
  // links display properly instead of as raw markup.
  const notesHtml = useMemo(() => (notes ? renderChatMarkdown(notes) : null), [notes])

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-[500px] border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            role="dialog"
            aria-modal="true"
            aria-labelledby="whats-new-title"
            tabIndex={-1}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded bg-primary/10 flex items-center justify-center">
                  <Sparkles className="w-3 h-3 text-primary" />
                </div>
                <h3 id="whats-new-title" className="text-sm font-semibold text-foreground">
                  {t('whatsNew.title')}
                </h3>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t('whatsNew.close')}
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {/* Version Info */}
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('whatsNew.updatedTo')}
                </span>
                <span className="text-sm font-semibold text-foreground">{version}</span>
              </div>

              {/* Release Notes */}
              <div>
                <span className="block text-xs font-medium text-muted-foreground mb-1.5">
                  {t('whatsNew.releaseNotes')}
                </span>
                <div className="max-h-[320px] overflow-y-auto pr-1">
                  {notesHtml ? (
                    <div
                      className="chat-prose text-xs leading-relaxed text-foreground"
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via renderChatMarkdown (DOMPurify)
                      dangerouslySetInnerHTML={{ __html: notesHtml }}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {t('whatsNew.unavailable')}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border flex-wrap">
              {htmlUrl && (
                <button
                  type="button"
                  onClick={handleViewOnGitHub}
                  className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
                >
                  <ExternalLink size={13} />
                  <span>{t('whatsNew.viewGithub')}</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 shadow-md shadow-primary/20 transition-all"
              >
                {t('whatsNew.gotIt')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
