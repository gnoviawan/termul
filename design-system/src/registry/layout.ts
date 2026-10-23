import type { CanvasLabel, CanvasSection, PlacedEntry, SectionId } from './types'

/**
 * Deterministic default layout. Sections are horizontal bands stacked
 * top to bottom; each group is a labeled column; entries stack inside it.
 * Groups wrap to a new row once a band passes SECTION_MAX_WIDTH.
 */
const SECTION_MAX_WIDTH = 4600
const SECTION_HEADER = 132
const SECTION_GAP = 200
const GROUP_HEADER = 44
const GROUP_GAP_X = 88
const GROUP_GAP_Y = 120
const ENTRY_CHROME = 36
const ENTRY_GAP = 40

export interface CanvasLayout {
  entries: PlacedEntry[]
  labels: CanvasLabel[]
  sectionBounds: Record<SectionId, { minX: number; minY: number; maxX: number; maxY: number }>
}

export function layoutSections(sections: CanvasSection[]): CanvasLayout {
  const entries: PlacedEntry[] = []
  const labels: CanvasLabel[] = []
  const sectionBounds = {} as CanvasLayout['sectionBounds']
  let y = 0

  for (const section of sections) {
    const top = y
    labels.push({
      id: `section.${section.id}`,
      kind: 'section',
      title: section.title,
      description: section.description,
      x: 0,
      y,
      width: 1200
    })
    y += SECTION_HEADER
    let x = 0
    let rowHeight = 0
    let maxX = 1200

    for (const group of section.groups) {
      const columnWidth = Math.max(...group.entries.map((entry) => entry.width))
      if (x > 0 && x + columnWidth > SECTION_MAX_WIDTH) {
        x = 0
        y += rowHeight + GROUP_GAP_Y
        rowHeight = 0
      }
      labels.push({
        id: `group.${section.id}.${group.id}`,
        kind: 'group',
        title: group.title,
        x,
        y,
        width: columnWidth
      })
      let entryY = y + GROUP_HEADER
      for (const entry of group.entries) {
        entries.push({ ...entry, section: section.id, group: group.id, x, y: entryY })
        entryY += ENTRY_CHROME + entry.height + ENTRY_GAP
      }
      rowHeight = Math.max(rowHeight, entryY - ENTRY_GAP - y)
      maxX = Math.max(maxX, x + columnWidth)
      x += columnWidth + GROUP_GAP_X
    }
    y += rowHeight
    sectionBounds[section.id] = { minX: 0, minY: top, maxX, maxY: y }
    y += SECTION_GAP
  }

  return { entries, labels, sectionBounds }
}
