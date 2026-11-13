import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  Hourglass,
  Loader2,
  Square,
  XCircle
} from '@/components/icons'
import { cn } from '@/lib/utils'
import { STATUS_PRESENTATION } from '../../automation-format'
import type { StepView } from './run-overlay'

/** Label, tone and glyph of each step status. Blue (`running`) is live work only. */
export const STEP_VIEW: Record<
  StepView,
  { label: string; className: string; Icon: typeof CircleCheck }
> = {
  pending: { label: 'Not reached', className: 'text-muted-foreground', Icon: CircleDashed },
  running: { ...STATUS_PRESENTATION.running, Icon: Loader2 },
  succeeded: { ...STATUS_PRESENTATION.succeeded, Icon: CircleCheck },
  failed: { ...STATUS_PRESENTATION.failed, Icon: XCircle },
  skipped: { ...STATUS_PRESENTATION.skipped, Icon: CircleMinus },
  waiting: { ...STATUS_PRESENTATION.waiting, Icon: Hourglass },
  cancelled: { ...STATUS_PRESENTATION.cancelled, Icon: Square }
}

export function StepGlyph({
  status,
  size = 16,
  className
}: {
  status: StepView
  size?: number
  className?: string
}): React.JSX.Element {
  const { Icon, className: tone } = STEP_VIEW[status]
  return (
    <Icon
      size={size}
      aria-hidden="true"
      className={cn('shrink-0', tone, status === 'running' && 'animate-spin', className)}
    />
  )
}
