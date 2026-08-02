/**
 * Agent Skills IPC facade — lists and reads Zed-compatible SKILL.md packages.
 *
 * Desktop-only by design: skill discovery reads the user's local filesystem
 * (`~/.agents/skills/` + `{project}/.agents/skills/`). The web/remote client
 * has no parity route yet; on web we return an empty list (no skills surface)
 * rather than throwing, so the slash menu degrades cleanly. Web parity is
 * tracked as a follow-up.
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauriContext } from './tauri-runtime'

export interface AgentSkillSummary {
  name: string
  description: string
  /** `'global'` or `'project'`. */
  scope: string
}

export interface AgentSkillContent {
  name: string
  description: string
  scope: string
  body: string
}

export const skillsApi = {
  listSkills(projectRoot?: string): Promise<AgentSkillSummary[]> {
    // Web/remote: no local skill filesystem to scan.
    if (!isTauriContext()) return Promise.resolve([])
    return invoke<AgentSkillSummary[]>('list_agent_skills_cmd', {
      projectRoot: projectRoot || null
    })
  },

  readSkill(name: string, projectRoot?: string): Promise<AgentSkillContent> {
    if (!isTauriContext()) {
      return Promise.reject(new Error('Agent skills are unavailable on web'))
    }
    return invoke<AgentSkillContent>('read_agent_skill_cmd', {
      name,
      projectRoot: projectRoot || null
    })
  }
}
