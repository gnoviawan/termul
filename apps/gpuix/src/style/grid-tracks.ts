/**
 * CSS `grid-template-columns` track lists. GPUIX takes only a count of equal
 * tracks (gpuix#103), so a list such as `1fr 6rem` is parsed here and the
 * compat runtime lays the grid out as rows of flex cells (compat/grid.ts).
 */

import { type CssVars, parseLength, splitTopLevel } from './css-value'

export type GridTrack =
  | { kind: 'fixed'; px: number }
  /** `Nfr`; `min` is the px floor of `minmax(<min>, Nfr)`, 0 for a bare `Nfr`. */
  | { kind: 'fr'; fr: number; min: number }
  /** auto, min-content, max-content, fit-content(): sized by the cell's content. */
  | { kind: 'content' }

const FR = /^(\d+(?:\.\d+)?)fr$/
const CONTENT = new Set(['auto', 'min-content', 'max-content'])

function call(text: string, name: string): string[] | undefined {
  if (!text.startsWith(`${name}(`) || !text.endsWith(')')) return undefined
  return splitTopLevel(text.slice(name.length + 1, -1), ',').map((part) => part.trim())
}

function length(text: string, vars: CssVars): number | undefined {
  try {
    return parseLength(text, vars)
  } catch {
    return undefined
  }
}

function track(text: string, vars: CssVars): GridTrack | undefined {
  const fr = FR.exec(text)
  if (fr) return { kind: 'fr', fr: Number(fr[1]), min: 0 }
  if (CONTENT.has(text) || call(text, 'fit-content')) return { kind: 'content' }
  const minmax = call(text, 'minmax')
  if (minmax?.length === 2) {
    const [min, max] = minmax
    const maxTrack = track(max, vars)
    if (maxTrack?.kind === 'fr') {
      const floor = CONTENT.has(min) ? 0 : length(min, vars)
      return floor === undefined ? undefined : { ...maxTrack, min: floor }
    }
    return maxTrack
  }
  const px = length(text, vars)
  return px === undefined ? undefined : { kind: 'fixed', px }
}

/** The tracks of a column template, or undefined when one of them is not understood. */
export function parseGridTracks(template: string, vars: CssVars = {}): GridTrack[] | undefined {
  const tracks: GridTrack[] = []
  for (const part of splitTopLevel(template.trim(), ' ')) {
    if (part === '') continue
    const repeat = call(part, 'repeat')
    if (repeat) {
      const count = Number(repeat[0])
      const inner = parseGridTracks(repeat.slice(1).join(','), vars)
      if (!Number.isInteger(count) || count < 1 || !inner) return undefined
      for (let i = 0; i < count; i++) tracks.push(...inner)
      continue
    }
    const one = track(part, vars)
    if (!one) return undefined
    tracks.push(one)
  }
  return tracks.length > 0 ? tracks : undefined
}

/** Whether GPUIX's own `gridTemplateColumns: N` (N tracks of `minmax(0, 1fr)`) draws these tracks. */
export function isEqualFrTracks(tracks: readonly GridTrack[]): boolean {
  return tracks.every((t) => t.kind === 'fr' && t.fr === 1 && t.min === 0)
}

declare module '@gpuix/native/host' {
  interface StyleDesc {
    /**
     * Not a native field: a column track list GPUIX cannot draw. The compat
     * runtime consumes it (compat/grid.ts) and never hands it to the renderer.
     * Unset on a style whose `gridTemplateColumns` count is the whole story.
     */
    gridTracks?: readonly GridTrack[]
  }
}
