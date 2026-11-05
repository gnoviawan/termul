import type { ComponentType } from 'react'

export type SectionId = 'foundations' | 'components' | 'patterns' | 'surfaces'

/** One preview on the canvas. `id` is stable and keys saved positions. */
export interface CanvasEntry {
  id: string
  /** Readable name; clicking it copies this exact text. */
  name: string
  /** Source module the preview renders from, shown as a caption. */
  source: string
  width: number
  height: number
  Preview: ComponentType
}

export interface CanvasGroup {
  id: string
  title: string
  entries: CanvasEntry[]
}

export interface CanvasSection {
  id: SectionId
  title: string
  description: string
  groups: CanvasGroup[]
}

export interface PlacedEntry extends CanvasEntry {
  section: SectionId
  group: string
  x: number
  y: number
}

export interface CanvasLabel {
  id: string
  kind: 'section' | 'group'
  title: string
  description?: string
  x: number
  y: number
  width: number
}
