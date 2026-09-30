/**
 * Shared constants for the browser lane (CAP-7) — re-exported so the lane's
 * entry points and the CLI agree on paths without a cycle through the
 * desktop runner.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOOLKIT_ROOT = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(TOOLKIT_ROOT, '..', '..')
export const RESULTS_ROOT = path.join(REPO_ROOT, 'tools', 'perf', 'results')

export type ScenarioFlags = Record<string, string | number | boolean | undefined>
