//! The `read_chat` tool: forwards the chat id and page to the parent and
//! returns the chat text it renders.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{tool, tool_router};

use super::TermulPlanServer;
use crate::acp::host_mcp::read_chat::{ReadChatInput, DESCRIPTION};
use crate::acp::host_mcp::{FrameKind, FrameRequest};

/// The parent replays the chat's whole log from disk.
const ROUND_TRIP: std::time::Duration = std::time::Duration::from_secs(30);

#[tool_router(router = read_chat_tool_router, vis = "pub(super)")]
impl TermulPlanServer {
    #[tool(
        name = "read_chat",
        description = DESCRIPTION,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn read_chat(&self, Parameters(input): Parameters<ReadChatInput>) -> CallToolResult {
        let request = FrameRequest {
            read_chat: Some(input),
            ..self.frame(FrameKind::ReadChat)
        };
        self.text_call("read_chat", request, ROUND_TRIP).await
    }
}
