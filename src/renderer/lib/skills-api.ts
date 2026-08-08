/**
 * Agent Skills IPC facade — lists and reads Zed-compatible SKILL.md packages.
 *
 * Skill discovery reads the user's local filesystem (`~/.agents/skills/` +
 * `{project}/.agents/skills/`). On desktop the Tauri commands
 * `list_agent_skills_cmd` / `read_agent_skill_cmd` back this facade; on the
 * web/remote client the same calls hit the shipped parity routes `GET /skills`
 * + `GET /skills/:name` (see `webServerSkills`), so the slash menu is usable
 * on both surfaces. `projectRoot` is optional — when omitted, only global
 * skills are listed; on web the route degrades to an empty list on scan
 * failure (never throws, so the slash menu stays usable).
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauriContext } from './tauri-runtime'
import { webServerSkills } from './web-server-api'

export interface AgentSkillSummary {
  name: string
  description: string
  /** `'global'` or `'project'`. */
  scope: string
  /** Absolute path to the skill's `SKILL.md` so the wire prompt can cite it
   * (the agent reads the body from disk; no body is shipped over the wire). */
  path: string
}

export interface AgentSkillContent {
  name: string
  description: string
  scope: string
  body: string
  /** Absolute path to the skill's `SKILL.md`. */
  path: string
}

export const skillsApi = {
  listSkills(projectRoot?: string): Promise<AgentSkillSummary[]> {
    if (!isTauriContext()) return webServerSkills.list(projectRoot)
    return invoke<AgentSkillSummary[]>('list_agent_skills_cmd', {
      projectRoot: projectRoot || null
    })
  },

  readSkill(name: string, projectRoot?: string): Promise<AgentSkillContent> {
    if (!isTauriContext()) return webServerSkills.read(name, projectRoot)
    return invoke<AgentSkillContent>('read_agent_skill_cmd', {
      name,
      projectRoot: projectRoot || null
    })
  }
}
