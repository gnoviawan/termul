//! Legacy `models` fallback for ACP model discovery (issue #822).
//!
//! Some agents advertise their selectable models only through the pre-1.3
//! top-level `models` field (`{ currentModelId, availableModels[] }`) on the
//! `session/new`, `session/load` and `session/resume` results, instead of a
//! Model-category `select` config option. The pinned
//! `agent-client-protocol-schema` crate does not define that field (nor
//! `session/set_model`), so the typed responses silently drop it. This module
//! sends those requests as raw JSON-RPC, parses the typed response from the
//! raw `Value` exactly as the SDK would, and additionally extracts the legacy
//! list so one shared implementation feeds the Tauri IPC events/outcomes and
//! the WS relay.
//!
//! Precedence (see [`resolve_models`]): a Model-category `select` config option
//! is authoritative whenever it is advertised — even with an empty option list.
//! Only when none is advertised is the legacy list used, and such a session is
//! read-only for `set_model` because the schema exposes no way to switch it.

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
};
use agent_client_protocol::{Agent, ConnectionTo, JsonRpcRequest, JsonRpcResponse};
use serde_json::Value;

use crate::acp::events::{models_from_config_options, SessionModel, SessionModelState};

/// A typed response plus the legacy `models` list read from the raw result.
#[derive(Debug, Clone)]
pub(crate) struct WithLegacyModels<T> {
    pub response: T,
    pub legacy: Option<SessionModelState>,
}

/// The model list a session ends up with, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedModels {
    pub models: Option<SessionModelState>,
    /// `true` when `models` came from the legacy field: the list is
    /// read-only because `set_model` has no protocol path for it.
    pub legacy_only: bool,
}

/// Leniently parse the legacy top-level `models` field of a
/// `session/new|load|resume` result.
///
/// Malformed or empty data yields `None` (never an error): entries without a
/// string `modelId` are skipped, a missing `name` falls back to the id, and a
/// missing/non-string `currentModelId` or an empty list yields `None`.
pub(crate) fn legacy_models_from_value(result: &Value) -> Option<SessionModelState> {
    let raw = result.get("models")?;
    if raw.is_null() {
        return None;
    }
    let Some(object) = raw.as_object() else {
        log::warn!("[acp] legacy `models` field ignored: expected an object");
        return None;
    };
    let Some(entries) = object.get("availableModels").and_then(Value::as_array) else {
        log::warn!("[acp] legacy `models` field ignored: `availableModels` is not an array");
        return None;
    };
    let mut seen_ids = std::collections::HashSet::new();
    let available_models: Vec<SessionModel> = entries
        .iter()
        .filter_map(|entry| {
            let model_id = entry.get("modelId")?.as_str()?;
            // Skip empty and duplicate ids (the picker keys rows by modelId).
            if model_id.is_empty() || !seen_ids.insert(model_id) {
                return None;
            }
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or(model_id);
            let description = entry
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(SessionModel {
                model_id: model_id.to_string(),
                name: name.to_string(),
                description,
            })
        })
        .collect();
    if available_models.is_empty() {
        if !entries.is_empty() {
            log::warn!(
                "[acp] legacy `models` field ignored: none of {} entries were valid",
                entries.len()
            );
        }
        return None;
    }
    let Some(current_model_id) = object.get("currentModelId").and_then(Value::as_str) else {
        log::warn!("[acp] legacy `models` field ignored: `currentModelId` missing or not a string");
        return None;
    };
    if available_models.len() < entries.len() {
        log::warn!(
            "[acp] legacy `models` field: skipped {} malformed entries",
            entries.len() - available_models.len()
        );
    }
    Some(SessionModelState {
        current_model_id: current_model_id.to_string(),
        available_models,
    })
}

/// Whether the agent advertises a Model-category `select` config option
/// (regardless of how many choices it lists).
fn advertises_model_config_option(opts: Option<&[SessionConfigOption]>) -> bool {
    // Same selection rule as `models_from_config_options`: the first
    // Model-category option, which must be a `select`.
    opts.and_then(|opts| {
        opts.iter()
            .find(|option| option.category == Some(SessionConfigOptionCategory::Model))
    })
    .is_some_and(|option| matches!(option.kind, SessionConfigKind::Select(_)))
}

/// Apply the model-source precedence: an advertised Model `select` config
/// option wins (even if empty); otherwise the legacy list; otherwise `None`.
pub(crate) fn resolve_models(
    config_options: Option<&[SessionConfigOption]>,
    legacy: Option<SessionModelState>,
) -> ResolvedModels {
    if advertises_model_config_option(config_options) {
        if legacy.is_some() {
            log::debug!("[acp] model config option advertised; ignoring legacy `models` field");
        }
        return ResolvedModels {
            models: models_from_config_options(config_options),
            legacy_only: false,
        };
    }
    if let Some(legacy) = legacy {
        log::debug!(
            "[acp] no model config option; using legacy `models` field ({} models, read-only)",
            legacy.available_models.len()
        );
        return ResolvedModels {
            models: Some(legacy),
            legacy_only: true,
        };
    }
    ResolvedModels {
        models: None,
        legacy_only: false,
    }
}

/// Send a typed `session/new|load|resume` request as raw JSON-RPC and return
/// the typed response (parsed from the raw `Value` exactly as the SDK would,
/// so agent/parse error behavior is unchanged) together with the legacy
/// `models` list the typed response type cannot carry.
pub(crate) async fn send_with_legacy_models<Req>(
    cx: &ConnectionTo<Agent>,
    request: Req,
) -> Result<WithLegacyModels<Req::Response>, agent_client_protocol::Error>
where
    Req: JsonRpcRequest,
{
    let method = request.method().to_string();
    let message = request.to_untyped_message()?;
    let value = cx.send_request(message).block_task().await?;
    let legacy = legacy_models_from_value(&value);
    let response = <Req::Response as JsonRpcResponse>::from_value(&method, value)?;
    Ok(WithLegacyModels { response, legacy })
}

/// Error returned by `set_model` for a session whose models came only from the
/// legacy field (the schema exposes no way to switch them).
pub(crate) const LEGACY_MODEL_SWITCH_UNSUPPORTED: &str =
    "model switching unsupported: this agent advertises its models only through the legacy \
     `models` field, which Termul can display but not change";

#[cfg(test)]
mod tests;
