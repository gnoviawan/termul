/**
 * Whether an element is out of the GPUI frame, for code that animates on a
 * timer. A browser does not paint a hidden pane, so a CSS animation inside it
 * costs nothing. On GPUIX each animation step is a new mutation batch, so a
 * spinner in a parked chat should skip its steps. `park.ts` installs the
 * answer; with nothing installed, every element is in the frame.
 */

let query: (id: number) => boolean = () => false

export function setOffFrameQuery(next: ((id: number) => boolean) | null): void {
  query = next ?? (() => false)
}

export function isOffFrame(id: number): boolean {
  return query(id)
}
