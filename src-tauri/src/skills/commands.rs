//! Tauri IPC for Agent Skills discovery.

use super::{list_agent_skills, read_agent_skill, AgentSkillContent, AgentSkillSummary};

#[tauri::command]
pub fn list_agent_skills_cmd(
    project_root: Option<String>,
) -> Result<Vec<AgentSkillSummary>, String> {
    list_agent_skills(project_root.as_deref())
}

#[tauri::command]
pub fn read_agent_skill_cmd(
    name: String,
    project_root: Option<String>,
) -> Result<AgentSkillContent, String> {
    read_agent_skill(&name, project_root.as_deref())
}
