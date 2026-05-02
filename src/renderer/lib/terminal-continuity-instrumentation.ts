export type TerminalContinuityEventName =
  | 'project-switch-start'
  | 'transcript-persistence-evaluated'
  | 'restore-path-selected'
  | 'restore-replay-attempted'
  | 'restore-replay-succeeded'
  | 'restore-replay-failed'
  | 'restore-replay-skipped'
  | 'restore-complete'
  | 'restore-failed'
  | 'renderer-recovery-attempted'
  | 'renderer-recovery-succeeded'
  | 'renderer-recovery-exhausted'
  | 'renderer-recovery-failed'

export interface TerminalContinuityEvent {
  name: TerminalContinuityEventName
  timestamp: string
  correlationId?: string
  projectId?: string
  terminalId?: string
  ptyId?: string
  details?: Record<string, unknown>
}

interface TerminalContinuityDebugApi {
  getEvents: () => TerminalContinuityEvent[]
  clearEvents: () => void
}

const MAX_CONTINUITY_EVENTS = 500
const continuityEvents: TerminalContinuityEvent[] = []
const projectCorrelationIds = new Map<string, string>()

function nextCorrelationId(projectId: string): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `continuity-${projectId}-${Date.now()}-${suffix}`
}

function getDebugApiTarget(): Record<string, unknown> | null {
  if (typeof window === 'undefined') {
    return null
  }

  return window as unknown as Record<string, unknown>
}

function updateDebugApi(): void {
  const target = getDebugApiTarget()
  if (!target) {
    return
  }

  target.__TERMUL_CONTINUITY__ = {
    getEvents: () => getTerminalContinuityEvents(),
    clearEvents: () => clearTerminalContinuityEvents()
  } satisfies TerminalContinuityDebugApi
}

export function beginProjectContinuityCorrelation(projectId: string): string {
  const correlationId = nextCorrelationId(projectId)
  projectCorrelationIds.set(projectId, correlationId)
  updateDebugApi()
  return correlationId
}

export function getProjectContinuityCorrelation(projectId?: string): string | undefined {
  if (!projectId) {
    return undefined
  }

  return projectCorrelationIds.get(projectId)
}

export function getOrCreateProjectContinuityCorrelation(projectId?: string): string | undefined {
  if (!projectId) {
    return undefined
  }

  return getProjectContinuityCorrelation(projectId) ?? beginProjectContinuityCorrelation(projectId)
}

export function recordTerminalContinuityEvent(
  event: Omit<TerminalContinuityEvent, 'timestamp'>
): TerminalContinuityEvent {
  const fullEvent: TerminalContinuityEvent = {
    ...event,
    timestamp: new Date().toISOString()
  }

  continuityEvents.push(fullEvent)
  if (continuityEvents.length > MAX_CONTINUITY_EVENTS) {
    continuityEvents.splice(0, continuityEvents.length - MAX_CONTINUITY_EVENTS)
  }

  updateDebugApi()

  if (import.meta.env.DEV) {
    console.log('[terminal-continuity]', fullEvent)
  }

  return fullEvent
}

export function getTerminalContinuityEvents(): TerminalContinuityEvent[] {
  return [...continuityEvents]
}

export function clearTerminalContinuityEvents(): void {
  continuityEvents.length = 0
  projectCorrelationIds.clear()
  updateDebugApi()
}

updateDebugApi()
