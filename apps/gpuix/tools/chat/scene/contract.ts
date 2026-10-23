/** What the Bun-typed scene entry and the app-side scene boot share. */

export interface SceneBox {
  x: number
  y: number
  width: number
  height: number
}

/** A harness command: rest at the live edge, or put row `index` at the top, `offset` px into it. */
export type SceneCommand =
  | { seq: number; scroll: 'bottom' }
  | { seq: number; scroll: 'row'; index: number; offset: number }

export interface SceneOptions<Renderer> {
  sessionId: string
  box: SceneBox
  onRenderer: (renderer: Renderer) => void
  /** A JSON file the harness rewrites with a `SceneCommand`. */
  control?: string
}
