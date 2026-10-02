use super::*;

/// The `_session/question` ACP extension request (issue #411).
///
/// Agents send a structured question over the protocol's extension surface
/// (the vendored protocol routes `_`-prefixed methods to
/// [`ExtMethodRequest`](agent_client_protocol::schema::v1::ExtRequest)); the
/// response is an untyped JSON value. This type implements the protocol's
/// `JsonRpcMessage`/`JsonRpcRequest` traits directly for the single method, so
/// the driver handler chain matches ONLY `_session/question` — unlike
/// registering on the whole `AgentRequest` enum, which would also claim
/// client→agent responses and break response routing.
///
/// Wire params (camelCase): `{ sessionId, questionId?, question, options }`
/// where `options` is `[{ value, label, description?, cardinality? }]` and
/// `cardinality` is `single` (default) or `multi`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AskUserQuestionRequest {
    pub(super) session_id: String,
    pub(super) question: String,
    #[serde(default)]
    pub(super) options: Vec<AskQuestionOption>,
    #[serde(default)]
    pub(super) question_id: Option<String>,
}

/// One option of an [`AskUserQuestionRequest`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AskQuestionOption {
    pub(super) value: String,
    pub(super) label: String,
    #[serde(default)]
    pub(super) description: Option<String>,
    #[serde(default)]
    pub(super) cardinality: Option<String>,
}

impl agent_client_protocol::JsonRpcMessage for AskUserQuestionRequest {
    fn matches_method(method: &str) -> bool {
        method == "_session/question"
    }

    fn method(&self) -> &str {
        "_session/question"
    }

    fn to_untyped_message(
        &self,
    ) -> Result<agent_client_protocol::UntypedMessage, agent_client_protocol::Error> {
        agent_client_protocol::UntypedMessage::new("_session/question", self)
    }

    fn parse_message(
        method: &str,
        params: &impl serde::Serialize,
    ) -> Result<Self, agent_client_protocol::Error> {
        if method != "_session/question" {
            return Err(agent_client_protocol::Error::method_not_found());
        }
        agent_client_protocol::util::json_cast_params(params)
    }
}

impl agent_client_protocol::JsonRpcRequest for AskUserQuestionRequest {
    type Response = Value;
}
