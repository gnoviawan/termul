/**
 * The parity matrix's data: surfaces (what a user can reach), the steps that
 * drive each one in both clients, and what a run records about them.
 */

import type { DiffResult, Rect } from '../parity/diff'

export type Client = 'web' | 'gpuix'
export const CLIENTS: readonly Client[] = ['web', 'gpuix']

/**
 * How an action finds its element. `testId` and `text` resolve natively in
 * both clients (GPUIX picks the match nearest the point the web client used);
 * `label` (an accessible name) and `css` exist only in the DOM, so GPUIX
 * replays the click at the web element's centre (or at `at`, an offset from
 * its top-left corner, for a spot inside a canvas such as a terminal row, or
 * at `frac`, a fraction of its size, for a drop zone such as a pane's edge).
 */
export type Target =
  | { testId: string }
  | { text: string; exact?: boolean }
  | {
      label: string
      role?: 'button' | 'tab' | 'menuitem' | 'option' | 'switch' | 'combobox' | 'checkbox' | 'link'
    }
  | { css: string; at?: { x: number; y: number }; frac?: { x: number; y: number } }

/** Keys are written in GPUI keystroke syntax (`ctrl-k`, `alt-,`, `escape`). */
export type Action =
  | { do: 'click'; target: Target; button?: 'right'; modifiers?: 'ctrl' }
  | { do: 'dblclick'; target: Target }
  | { do: 'hover'; target: Target }
  /** `gpuixKeys`: what GPUIX presses instead, when its desktop keymap binds the action elsewhere. */
  | { do: 'press'; keys: string; gpuixKeys?: string }
  | { do: 'type'; text: string }
  | { do: 'wheel'; target: Target; deltaY: number }
  | { do: 'drag'; from: Target; to: Target }
  | { do: 'wait'; ms: number }
  /**
   * Click `target`, which opens the OS file chooser, and pick `file` (a path
   * inside the world's root). The web answers Playwright's file chooser; GPUIX
   * answers the real portal dialog with X key events (x11-file-chooser.py).
   */
  | { do: 'choose'; target: Target; file: string }

/**
 * A text both clients must paint (or have stopped painting) once the step
 * settles; `within` scopes the search to the subtree of a test id both
 * clients set, so a match elsewhere on screen cannot pass the check.
 */
export type Check =
  | {
      text: string
      gone?: true
      within?: string
      order?: never
      /** How long a present check waits, for a surface that is slow to load. */
      timeoutMs?: number
    }
  | OrderCheck

/** Texts that must appear in this order inside the `within` subtree (a list after a reorder). */
export type OrderCheck = { order: string[]; within: string; text?: never; gone?: never }

export interface Step {
  name: string
  actions: Action[]
  expect: Check[]
}

/** The area a surface belongs to. Area weights live in `weights.ts`. */
export type AreaId =
  | 'rail'
  | 'side-panel'
  | 'explorer'
  | 'editor'
  | 'git'
  | 'chat'
  | 'composer'
  | 'terminal'
  | 'statusbar'
  | 'settings'
  | 'theme'
  | 'palette'
  | 'shortcuts'
  | 'browser'
  | 'canvas'
  | 'ssh'
  | 'notifications'
  | 'remote'
  | 'snapshots'
  | 'dialogs'

/**
 * What GPUIX is compared against.
 *
 * - `web`: the DOM web client in Chromium.
 * - `web-host-local`: the web client with the server's host-local credential
 *   added to its `/ws` handshake by a Playwright WebSocket route (no product
 *   code), and GPUIX attached with the same credential. Both then render the
 *   shared components only a host-local client gets (SSH, Claude account
 *   management), as the launched GPUIX app does.
 * - `tauri`: the shipped desktop app (Tauri on WebKitGTK) built from the same
 *   checkout, driven with X input (`tools/reference/`), for a surface the web
 *   client cannot render at all (the browser pane's native webview).
 */
export type Reference = 'web' | 'web-host-local' | 'tauri'

export interface Surface {
  id: string
  area: AreaId
  title: string
  steps: Step[]
  /** Default `web`. */
  reference?: Reference
  /**
   * Start both clients on this hash route (`#/snapshots`) instead of the
   * dashboard, and wait for `ready` instead of the dashboard's launcher text.
   * GPUIX starts there through `GPUIX_START_HASH`.
   */
  start?: { hash: string; ready: string }
  /** Web selector of the surface's region, measured after the last step and cropped from both frames. */
  roi?: string
  /** Not driven: the surface waits on another unit. */
  pending?: { unit: string; reason: string }
  /** Not driven: no reference to compare against, for the reason given. */
  blocked?: string
  /** Server-side setup run before each client's run (re-seeds what an earlier run changed). */
  prepare?(world: import('./world').World, client: Client): Promise<void>
}

export interface ActionLog {
  step: string
  action: string
  /** How the element was found: natively, or at the point the web client clicked. */
  via: 'testid' | 'text' | 'web-point' | 'dom' | 'key' | 'none'
  ok: boolean
  error?: string
}

export interface CheckLog {
  step: string
  text: string
  expect: 'present' | 'gone'
  pass: boolean
  /** How long the check waited for its text, so a late paint reads apart from a missing one. */
  ms?: number
}

export interface ClientRun {
  ok: boolean
  error?: string
  ms: number
  actions: ActionLog[]
  checks: CheckLog[]
  /** One frame per step, in step order. */
  frames: string[]
}

export interface StepDiff {
  step: string
  full: DiffResult
  roi?: { rect: Rect; diff: DiffResult; web: string; gpuix: string }
  diffPng: string
}

export type AutoStatus = 'ported' | 'partial' | 'broken' | 'blocked' | 'unverified' | 'pending-unit'

export interface SurfaceResult {
  id: string
  ranAt: string
  auto: AutoStatus
  /** Which client `web` holds; absent means the web client. */
  reference?: Reference
  /** The reference client's run: the web client's, or the Tauri app's when `reference` is `tauri`. */
  web?: ClientRun
  gpuix?: ClientRun
  diffs: StepDiff[]
  pending?: Surface['pending']
  blocked?: string
}
