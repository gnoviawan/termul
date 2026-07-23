/**
 * ACP agent-plan compliance metadata for bundled registry agents.
 *
 * Termul renders execution plans only from the standard ACP path:
 * `session/update` with `sessionUpdate: "plan"` (full replace each update).
 * See https://agentclientprotocol.com/protocol/v1/agent-plan
 *
 * Vendor-specific extensions (e.g. Cursor `cursor/update_todos`) are not
 * normalized — agents must emit the standard plan update for PlanPanel to show.
 */

/** Compliance tier for bundled registry agents. */
export type AcpPlanComplianceStatus =
  /** Not yet verified against the standard plan wire path. */
  | 'unknown'
  /** Verified: emits standard `session/update` plan notifications. */
  | 'standard'
  /** Uses a non-standard extension instead of the spec plan update. */
  | 'non_standard_extension'
  /** Documented: agent adapter does not emit execution plans. */
  | 'unsupported'

/** Registry ids with a known plan compliance tier (audit: 2026-07-17). */
const KNOWN_COMPLIANCE: Partial<Record<string, AcpPlanComplianceStatus>> = {
  cursor: 'non_standard_extension',
  'pi-acp': 'unsupported'
}

/** Strip the `acp-registry:` prefix from config or live agent ids. */
export function registryIdFromAgentId(agentId: string): string {
  return agentId.startsWith('acp-registry:') ? agentId.slice('acp-registry:'.length) : agentId
}

/** Look up plan compliance for a live agent or config id. */
export function getAcpPlanCompliance(agentOrRegistryId: string): AcpPlanComplianceStatus {
  const id = registryIdFromAgentId(agentOrRegistryId)
  return KNOWN_COMPLIANCE[id] ?? 'unknown'
}

/** Whether the chat UI should show a plan-support hint (no entries yet). */
export function shouldShowPlanSupportHint(
  compliance: AcpPlanComplianceStatus,
  planEntryCount: number
): boolean {
  if (planEntryCount > 0) return false
  return compliance === 'non_standard_extension' || compliance === 'unsupported'
}

/** Human-readable hint for known non-compliant agents. */
export function planSupportHintMessage(compliance: AcpPlanComplianceStatus): string | null {
  switch (compliance) {
    case 'non_standard_extension':
      return 'This agent does not emit ACP standard execution plans (session/update plan). PlanPanel stays empty until the agent complies with the Agent Plan protocol.'
    case 'unsupported':
      return 'Execution plans are not supported by this agent adapter.'
    default:
      return null
  }
}
