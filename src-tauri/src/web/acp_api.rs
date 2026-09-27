//! ACP agent web routes (`/acp/*`) that are not catalog/install: the host-side
//! Factory key management endpoints. Mirrors the other `*_api.rs` modules —
//! `router.rs` only registers routes.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::web::ws::AppState;

/// `GET /acp/factory-key` response body.
#[derive(Serialize)]
pub(crate) struct FactoryKeyStatus {
    configured: bool,
}

/// `POST /acp/factory-key` request body.
#[derive(Deserialize)]
pub(crate) struct FactoryKeySave {
    config: crate::acp::AgentConfig,
    key: String,
}

/// Explicit auth-gate check shared by every handler in this module. The
/// standard API middleware only checks a bearer token when a gate exists;
/// these endpoints demand an ACTIVE gate even on loopback (they mint/replace
/// host credentials), so an ungated server refuses them outright with the
/// explicit refusal log.
async fn require_active_web_auth(state: &AppState, action: &str) -> Option<Response> {
    if state.web_auth.is_none() {
        tracing::warn!("[acp-factory-key] HTTP {action} refused: web auth disabled");
        return Some(
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error":"Web authentication required"})),
            )
                .into_response(),
        );
    }
    None
}

pub(crate) async fn factory_key_status(State(state): State<AppState>) -> Response {
    if let Some(refusal) = require_active_web_auth(&state, "status").await {
        return refusal;
    }
    Json(FactoryKeyStatus {
        configured: crate::acp::factory_key::configured(),
    })
    .into_response()
}

pub(crate) async fn factory_key_save(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if let Some(refusal) = require_active_web_auth(&state, "save").await {
        return refusal;
    }
    let request: FactoryKeySave = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":"Invalid Factory key request"})),
            )
                .into_response()
        }
    };
    match crate::acp::factory_key::validate_and_save(&state.acp, request.config, request.key).await
    {
        Ok(()) => Json(FactoryKeyStatus { configured: true }).into_response(),
        Err(error) => {
            tracing::warn!("[acp-factory-key] HTTP save failed");
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":error})),
            )
                .into_response()
        }
    }
}
