import type { AgentId, BackgroundCommandList, SessionId } from '@/lib/acp-api'

/** Live-only session state the host reports by event and in its agent listing. */
interface HostSessionState {
  /** `agent_working`: the agent works outside a prompt turn. */
  working: boolean
  /** `background_commands`: the commands the agent left running. */
  backgroundCommands: BackgroundCommandList
}

type Report<K extends keyof HostSessionState> = { value: HostSessionState[K]; seq: number }

/**
 * The newest report per session, agent and kind. A reopen reads the agent
 * listing over a round trip; a report from the adopted owner that arrives
 * meanwhile is newer and wins. Keyed by agent too, so a late report of a
 * former owner never hides the current owner's.
 */
const reports = new Map<string, { [K in keyof HostSessionState]?: Report<K> }>()
let reportSeq = 0

const reportKey = (sessionId: SessionId, agentId: AgentId): string => `${sessionId}\u0000${agentId}`

export function recordHostReport<K extends keyof HostSessionState>(
  sessionId: SessionId,
  agentId: AgentId,
  kind: K,
  value: HostSessionState[K]
): void {
  reportSeq += 1
  const key = reportKey(sessionId, agentId)
  reports.set(key, { ...reports.get(key), [kind]: { value, seq: reportSeq } })
}

export function hostReportSeq(): number {
  return reportSeq
}

export function latestHostReport<K extends keyof HostSessionState>(
  sessionId: SessionId,
  agentId: AgentId,
  kind: K
): Report<K> | undefined {
  return reports.get(reportKey(sessionId, agentId))?.[kind] as Report<K> | undefined
}

export function hostReportAfter<K extends keyof HostSessionState>(
  sessionId: SessionId,
  agentId: AgentId,
  kind: K,
  seq: number
): HostSessionState[K] | undefined {
  const report = latestHostReport(sessionId, agentId, kind)
  return report && report.seq > seq ? report.value : undefined
}

export function forgetHostReports(sessionId: SessionId): void {
  const prefix = `${sessionId}\u0000`
  for (const key of reports.keys()) {
    if (key.startsWith(prefix)) reports.delete(key)
  }
}
