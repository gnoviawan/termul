import { logFrontendError } from '@/lib/log-api'
import type { WorkspaceTab } from '@/stores/workspace-store'

export type WorkspaceTabKind = WorkspaceTab['type']

/**
 * Per tab kind: whether it is written to the project's workspace record
 * (`persisted`). `satisfies Record<WorkspaceTabKind, …>` makes a new
 * `WorkspaceTab['type']` member a compile error here until its persistence
 * story is declared. Canvas is not persisted: its daemon/iframe runtime is
 * host-local state and the canvas re-opens user-initiated, never
 * auto-restored.
 */
export const WORKSPACE_TAB_KIND_TRAITS = {
  terminal: { persisted: true },
  editor: { persisted: true },
  browser: { persisted: true },
  git: { persisted: true },
  'agent-chat': { persisted: true },
  'git-history': { persisted: true },
  diff: { persisted: true },
  canvas: { persisted: false }
} as const satisfies Record<WorkspaceTabKind, { persisted: boolean }>

/** The tab kinds that are written to the workspace record (derived from the traits). */
export type PersistedWorkspaceTabKind = {
  [K in WorkspaceTabKind]: (typeof WORKSPACE_TAB_KIND_TRAITS)[K]['persisted'] extends true
    ? K
    : never
}[WorkspaceTabKind]

/** Whether `kind` names a `WorkspaceTab['type']` this build knows about. */
export function isWorkspaceTabKind(kind: unknown): kind is WorkspaceTabKind {
  return (
    typeof kind === 'string' &&
    Object.prototype.hasOwnProperty.call(WORKSPACE_TAB_KIND_TRAITS, kind)
  )
}

const MAX_LOGGED_KIND_LENGTH = 40

function describeKind(kind: unknown): string {
  if (kind === undefined || kind === null) return String(kind)
  if (typeof kind !== 'string') return `<${typeof kind}>`
  // Strip control characters and cap the length: the kind comes from persisted
  // JSON and must never smuggle a payload or a log-injection line into the log.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitisation
  const clean = kind.replace(/[\u0000-\u001f\u007f]/g, '?')
  return clean.length > MAX_LOGGED_KIND_LENGTH
    ? `${clean.slice(0, MAX_LOGGED_KIND_LENGTH)}…`
    : clean
}

/**
 * Exhaustiveness sink for a `switch (tab.type)` default branch. Statically the
 * value is `never` (a new union member fails typecheck at the call site), but
 * persisted JSON is not type-checked, so at runtime it can be anything — read
 * `type` defensively and warn-log only the truncated kind, never the payload.
 */
export function reportUnknownTabKind(tab: never, source: string, action: string): void {
  const kind = (tab as { type?: unknown } | null | undefined)?.type
  void logFrontendError({
    level: 'warn',
    source,
    message: `Unrecognised workspace tab kind "${describeKind(kind)}" — ${action}`
  })
}
