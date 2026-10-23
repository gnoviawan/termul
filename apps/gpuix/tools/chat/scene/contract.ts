/** What the Bun-typed scene entry and the app-side scene boot share. */

export interface SceneBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A harness command: rest at the live edge, put host row `index` (or the
 * first row of timeline item `key`) at the top `offset` px into it, or send
 * a prompt as the composer would.
 */
export type SceneCommand =
  | { seq: number; scroll: 'bottom' }
  | { seq: number; scroll: 'row'; index: number; offset: number }
  | { seq: number; scroll: 'item'; key: string; offset: number }
  | { seq: number; prompt: string }
  | {
      seq: number /** Write the perf probe's records to `SceneOptions.perfOut`. */
      flushPerf: true
    }

/** File access the app-side boot gets from the Bun entry, so it stays free of node:fs types. */
export interface ControlIo {
  read(file: string): SceneCommand | null
  write(file: string, text: string): void
}

/** What the scene's perf probe records, in epoch ms. */
export interface ScenePerf {
  /** Every frame GPUI drew: when the probe saw the counter move, and its draw time. */
  frames: Array<{ t: number; drawMs: number }>
  /** Storm chunk id -> when its marker first reached a committed `<markdown>` source. */
  commits: Record<number, number>
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
  /** Turns the perf probe on; `flushPerf` writes `ScenePerf` here. */
  perfOut?: string
}
