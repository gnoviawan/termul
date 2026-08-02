import { useCallback, useEffect, useState } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { type AgentSkillSummary, skillsApi } from '@/lib/skills-api'

export interface LoadedAgentSkill {
  name: string
  description: string
}

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

export async function buildPromptWithLoadedSkills(
  loadedSkills: LoadedAgentSkill[],
  userText: string,
  projectRoot: string | undefined
): Promise<string> {
  const trimmed = userText.trim()
  if (loadedSkills.length === 0) return trimmed

  // Read each skill's body on demand at send time so it is always current
  // (freshness). On any read failure, throw an Error naming the failing skill
  // so the toast is clear about which skill could not be loaded.
  const framed: { name: string; body: string }[] = []
  for (const loaded of loadedSkills) {
    try {
      const skill = await skillsApi.readSkill(loaded.name, projectRoot)
      framed.push({ name: loaded.name, body: skill.body })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to load skill '${loaded.name}': ${detail}`)
    }
  }

  const { formatPromptWithSkills } = await import('@/lib/skills-prompt')
  return formatPromptWithSkills(framed, trimmed)
}
