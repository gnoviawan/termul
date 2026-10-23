/** What the Bun-typed scene entry and the app-side scene boot share. */

export interface SceneBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A harness command: rest at the live edge, put row `index` at the top
 * `offset` px into it, or send a prompt as the composer would.
 */
export type SceneCommand =
  | { seq: number; scroll: 'bottom' }
  | { seq: number; scroll: 'row'; index: number; offset: number }
  | { seq: number; prompt: string }

/** File access the app-side boot gets from the Bun entry, so it stays free of node:fs types. */
export interface ControlIo {
  read(file: string): SceneCommand | null
}

/** Show a session that exists, or start a chat the way the launcher does. */
export type SceneTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'start'; configId: string; projectId: string; cwd: string }

export interface SceneOptions<Renderer> {
  target: SceneTarget
  box: SceneBox
  onRenderer: (renderer: Renderer) => void
  /** A JSON file the harness rewrites with a `SceneCommand`. */
  control?: string
}
