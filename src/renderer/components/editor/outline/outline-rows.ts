import type { TocHeading } from '@/hooks/use-toc-headings'

export interface OutlineRow {
  heading: TocHeading
  /** Collapse key. Stable across edits that do not change level or text. */
  key: string
  /** 0 for the shallowest heading in the list. Drives indent and weight. */
  depth: number
  hasChildren: boolean
  isCollapsed: boolean
  /** Rows hidden under this row while it is collapsed. */
  hiddenCount: number
}

export interface OutlineModel {
  /** Rows that show (not inside a collapsed parent). */
  rows: OutlineRow[]
  /** Every parent key in the list, for "Collapse all". */
  parentKeys: string[]
  /** Maps a heading id to the id of the visible row that stands for it. */
  visibleIdFor: Map<string, string>
}

/**
 * Key for collapse state: `level:text:n`, where n counts earlier headings
 * with the same level and text. Heading ids are line numbers (CodeMirror)
 * or block ids (BlockNote), so they move on edit or mode switch; the key
 * does not.
 */
export function getOutlineKeys(headings: TocHeading[]): string[] {
  const seen = new Map<string, number>()
  return headings.map((heading) => {
    const base = `${heading.level}:${heading.text}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return `${base}:${count}`
  })
}

/** Shallowest heading level in the list (6 when the list is empty). */
export function getMinHeadingLevel(headings: TocHeading[]): number {
  return headings.reduce((min, heading) => Math.min(min, heading.level), 6)
}

export function buildOutlineModel(
  headings: TocHeading[],
  collapsedKeys: ReadonlySet<string>
): OutlineModel {
  const keys = getOutlineKeys(headings)
  const minLevel = getMinHeadingLevel(headings)
  const rows: OutlineRow[] = []
  const parentKeys: string[] = []
  const visibleIdFor = new Map<string, string>()
  // Open ancestors: their level and, when collapsed, their row.
  const stack: Array<{ level: number; collapsedRow: OutlineRow | null }> = []

  headings.forEach((heading, index) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop()
    }

    const next = headings[index + 1]
    const hasChildren = Boolean(next && next.level > heading.level)
    const key = keys[index]
    if (hasChildren) {
      parentKeys.push(key)
    }

    const hiddenBy = stack.find((entry) => entry.collapsedRow !== null)?.collapsedRow ?? null

    if (hiddenBy) {
      hiddenBy.hiddenCount += 1
      visibleIdFor.set(heading.id, hiddenBy.heading.id)
      stack.push({ level: heading.level, collapsedRow: null })
      return
    }

    const isCollapsed = hasChildren && collapsedKeys.has(key)
    const row: OutlineRow = {
      heading,
      key,
      depth: Math.max(0, heading.level - minLevel),
      hasChildren,
      isCollapsed,
      hiddenCount: 0
    }
    rows.push(row)
    visibleIdFor.set(heading.id, heading.id)
    stack.push({ level: heading.level, collapsedRow: isCollapsed ? row : null })
  })

  return { rows, parentKeys, visibleIdFor }
}

/** "H1–H3" with an en dash; "H1" when the depth is 1. */
export function formatDepthLabel(level: number): string {
  return level <= 1 ? 'H1' : `H1–H${level}`
}
