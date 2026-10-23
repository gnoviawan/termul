/**
 * Usage weights per area (they sum to 100) and the score each status earns.
 * The doc explains the weights; change them here and rerun
 * `bun run parity:matrix --report-only`.
 */

import type { AreaId } from './types'

export const AREA_WEIGHTS: Record<AreaId, number> = {
  chat: 17,
  composer: 14,
  terminal: 14,
  rail: 9,
  git: 9,
  explorer: 7,
  editor: 7,
  'side-panel': 5,
  settings: 4,
  statusbar: 3,
  palette: 3,
  theme: 2,
  shortcuts: 1,
  dialogs: 1,
  notifications: 1,
  browser: 1,
  canvas: 0.5,
  ssh: 0.5,
  remote: 0.5,
  snapshots: 0.5
}

export type Status = 'ported' | 'partial' | 'broken' | 'blocked' | 'unverified' | 'pending-unit'

/** Ported counts fully, partial counts half, everything else counts zero. */
export const STATUS_SCORE: Record<Status, number> = {
  ported: 1,
  partial: 0.5,
  broken: 0,
  blocked: 0,
  unverified: 0,
  'pending-unit': 0
}
