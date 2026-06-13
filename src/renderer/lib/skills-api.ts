/**
 * Agent Skills IPC facade — lists and reads Zed-compatible SKILL.md packages.
 */
import { invoke } from '@tauri-apps/api/core'

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
    return invoke<AgentSkillSummary[]>('list_agent_skills_cmd', {
      projectRoot: projectRoot || null
    })
  },

  readSkill(name: string, projectRoot?: string): Promise<AgentSkillContent> {
    return invoke<AgentSkillContent>('read_agent_skill_cmd', {
      name,
      projectRoot: projectRoot || null
    })
  }
}
