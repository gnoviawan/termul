/** What the terminal pane scene's Bun entry, its app side and the harness share. */

/** A harness command, applied once per new `seq`. */
export type PaneCommand =
  | { seq: number; open: { projectId: string; cwd: string } }
  | { seq: number; switchTo: string }
  /** Baseline: flip a 1px box and time its commit and first frame, like a switch. */
  | { seq: number; ping: true }
  /** Report the elements under a window point, topmost first. */
  | { seq: number; hit: { x: number; y: number } }
  /** Unmount every pane host and mount it again, as a tree rebuild does. */
  | { seq: number; remount: true }

export interface PaneTerminalState {
  storeId: string
  ptyId: string | null
  projectId: string
  /** Screen size the view last fitted. */
  cols: number
  rows: number
  visibleText: string[]
  selection: string
  /** Window-relative grid origin and cell size, for pointer math. */
  grid: { x: number; y: number; cellWidth: number; cellHeight: number } | null
}

export interface PaneSceneState {
  seq: number
  activeProjectId: string
  terminals: PaneTerminalState[]
  /** `view.mount` count per store terminal: a cached remount does not build a new screen. */
  screensBuilt: Record<string, number>
  /** The last switch: ms from command to the React commit and to the first GPUI frame after it. */
  lastSwitch: {
    projectId: string
    /** Time inside the store actions (React renders synchronously in them). */
    activateMs: number | null
    commitMs: number
    frameMs: number | null
  } | null
  /** The last `ping`: the same clocks as `lastSwitch` for a trivial update. */
  lastPing: { commitMs: number; frameMs: number | null } | null
  /** Duration of the previous state publish (automation tree walk included). */
  publishMs: number
  /** `elementId:type:testId` under the last `hit` point, topmost first. */
  hit: string[]
}

export interface ControlIo {
  read(file: string): PaneCommand | null
  write(file: string, text: string): void
}

export interface PaneBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PaneSceneOptions<Renderer> {
  control: string
  stateFile: string
  /** Where the pane body sits (the tab strip goes right above it); the whole window by default. */
  box?: PaneBox
  onRenderer: (renderer: Renderer) => void
}
