import { type Camera, clampCamera, clampPoint, isFiniteNumber, type Point } from './camera'

/**
 * Saved layout: camera, theme id and item positions keyed by registry id.
 * Nothing else is stored. Membership, names and sizes always come from source.
 */
export const LAYOUT_STORAGE_KEY = 'termul.design-system-canvas.layout'
export const LAYOUT_VERSION = 1
const MAX_DOCUMENT_BYTES = 200_000
const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,80}$/

export interface SavedLayout {
  camera: Camera | null
  themeId: string | null
  positions: Record<string, Point>
}

const EMPTY: SavedLayout = { camera: null, themeId: null, positions: {} }

function readCamera(value: unknown): Camera | null {
  if (!value || typeof value !== 'object') return null
  const { x, y, z } = value as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z) || z <= 0) return null
  return clampCamera({ x, y, z })
}

function readPoint(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null
  const { x, y } = value as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null
  return clampPoint({ x, y })
}

export function loadLayout(
  validIds: ReadonlySet<string>,
  isValidTheme: (id: string) => boolean
): SavedLayout {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY)
  } catch {
    return EMPTY
  }
  if (!raw || raw.length > MAX_DOCUMENT_BYTES) return EMPTY
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return EMPTY
  }
  if (!doc || typeof doc !== 'object') return EMPTY
  const record = doc as Record<string, unknown>
  // Unknown versions fall back to defaults.
  if (record.v !== LAYOUT_VERSION) return EMPTY

  const positions: Record<string, Point> = {}
  const rawPositions = record.positions
  if (rawPositions && typeof rawPositions === 'object') {
    for (const [id, value] of Object.entries(rawPositions as Record<string, unknown>)) {
      if (!ID_PATTERN.test(id) || !validIds.has(id)) continue
      const point = readPoint(value)
      if (point) positions[id] = point
    }
  }
  const themeId =
    typeof record.themeId === 'string' && isValidTheme(record.themeId) ? record.themeId : null
  return { camera: readCamera(record.camera), themeId, positions }
}

export function saveLayout(layout: SavedLayout): void {
  const doc = {
    v: LAYOUT_VERSION,
    camera: layout.camera,
    themeId: layout.themeId,
    positions: layout.positions
  }
  try {
    const text = JSON.stringify(doc)
    if (text.length > MAX_DOCUMENT_BYTES) return
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, text)
  } catch {
    // Storage unavailable or full: the canvas keeps working without saving.
  }
}
