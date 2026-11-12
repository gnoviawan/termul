import type { NodeKind } from '@shared/types/automation.types'
import { useState } from 'react'
import { MENU_CONTENT_CLASS, MENU_LABEL_CLASS } from '@/components/ui/menu-styles'
import {
  MobileSheetContent,
  SheetGroup,
  SheetRow,
  SheetSearchField
} from '@/components/ui/mobile-sheet'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { PopoverSearchBand } from '@/components/ui/popover-search-band'
import { Sheet } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { NODE_KIND_PRESENTATION } from '../../automation-format'
import { PALETTE_GROUPS } from './node-kinds'

/** `dataTransfer` type a menu row carries when it is dragged onto the canvas. */
export const NODE_KIND_MIME = 'application/x-troupe-node-kind'

function groupsMatching(query: string, exclude: readonly NodeKind[]) {
  const q = query.trim().toLowerCase()
  return PALETTE_GROUPS.map((group) => ({
    ...group,
    kinds: group.kinds.filter(
      (kind) =>
        !exclude.includes(kind) &&
        (q === '' || NODE_KIND_PRESENTATION[kind].label.toLowerCase().includes(q))
    )
  })).filter((group) => group.kinds.length > 0)
}

/**
 * Picks the kind of a new step. The toolbar "+", a dangling "+", an edge
 * dropped on blank canvas and the "+" on an edge all open it. Desktop shows a
 * menu at `anchor` whose rows also drag onto the canvas; the phone shows a
 * bottom sheet.
 */
export function AddNodeMenu({
  anchor,
  phone,
  exclude = [],
  onPick,
  onClose
}: {
  /** Viewport point the menu opens at; null closes it. */
  anchor: { x: number; y: number } | null
  phone: boolean
  exclude?: readonly NodeKind[]
  onPick: (kind: NodeKind) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const open = anchor !== null
  const groups = groupsMatching(query, exclude)
  const onOpenChange = (next: boolean) => {
    if (!next) {
      setQuery('')
      onClose()
    }
  }
  const pick = (kind: NodeKind) => {
    setQuery('')
    onPick(kind)
  }

  if (phone) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <MobileSheetContent title="Add a step" aria-describedby={undefined}>
          <SheetSearchField
            value={query}
            onChange={setQuery}
            placeholder="Search steps"
            label="Search steps"
          />
          {groups.map((group) => (
            <SheetGroup key={group.label} label={group.label}>
              {group.kinds.map((kind) => {
                const { label, Icon } = NODE_KIND_PRESENTATION[kind]
                return (
                  <SheetRow
                    key={kind}
                    title={label}
                    icon={<Icon size={18} aria-hidden="true" />}
                    onSelect={() => pick(kind)}
                  />
                )
              })}
            </SheetGroup>
          ))}
        </MobileSheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed size-0"
          style={{ left: anchor?.x ?? 0, top: anchor?.y ?? 0 }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        aria-label="Add a step"
        className={cn(MENU_CONTENT_CLASS, 'w-60 p-0')}
        onKeyDown={(event) => {
          // Enter in the search field takes the top match; on a row it presses that row.
          if (event.key === 'Enter' && event.target instanceof HTMLInputElement && groups[0]) {
            event.preventDefault()
            pick(groups[0].kinds[0])
          }
        }}
      >
        <PopoverSearchBand
          // The menu opens on purpose; typing filters at once.
          autoFocus
          value={query}
          onChange={setQuery}
          placeholder="Search steps"
          ariaLabel="Search steps"
          inputClassName="text-sm"
        />
        <div className="max-h-80 overflow-y-auto p-1">
          {groups.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">No step matches.</p>
          )}
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <p className={MENU_LABEL_CLASS}>{group.label}</p>
              {group.kinds.map((kind) => {
                const { label, Icon } = NODE_KIND_PRESENTATION[kind]
                return (
                  <button
                    key={kind}
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(NODE_KIND_MIME, kind)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => pick(kind)}
                    className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06]"
                  >
                    <Icon size={16} className="shrink-0 text-muted-foreground" />
                    {label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
