import { Info } from 'lucide-react'
import {
  getAcpPlanCompliance,
  planSupportHintMessage,
  shouldShowPlanSupportHint
} from '@/lib/agents/acp-plan-compliance'

interface PlanSupportHintProps {
  agentId: string
  planEntryCount: number
}

/** Muted banner when a known agent does not emit standard ACP execution plans. */
export function PlanSupportHint({
  agentId,
  planEntryCount
}: PlanSupportHintProps): React.JSX.Element | null {
  const compliance = getAcpPlanCompliance(agentId)
  if (!shouldShowPlanSupportHint(compliance, planEntryCount)) return null
  const message = planSupportHintMessage(compliance)
  if (!message) return null

  return (
    <div className="shrink-0 border-b border-border/40 bg-muted/20 px-5 py-2">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-2 text-xs text-muted-foreground">
        <Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p className="text-pretty">{message}</p>
      </div>
    </div>
  )
}
