/**
 * Where animation frames live on disk, for an svg that steps through fixed
 * frames (the spinner). `src/env/comet-frames.ts` installs the Bun side
 * before the app loads; without it, a step sends the SVG markup itself.
 */

/** Saves `svg` as `name` once and returns the file's path. */
export type FrameStore = (name: string, svg: string) => string

let store: FrameStore | null = null

export function setFrameStore(next: FrameStore | null): void {
  store = next
}

export function frameStore(): FrameStore | null {
  return store
}
