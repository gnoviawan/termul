import { Check, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  BUNDLED_ICON_CATALOG,
  findBundledIconBySvg,
  normalizeIconSvg
} from '@/lib/agents/agent-icon-catalog'
import { cn } from '@/lib/utils'

interface IconPickerProps {
  value: string
  onChange: (svg: string) => void
}

/** Render an SVG icon string inline with white color. */
function InlineIcon({ svg, className }: { svg: string; className?: string }): React.JSX.Element {
  return (
    <span
      className={cn('inline-flex text-white [&_svg]:h-full [&_svg]:w-full', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: icon SVG is sanitized via normalizeIconSvg (DOMPurify)
      dangerouslySetInnerHTML={{ __html: normalizeIconSvg(svg) }}
    />
  )
}

/**
 * Modal icon picker — compact trigger button, full grid in a dialog.
 * All icons render as white on muted/secondary backgrounds.
 */
export function IconPicker({ value, onChange }: IconPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const selectedEntry = useMemo(() => findBundledIconBySvg(value), [value])

  const handleSelect = (svg: string) => {
    onChange(svg)
    setOpen(false)
  }

  const triggerIcon = selectedEntry ? (
    <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary p-1.5 hover:bg-secondary/80 transition-colors">
      <InlineIcon svg={selectedEntry.svg} className="h-5 w-5 text-foreground" />
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
        </DialogContent>
      </Dialog>
    </>
  )
}
