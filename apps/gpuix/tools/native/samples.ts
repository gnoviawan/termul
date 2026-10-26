/** Shared by the patch scene and its checker. */
export const SCENE = { width: 640, height: 720 } as const
export const SAMPLES = [
  'upright',
  'italic',
  'link',
  'codeFull',
  'codeHalf',
  'codeTight',
  'codePad',
  'input',
  'blur',
  'table',
  'gridSpan'
] as const
/** Set on the unfocused input after mount, like a URL bar after a navigation: ink at the start, dots at the end. */
export const LONG_VALUE = `${'M'.repeat(10)}${'.'.repeat(120)}`
/** The blur sample: 4 px black and white stripes, the right half under a `backdropBlur` box. */
export const BLUR = { width: 320, height: 48, stripe: 4, sigma: 8, radius: 12 } as const
/** Inline padding of the `codePad` chip; the chip's text moves the text after it by twice this. */
export const CODE_PAD = 12
/** The table sample: a header and one body row, 1 px rule between them. */
export const TABLE = { padY: 10, lineHeight: 20, rows: 2 } as const
export const TABLE_HEADER_FILL = '#ff0000'
/** A grid of GRID.columns equal tracks GRID.width wide; its first cell spans two of them. */
export const GRID = { width: 300, columns: 3, span: 2 } as const
export type Sample = (typeof SAMPLES)[number]
export interface SceneReady {
  bounds: Record<Sample, { x: number; y: number; width: number; height: number } | null>
  handle: { kind: string; id?: number | null } | null
  pid: number
  /** `getAllText()` and `getAutomationTree()` as the scene saw them. */
  allText: string[]
  tree: AutomationNode | null
}
export interface AutomationNode {
  type: string
  text?: string
  children?: AutomationNode[]
}
