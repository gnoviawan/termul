import { motion, type Transition, useReducedMotion } from 'framer-motion'
import { Bug, FileText, ListChecks, Sparkles } from 'lucide-react'
import type { AgentId } from '@/lib/acp-api'
import { useAgentIdentity } from '@/stores/acp-store'
import { AgentGlyph } from './AgentGlyph'
import { CHAT_SPRING } from './chat-motion'

interface Suggestion {
  icon: React.ComponentType<{ className?: string }>
  label: string
  prompt: string
}

const SUGGESTIONS: Suggestion[] = [
  {
    icon: Sparkles,
    label: 'Explain this project',
    prompt: 'Give me a high-level overview of this codebase and how it is structured.'
  },
  {
    icon: Bug,
    label: 'Find a bug',
    prompt: 'Look for potential bugs or edge cases in the code I currently have open.'
  },
  {
    icon: ListChecks,
    label: 'Write tests',
    prompt: 'Write unit tests for the file I am currently working on.'
  },
  {
    icon: FileText,
    label: 'Summarize changes',
    prompt: 'Summarize my recent uncommitted git changes.'
  }
]

interface ChatEmptyStateProps {
  agentId: AgentId
  /** Seed the composer with a chosen prompt. */
  onPick?: (text: string) => void
}

/** First-run state for an empty thread: agent identity + clickable starter prompts. */
export function ChatEmptyState({ agentId, onPick }: ChatEmptyStateProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const { name, templateId } = useAgentIdentity(agentId)
  const transition = (i: number): Transition =>
    reduced ? { duration: 0.15 } : { ...CHAT_SPRING, delay: 0.04 * i }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <motion.div
        className="flex flex-col items-center gap-3"
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        transition={transition(0)}
      >
        <div className="flex size-12 items-center justify-center rounded-2xl bg-secondary/60">
          <AgentGlyph templateId={templateId} size={24} className="text-foreground" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {name ? `Chat with ${name}` : 'Start a conversation'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Ask anything, or try one of these:</p>
        </div>
      </motion.div>

      {onPick && (
        <div className="grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((s, i) => (
            <motion.button
              key={s.label}
              type="button"
              onClick={() => onPick(s.prompt)}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
              transition={transition(i + 1)}
              whileTap={reduced ? undefined : { scale: 0.97 }}
              className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-secondary/30 px-3.5 py-2.5 text-left text-sm text-foreground transition-colors hover:border-border hover:bg-secondary/60"
            >
              <s.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{s.label}</span>
            </motion.button>
          ))}
        </div>
      )}

      <p className="text-2xs text-muted-foreground">
        Type{' '}
        <kbd className="rounded border border-border bg-muted/60 px-1 py-0.5 font-mono text-3xs">
          /
        </kbd>{' '}
        for commands & skills
      </p>
    </div>
  )
}
