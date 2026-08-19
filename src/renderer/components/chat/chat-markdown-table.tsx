import { Copy, Download, Maximize2, X } from 'lucide-react'
import {
  type ComponentPropsWithoutRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  type ControlsConfig,
  StreamdownContext,
  TableCopyDropdown,
  TableDownloadDropdown
} from 'streamdown'
import { IconActionButton, IconActionGroup } from '@/components/ui/icon-action-button'
import { cn } from '@/lib/utils'

type TableControlKey = 'copy' | 'download' | 'fullscreen'

function tableControlsEnabled(controls: ControlsConfig): boolean {
  if (typeof controls === 'boolean') return controls
  return controls.table !== false
}

function tableControlEnabled(controls: ControlsConfig, key: TableControlKey): boolean {
  if (typeof controls === 'boolean') return controls
  const table = controls.table
  if (table === false) return false
  if (table === true || table === undefined) return true
  return table[key] !== false
}

interface TableFullscreenProps {
  children: React.ReactNode
  showCopy: boolean
  showDownload: boolean
  disabled?: boolean
}

/** Fullscreen table viewer — symmetric toolbar; wrapper keeps copy/download working. */
function TableFullscreen({
  children,
  showCopy,
  showDownload,
  disabled = false
}: TableFullscreenProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  return (
    <>
      <IconActionButton
        label={t('code.viewFullscreen')}
        onClick={() => setOpen(true)}
        disabled={disabled}
        size="sm"
      >
        <Maximize2 />
      </IconActionButton>
      {open
        ? createPortal(
            <div
              aria-label={t('code.viewFullscreen')}
              aria-modal="true"
              className="fixed inset-0 z-50 flex flex-col bg-background"
              data-streamdown="table-fullscreen"
              onClick={close}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close()
              }}
              role="dialog"
            >
              <div
                className="flex h-full flex-col"
                data-streamdown="table-wrapper"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                role="presentation"
              >
                <div className="flex items-center justify-end p-4">
                  <IconActionGroup className="gap-0.5" dense>
                    {showCopy ? (
                      <TableCopyDropdown>
                        <Copy />
                      </TableCopyDropdown>
                    ) : null}
                    {showDownload ? (
                      <TableDownloadDropdown>
                        <Download />
                      </TableDownloadDropdown>
                    ) : null}
                    <IconActionButton label={t('code.exitFullscreen')} onClick={close} size="sm">
                      <X />
                    </IconActionButton>
                  </IconActionGroup>
                </div>
                <div className="flex-1 overflow-auto px-4 pb-4 pt-0 [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10">
                  <table className="w-full border-collapse border border-border">{children}</table>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

type ChatMarkdownTableProps = ComponentPropsWithoutRef<'table'> & {
  node?: unknown
}

/**
 * Streamdown `components.table` override: symmetric copy/download/fullscreen
 * controls in IconActionGroup chrome (matches fenced code + MessageActions).
 */
function ChatMarkdownTableComponent({
  children,
  className,
  node: _node,
  ...props
}: ChatMarkdownTableProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { controls, isAnimating } = useContext(StreamdownContext)
  const showControls = tableControlsEnabled(controls)
  const showCopy = showControls && tableControlEnabled(controls, 'copy')
  const showDownload = showControls && tableControlEnabled(controls, 'download')
  const showFullscreen = showControls && tableControlEnabled(controls, 'fullscreen')
  const toolbar = showCopy || showDownload || showFullscreen

  return (
    <div
      className="my-1 min-w-0 overflow-hidden rounded-md border border-border/40"
      data-streamdown="table-wrapper"
    >
      {toolbar ? (
        <div
          className="flex justify-end border-b border-border/40 px-1 py-0.5"
          data-streamdown="table-toolbar"
        >
          <IconActionGroup className="gap-0.5" dense>
            {showCopy ? (
              <TableCopyDropdown>
                <Copy />
              </TableCopyDropdown>
            ) : null}
            {showDownload ? (
              <TableDownloadDropdown>
                <Download />
              </TableDownloadDropdown>
            ) : null}
            {showFullscreen ? (
              <TableFullscreen
                showCopy={showCopy}
                showDownload={showDownload}
                disabled={isAnimating}
              >
                {children}
              </TableFullscreen>
            ) : null}
          </IconActionGroup>
        </div>
      ) : null}
      <section
        className="max-w-full overflow-x-auto bg-background"
        aria-label={t('code.markdownTable')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable table region is intentionally focusable so keyboard users can scroll wide tables (WAI-ARIA scrollable-region pattern)
        tabIndex={0}
      >
        <table
          className={cn('w-full divide-y divide-border text-sm', className)}
          data-streamdown="table"
          {...props}
        >
          {children}
        </table>
      </section>
    </div>
  )
}

export const ChatMarkdownTable = memo(ChatMarkdownTableComponent)
