import { type ComponentPropsWithoutRef, memo, useCallback, useContext, useState } from 'react'
import {
  type ControlsConfig,
  StreamdownContext,
  TableCopyDropdown,
  TableDownloadDropdown
} from 'streamdown'
import { Copy, Download, Maximize2, X } from '@/components/icons'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
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
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  return (
    <>
      <IconActionButton
        label="View fullscreen"
        onClick={() => setOpen(true)}
        disabled={disabled}
        size="sm"
      >
        <Maximize2 />
      </IconActionButton>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close()
        }}
      >
        <DialogContent
          data-streamdown="table-fullscreen"
          className="inset-0 left-0 top-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0 [&>button]:hidden"
        >
          <DialogTitle className="sr-only">Table</DialogTitle>
          <DialogDescription className="sr-only">Full screen table</DialogDescription>
          <div className="flex h-full flex-col" data-streamdown="table-wrapper">
            <div className="flex items-center justify-end p-4">
              <IconActionGroup className="gap-1">
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
                <IconActionButton label="Exit fullscreen" onClick={close}>
                  <X />
                </IconActionButton>
              </IconActionGroup>
            </div>
            <div className="scroller-thin flex-1 overflow-auto px-4 pb-4 pt-0 [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10">
              <table className="w-full border-collapse border border-border">{children}</table>
            </div>
          </div>
        </DialogContent>
      </Dialog>
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
        className="scroller-thin max-w-full overflow-x-auto bg-background"
        aria-label="Markdown table"
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
