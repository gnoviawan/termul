/** Shared by the patch scene and its checker. */
export const SCENE = { width: 640, height: 800 } as const
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
  'gridSpan',
  'gridTracks',
  'gridPlaced',
  'untracked',
  'tracked',
  'bullet',
  'imageHref',
  'svgNesting'
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
/**
 * A 300 px grid of tracks 100 px, 1fr and 50 px; one cell placed in the last
 * track of the first row, and a content-sized cell in the first, whose
 * content sets the row's height.
 */
export const GRID_TRACKS = {
  width: 300,
  tracks: [
    { kind: 'fixed', px: 100 },
    { kind: 'fr', fr: 1, min: 0 },
    { kind: 'fixed', px: 50 }
  ],
  column: 3,
  left: 250,
  cell: 50,
  contentHeight: 24
} as const
/** `letterSpacing` of the `tracked` sample, in em of its 32 px glyphs: 8 px between glyphs. */
export const TRACKING = { em: 0.25, size: 32, glyphs: 4 } as const
/** The `bullet` sample's list: a red "•" centred in a `width` column, the item text `gap` after it. */
export const BULLET = { width: 40, gap: 20, color: '#ff0000' } as const
/**
 * The `imageHref` sample: an `<img>` of an SVG that paints a green bar and
 * embeds a red PNG through `<image href>`. GPUI's SVG renderer must paint the
 * bar and never resolve the href. As tall as the `input` sample beside it.
 */
export const IMAGE_HREF = { size: 40, bar: 8 } as const
/**
 * The `svgNesting` sample: two `<img>` SVGs of one rect inside nested groups,
 * a green one `allowed` levels deep and a red one `refused` levels deep, either
 * side of the 256 levels zed/0010 lets through. Both decode without
 * overflowing a stack on the published addon, so the row fails there by
 * painting red rather than by crashing the scene.
 */
export const SVG_NESTING = { size: 40, allowed: 250, refused: 300 } as const
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
