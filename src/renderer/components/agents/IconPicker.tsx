import { Check, Pencil, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BUNDLED_ICON_CATALOG, findBundledIconBySvg } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import { cn } from '@/lib/utils'

const MAX_ICON_FILE_BYTES = 64 * 1024

interface IconPickerProps {
  value: string
  onChange: (svg: string) => void
}

/** Render a sanitized SVG icon string inline with white color. */
function InlineIcon({ svg, className }: { svg: string; className?: string }): React.JSX.Element {
  const sanitized = useMemo(() => sanitizeInlineAgentSvg(svg), [svg])
  return (
    <span
      className={cn('inline-flex text-white [&_svg]:h-full [&_svg]:w-full', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: icon SVG is sanitized via sanitizeInlineAgentSvg (DOMPurify)
      dangerouslySetInnerHTML={{ __html: sanitized ?? '' }}
    />
  )
}

/**
 * Modal icon picker — compact trigger button, full grid in a dialog.
 * Bundled icons render as white on muted/secondary backgrounds.
 * An upload affordance lets the user pick a custom SVG file from disk;
 * uploaded SVGs are sanitized (DOMPurify + viewBox requirement) and capped
 * at 64KB. Works in both desktop and web/remote mode (hidden file input).
 */
export function IconPicker({ value, onChange }: IconPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedEntry = useMemo(() => findBundledIconBySvg(value), [value])
  // A non-empty value not in the bundled catalog is a custom (uploaded) SVG.
  const isCustomSvg = value.length > 0 && !selectedEntry

  const handleSelect = (svg: string) => {
    onChange(svg)
    setOpen(false)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadError(null)

    if (file.size > MAX_ICON_FILE_BYTES) {
      setUploadError('Icon file too large (max 64KB).')
      // Reset so the same file can be re-selected after correction.
      e.target.value = ''
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const sanitized = sanitizeInlineAgentSvg(text)
      if (!sanitized) {
        setUploadError('Invalid SVG: must be a single `<svg>` with a `viewBox`.')
        e.target.value = ''
        return
      }
      onChange(sanitized)
      setOpen(false)
    }
    reader.onerror = () => {
      setUploadError('Failed to read the file.')
      e.target.value = ''
    }
    reader.readAsText(file)
  }

  const triggerIcon = selectedEntry ? (
    <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary p-1.5 hover:bg-secondary/80 transition-colors">
      <InlineIcon svg={selectedEntry.svg} className="h-5 w-5 text-foreground" />
    </div>
  ) : isCustomSvg ? (
    <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary p-1.5 hover:bg-secondary/80 transition-colors">
      <InlineIcon svg={value} className="h-5 w-5 text-foreground" />
    </div>
  ) : (
    <div className="flex h-9 w-9 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground hover:bg-secondary/60 transition-colors">
      <Pencil size={14} />
    </div>
  )

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0"
        title="Choose icon"
        aria-label="Choose icon"
      >
        {triggerIcon}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[400px] max-h-[70vh]">
          <DialogHeader>
            <DialogTitle className="text-sm">Choose icon</DialogTitle>
          </DialogHeader>

          <div className="overflow-y-auto max-h-[50vh] -mx-2 px-2">
            <div className="grid grid-cols-6 gap-2 py-2">
              {/* "No icon" option */}
              <button
                type="button"
                onClick={() => handleSelect('')}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-md border text-xs text-muted-foreground transition-colors',
                  !value
                    ? 'border-primary/60 bg-primary/10 text-foreground ring-2 ring-primary/30'
                    : 'border-border hover:bg-secondary'
                )}
                title="No icon"
                aria-label="No icon"
                aria-pressed={!value}
              >
                —
              </button>

              {/* Custom (uploaded) SVG — shown when value is non-bundled */}
              {isCustomSvg && (
                <button
                  type="button"
                  onClick={() => handleSelect(value)}
                  className={cn(
                    'relative flex h-9 w-9 items-center justify-center rounded-md border p-1.5 transition-colors',
                    'border-primary/60 bg-primary/10 ring-2 ring-primary/30 text-white'
                  )}
                  title="Custom uploaded icon"
                  aria-label="Custom uploaded icon"
                  aria-pressed
                >
                  <InlineIcon svg={value} className="h-5 w-5" />
                  <Check size={10} className="absolute -right-0.5 -top-0.5 text-primary" />
                </button>
              )}

              {BUNDLED_ICON_CATALOG.map((entry) => {
                const isSelected = selectedEntry?.key === entry.key
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => handleSelect(entry.svg)}
                    className={cn(
                      'relative flex h-9 w-9 items-center justify-center rounded-md border p-1.5 transition-colors',
                      isSelected
                        ? 'border-primary/60 bg-primary/10 ring-2 ring-primary/30 text-white'
                        : 'border-border bg-muted hover:bg-muted/80 text-white'
                    )}
                    title={entry.label}
                    aria-label={entry.label}
                    aria-pressed={isSelected}
                  >
                    <InlineIcon svg={entry.svg} className="h-5 w-5" />
                    {isSelected && (
                      <Check size={10} className="absolute -right-0.5 -top-0.5 text-primary" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Upload affordance */}
          <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary transition-colors"
            >
              <Upload size={12} />
              Upload custom SVG
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".svg,image/svg+xml"
              onChange={handleFileChange}
              className="hidden"
              aria-label="Upload custom SVG icon"
            />
            {uploadError && (
              <p role="alert" className="text-xs text-destructive">
                {uploadError}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
