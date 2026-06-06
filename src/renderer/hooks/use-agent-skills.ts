import { useCallback, useEffect, useState } from 'react'
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
      } catch {
        if (!cancelled) setSkills([])
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

export async function buildPromptWithLoadedSkill(
  loadedSkill: LoadedAgentSkill | null,
  userText: string,
  projectRoot: string | undefined
): Promise<string> {
  const trimmed = userText.trim()
  if (!loadedSkill) return trimmed

  try {
    const skill = await skillsApi.readSkill(loadedSkill.name, projectRoot)
    const { formatPromptWithSkill } = await import('@/lib/skills-prompt')
    return formatPromptWithSkill(skill.body, trimmed)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to load skill '${loadedSkill.name}': ${detail}`)
  }
}
