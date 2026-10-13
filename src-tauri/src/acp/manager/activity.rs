//! Activity probe: the host-side evidence the idle reaper reads for one agent.
//!
//! The evidence lives on the agent's driver thread (`DriverState` and the ACP
//! terminal registry), so it is read through an [`AcpCommand::ActivityProbe`]
//! answered there — never from connection, subscription or presence state.

use super::*;
use crate::acp::AgentActivity;

impl AcpManager {
    /// Probe one agent's activity evidence. Errors when the agent is unknown or
    /// its driver is gone.
    pub async fn agent_activity(&self, agent_id: &AgentId) -> Result<AgentActivity, String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::ActivityProbe { reply }).await
    }

    /// Probe every live agent: `(agent id, activity)` with the `last_active_at`
    /// stamp. An agent whose driver vanished between listing and probing is
    /// skipped (it is already gone).
    pub async fn list_agent_activity(&self) -> Vec<(AgentId, AgentActivity)> {
        let mut out = Vec::new();
        for agent_id in self.list_agents() {
            match self.agent_activity(&agent_id).await {
                Ok(activity) => out.push((agent_id, activity)),
                Err(error) => {
                    log::debug!("[acp] activity probe skipped agent {agent_id}: {error}");
                }
            }
        }
        out
    }
}
