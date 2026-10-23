/** Fixed cell rects of the ui gallery, shared by both renderers and the per-state diff. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const GALLERY_WIDTH = 1280
export const GALLERY_HEIGHT = 800

export const CELLS = {
  buttons: { x: 40, y: 40, width: 1200, height: 56 },
  'button-sizes': { x: 40, y: 112, width: 1200, height: 56 },
  fields: { x: 40, y: 184, width: 1200, height: 96 },
  toggles: { x: 40, y: 296, width: 1200, height: 48 },
  misc: { x: 40, y: 360, width: 1200, height: 48 },
  'overlay-trigger': { x: 40, y: 40, width: 600, height: 48 },
  'event-log': { x: 40, y: 760, width: 600, height: 24 }
} satisfies Record<string, Rect>

export type CellId = keyof typeof CELLS

export const SCENES = ['controls', 'dialog', 'dropdown', 'popover', 'tooltip', 'select'] as const
export type SceneId = (typeof SCENES)[number]

/** Regions compared per state: the control cells, or the area an overlay opens into. */
export const STATE_REGIONS: Record<SceneId, Record<string, Rect>> = {
  controls: {
    buttons: CELLS.buttons,
    'button-sizes': CELLS['button-sizes'],
    'input-textarea': CELLS.fields,
    'switch-badges': CELLS.toggles,
    'kbd-skeleton-spinner': CELLS.misc
  },
  dialog: { 'dialog-open': { x: 0, y: 0, width: GALLERY_WIDTH, height: GALLERY_HEIGHT } },
  dropdown: { 'dropdown-open': { x: 40, y: 40, width: 400, height: 280 } },
  popover: { 'popover-open': { x: 40, y: 40, width: 400, height: 220 } },
  tooltip: { 'tooltip-open': { x: 40, y: 40, width: 300, height: 120 } },
  select: { 'select-open': { x: 40, y: 40, width: 400, height: 220 } }
}

export function isScene(value: string | undefined): value is SceneId {
  return (SCENES as readonly string[]).includes(value ?? '')
}
