import { useCallback, useEffect, useState } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { type AgentSkillSummary, skillsApi } from '@/lib/skills-api'
import { type FramedSkill, formatPromptWithSkills } from '@/lib/skills-prompt'

export function useAgentSkills(projectRoot: string | undefined): {
  skills: AgentSkillSummary[]
  loading: boolean
  reload: () => void
} {
  const [skills, setSkills] = useState<AgentSkillSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => {
    setReloadToken((t) => t + 1)
  }, [])

  useEffect(() => {
    void reloadToken
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const listed = await skillsApi.listSkills(projectRoot)
        if (!cancelled) setSkills(listed)
      } catch (err) {
        if (!cancelled) setSkills([])
        // Never swallow silently: surface list failures to the backend log so
        // a closed DevTools doesn't hide why the Skills section is empty.
        void logFrontendError({
          level: 'warn',
          message: `Failed to list agent skills: ${err instanceof Error ? err.message : String(err)}`,
          source: 'useAgentSkills'
        })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectRoot, reloadToken])

  return { skills, loading, reload }
}

/**
 * Frame the selected skills (by path) and the user's text into the wire prompt.
 * Synchronous: paths are captured at pick time, so there is no IPC read at send
 * and it cannot fail. Tokens in the user text are replaced with `(<name>)`
 * inline and each unique skill is cited as `<name>: <path>` under a
 * `# Agent Skills` header (see `formatPromptWithSkills`).
 */
export function buildPromptWithLoadedSkills(skills: FramedSkill[], userText: string): string {
  return formatPromptWithSkills(skills, userText)
}
