import { forwardRef } from 'react'
import { AgentGlyph } from '@/components/chat/AgentGlyph'
import { ModeIcon } from '@/components/chat/mode-menu'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

interface MobileModelPillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  agentTemplateId: string | null
  agentIcon: string | null
  label: string
  /** Muted after the label; dropped while a switch is armed. */
  effort?: string
  /** A mode other than the agent's first one, so Plan and the like stay visible. */
  modeId?: string
  armed: boolean
  pending: boolean
}

/**
 * The phone composer's model pill: agent glyph, model name, then the effort in
 * muted text. The model name truncates first; the rest keeps its width.
 */
export const MobileModelPill = forwardRef<HTMLButtonElement, MobileModelPillProps>(
  function MobileModelPill(
    { agentTemplateId, agentIcon, label, effort, modeId, armed, pending, className, ...props },
    ref
  ) {
    return (
      <button
        ref={ref}
        type="button"
        aria-busy={pending || undefined}
        className={cn(
          "relative inline-flex h-10 min-w-0 items-center gap-1.5 rounded-full bg-foreground/[0.06] px-3.5 text-sm text-foreground transition-[background-color,transform] duration-150 ease-out after:absolute after:-inset-y-0.5 after:inset-x-0 after:content-[''] enabled:active:scale-[0.96] enabled:active:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:text-disabled-foreground",
          className
        )}
        {...props}
      >
        <AgentGlyph templateId={agentTemplateId} icon={agentIcon} size={14} className="shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        {!armed && effort ? <span className="shrink-0 text-muted-foreground">{effort}</span> : null}
        {modeId ? <ModeIcon modeId={modeId} size={14} /> : null}
        {pending ? <Spinner size={12} decorative className="shrink-0" /> : null}
      </button>
    )
  }
)
