import { X } from 'lucide-react'
import type { LoadedAgentSkill } from '@/hooks/use-agent-skills'
import { cn } from '@/lib/utils'

interface LoadedSkillChipProps {
  skill: LoadedAgentSkill
  onRemove: () => void
  className?: string
}

/** Shows the active Agent Skill above a prompt input (chat or launcher). */
export function LoadedSkillChip({
  skill,
  onRemove,
  className
}: LoadedSkillChipProps): React.JSX.Element {
  return (
    <div className={cn('flex items-start gap-2 border-b border-border/40 px-4 py-1.5', className)}>
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        Skill: <span className="font-medium text-foreground break-words">{skill.name}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        aria-label="Remove loaded skill"
        title="Remove skill"
      >
        <X size={12} />
      </button>
    </div>
  )
}
