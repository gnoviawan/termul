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
  | { do: 'press'; keys: string }
  | { do: 'type'; text: string }
  | { do: 'wheel'; target: Target; deltaY: number }
  | { do: 'drag'; from: Target; to: Target }
  | { do: 'wait'; ms: number }

/**
 * A text both clients must paint (or have stopped painting) once the step
 * settles; `within` scopes the search to the subtree of a test id both
 * clients set, so a match elsewhere on screen cannot pass the check.
 */
export type Check = { text: string; gone?: true; within?: string; order?: never } | OrderCheck

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

export interface Surface {
  id: string
  area: AreaId
  title: string
  steps: Step[]
  /** Web selector of the surface's region, measured after the last step and cropped from both frames. */
  roi?: string
  /** Not driven: the surface waits on another unit. */
  pending?: { unit: string; reason: string }
  /** Not driven: no reference to compare against, for the reason given. */
  blocked?: string
  /** Server-side setup run before each client's run (re-seeds what an earlier run changed). */
  prepare?(world: import('./world').World): Promise<void>
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
  web?: ClientRun
  gpuix?: ClientRun
  diffs: StepDiff[]
  pending?: Surface['pending']
  blocked?: string
}
