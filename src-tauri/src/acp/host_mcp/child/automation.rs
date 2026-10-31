//! The `automation_*` tools: each forwards its arguments to the parent as an
//! `Automation` frame and returns the parent's JSON or text verbatim.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router};
use serde_json::Value;

use super::{exchange_frame, TermulPlanServer};
use crate::acp::host_mcp::automation_tools::{
    AutomationApplyOpsInput, AutomationCreateInput, AutomationRefInput, AutomationTool,
    APPLY_OPS_DESCRIPTION, CAPABILITIES_DESCRIPTION, CREATE_DESCRIPTION, GET_DESCRIPTION,
    GUIDE_DESCRIPTION, LIST_DESCRIPTION, PROPOSE_DESCRIPTION,
};
use crate::acp::host_mcp::{FrameKind, FrameReply, FrameRequest};

/// Service calls are local SQLite reads and writes.
const ROUND_TRIP: std::time::Duration = std::time::Duration::from_secs(10);

impl TermulPlanServer {
    async fn automation(&self, tool: AutomationTool, input: Option<Value>) -> CallToolResult {
        let request = FrameRequest {
            automation_tool: Some(tool),
            automation_input: input,
            ..self.frame(FrameKind::Automation)
        };
        let reply = tokio::time::timeout(ROUND_TRIP, exchange_frame(&self.config, request)).await;
        match reply {
            Ok(Ok(reply)) => tool_result(reply),
            Ok(Err(error)) => {
                eprintln!("[host-mcp-child] {}: {error}", tool.name());
                CallToolResult::error(vec![ContentBlock::text(format!(
                    "the Termul host is unreachable: {error}"
                ))])
            }
            Err(_) => CallToolResult::error(vec![ContentBlock::text(
                "the Termul host did not answer in time",
            )]),
        }
    }
}

/// The parent's `result` as the tool's text: a string as is, anything else
/// as compact JSON. A refused call is a tool error the agent reads.
fn tool_result(reply: FrameReply) -> CallToolResult {
    let text = match reply.result {
        Some(Value::String(text)) => text,
        Some(value) => value.to_string(),
        None => reply.error.unwrap_or_else(|| "no reply".to_string()),
    };
    if reply.ok {
        CallToolResult::success(vec![ContentBlock::text(text)])
    } else {
        CallToolResult::error(vec![ContentBlock::text(text)])
    }
}

fn arguments<T: serde::Serialize>(input: T) -> Option<Value> {
    serde_json::to_value(input).ok()
}

#[tool_router(router = automation_tool_router, vis = "pub(super)")]
impl TermulPlanServer {
    #[tool(
        name = "automation_guide",
        description = GUIDE_DESCRIPTION,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn automation_guide(&self) -> CallToolResult {
        self.automation(AutomationTool::Guide, None).await
    }

    #[tool(
        name = "automation_capabilities",
        description = CAPABILITIES_DESCRIPTION,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn automation_capabilities(&self) -> CallToolResult {
        self.automation(AutomationTool::Capabilities, None).await
    }

    #[tool(
        name = "automation_list",
        description = LIST_DESCRIPTION,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn automation_list(&self) -> CallToolResult {
        self.automation(AutomationTool::List, None).await
    }

    #[tool(
        name = "automation_get",
        description = GET_DESCRIPTION,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn automation_get(
        &self,
        Parameters(input): Parameters<AutomationRefInput>,
    ) -> CallToolResult {
        self.automation(AutomationTool::Get, arguments(input)).await
    }

    #[tool(
        name = "automation_create",
        description = CREATE_DESCRIPTION,
        annotations(destructive_hint = false, open_world_hint = false)
    )]
    async fn automation_create(
        &self,
        Parameters(input): Parameters<AutomationCreateInput>,
    ) -> CallToolResult {
        self.automation(AutomationTool::Create, arguments(input))
            .await
    }

    #[tool(
        name = "automation_apply_ops",
        description = APPLY_OPS_DESCRIPTION,
        annotations(destructive_hint = true, open_world_hint = false)
    )]
    async fn automation_apply_ops(
        &self,
        Parameters(input): Parameters<AutomationApplyOpsInput>,
    ) -> CallToolResult {
        self.automation(AutomationTool::ApplyOps, arguments(input))
            .await
    }

    #[tool(
        name = "automation_propose",
        description = PROPOSE_DESCRIPTION,
        annotations(destructive_hint = false, open_world_hint = false)
    )]
    async fn automation_propose(
        &self,
        Parameters(input): Parameters<AutomationRefInput>,
    ) -> CallToolResult {
        self.automation(AutomationTool::Propose, arguments(input))
            .await
    }
}
