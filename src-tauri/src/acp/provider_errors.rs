//! Stable codes for upstream provider failures.
//!
//! An agent that talks to a model provider reports the provider's refusal as a
//! JSON-RPC error: a quota or usage limit, a session limit, a rejected
//! request. The agent has no shared vocabulary for these, so this module reads
//! the code, the structured `data` and the wording and settles on one of three
//! stable kinds. Anything it does not recognize stays a generic error.
//!
//! The manager carries the verdict across its `Err(String)` boundary as a
//! prefix (the [`ACP_AUTH_REQUIRED_PREFIX`](crate::acp::manager::ACP_AUTH_REQUIRED_PREFIX)
//! convention); the WS layer maps it to a `WsErrorCode` and the `agent_error`
//! event carries it as `providerCode`.

use serde_json::Value;

use crate::acp::events::AcpErrorDetail;

/// Prefix of a provider quota / usage-limit refusal.
pub const ACP_PROVIDER_QUOTA_EXCEEDED: &str = "ACP_PROVIDER_QUOTA_EXCEEDED";
/// Prefix of a provider session-limit refusal.
pub const ACP_PROVIDER_SESSION_LIMIT: &str = "ACP_PROVIDER_SESSION_LIMIT";
/// Prefix of a provider 4xx request rejection.
pub const ACP_PROVIDER_REQUEST_REJECTED: &str = "ACP_PROVIDER_REQUEST_REJECTED";

/// Which provider failure an error carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderErrorKind {
    /// Quota, usage, credit or rate limit.
    QuotaExceeded,
    /// The provider's session limit.
    SessionLimit,
    /// Another 4xx rejection of the request.
    RequestRejected,
}

impl ProviderErrorKind {
    /// Every kind, for tables and tests.
    pub const ALL: [Self; 3] = [
        Self::QuotaExceeded,
        Self::SessionLimit,
        Self::RequestRejected,
    ];

    /// The stable snake_case wire code (`WsErrorCode` / `providerCode`).
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::QuotaExceeded => "provider_quota_exceeded",
            Self::SessionLimit => "provider_session_limit",
            Self::RequestRejected => "provider_request_rejected",
        }
    }

    /// The manager-boundary prefix for this kind.
    #[must_use]
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::QuotaExceeded => ACP_PROVIDER_QUOTA_EXCEEDED,
            Self::SessionLimit => ACP_PROVIDER_SESSION_LIMIT,
            Self::RequestRejected => ACP_PROVIDER_REQUEST_REJECTED,
        }
    }
}

/// `data.errorKind` values the Claude ACP adapter attaches to provider errors.
const QUOTA_ERROR_KINDS: [&str; 2] = ["rate_limit", "billing_error"];
const REJECTED_ERROR_KINDS: [&str; 1] = ["invalid_request"];

/// Wording that names a quota, usage, credit or rate limit.
const QUOTA_WORDING: [&str; 8] = [
    "usage limit",
    "quota",
    "rate limit",
    "rate-limit",
    "too many requests",
    "insufficient credit",
    "credit balance",
    "insufficient balance",
];

/// HTTP statuses that are authentication or transient failures, never a
/// provider refusal of this request.
fn is_excluded_status(status: u16) -> bool {
    matches!(status, 401 | 403 | 408)
}

/// An HTTP status the structured `data` names: `status`, `statusCode`,
/// `status_code`, `httpStatus` or `http_status`, at the top level or inside an
/// `error` object. Numbers and numeric strings both count.
fn data_status(data: &Value) -> Option<u16> {
    const KEYS: [&str; 5] = [
        "status",
        "statusCode",
        "status_code",
        "httpStatus",
        "http_status",
    ];
    let read = |object: &Value| {
        KEYS.iter().find_map(|key| match object.get(*key)? {
            Value::Number(number) => number.as_u64().and_then(|n| u16::try_from(n).ok()),
            Value::String(text) => text.trim().parse().ok(),
            _ => None,
        })
    };
    read(data).or_else(|| data.get("error").and_then(read))
}

/// A 4xx status the message names right after `status`, `http` or
/// `api error` (`"API Error: 429 ..."`, `"status code 400"`), and whether the
/// match came from the `api error` form. Wording such as "status was fine,
/// 404 rows" does not match: only separators may sit between the needle and
/// the three digits.
fn message_status(lower: &str) -> Option<(u16, bool)> {
    const NEEDLES: [&str; 6] = [
        "api error",
        "status code",
        "http status",
        "http error",
        "status",
        "http",
    ];
    for needle in NEEDLES {
        let mut from = 0;
        while let Some(found) = lower[from..].find(needle) {
            let after = from + found + needle.len();
            let rest = lower[after..].trim_start_matches([' ', ':', '=']);
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            let boundary = rest[digits.len()..]
                .chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphanumeric());
            if digits.len() == 3 && boundary {
                if let Some(status) = digits.parse::<u16>().ok().filter(is_client_error) {
                    return Some((status, needle == "api error"));
                }
            }
            from = after;
        }
    }
    None
}

fn is_client_error(status: &u16) -> bool {
    (400..500).contains(status)
}

fn error_kind_of(data: &Value) -> Option<&str> {
    data.get("errorKind").and_then(Value::as_str)
}

/// Classify an agent error as a provider failure, or `None` when it is not
/// recognizably one.
///
/// Only a JSON-RPC error (one that carries a code) can be a provider failure:
/// timeouts, closed transports and flush failures never are, and an
/// `AuthRequired` error stays an authentication failure.
#[must_use]
pub fn classify_provider_error(detail: &AcpErrorDetail) -> Option<ProviderErrorKind> {
    if detail.timed_out || detail.connection_closed {
        return None;
    }
    let code = detail.code?;
    if code == i32::from(agent_client_protocol::ErrorCode::AuthRequired) {
        return None;
    }
    let lower = detail.message.to_ascii_lowercase();
    let data = detail.data.as_ref();
    let kind = data.and_then(error_kind_of);
    let from_data = data.and_then(data_status).filter(is_client_error);
    let from_message = message_status(&lower);
    let status = from_data.or(from_message.map(|(status, _)| status));

    if status.is_some_and(is_excluded_status) || kind == Some("authentication_failed") {
        return None;
    }
    // A session limit is more specific than the quota signals that usually
    // accompany it (`errorKind: rate_limit`, HTTP 429).
    if lower.contains("session limit") {
        return Some(ProviderErrorKind::SessionLimit);
    }
    if kind.is_some_and(|kind| QUOTA_ERROR_KINDS.contains(&kind))
        || matches!(status, Some(402 | 429))
        || (!lower.contains("disk quota") && QUOTA_WORDING.iter().any(|w| lower.contains(w)))
    {
        return Some(ProviderErrorKind::QuotaExceeded);
    }
    // A bare status in free text (`status 404`) only names a quota; as a
    // rejection it must come from the structured data or the `API Error: NNN`
    // form agents use for provider responses.
    if kind.is_some_and(|kind| REJECTED_ERROR_KINDS.contains(&kind))
        || from_data.is_some()
        || from_message.is_some_and(|(_, api_error)| api_error)
    {
        return Some(ProviderErrorKind::RequestRejected);
    }
    None
}

/// The error string the manager returns for `detail`: prefixed with the
/// provider tag when it classifies as a provider failure, the bare message
/// otherwise.
#[must_use]
pub fn tag_provider_error(detail: &AcpErrorDetail) -> String {
    match classify_provider_error(detail) {
        Some(kind) => format!("{}: {}", kind.prefix(), detail.message),
        None => detail.message.clone(),
    }
}

/// Split a tagged error string into its kind and the human message. `None`
/// for any untagged string.
#[must_use]
pub fn split_provider_tag(error: &str) -> Option<(ProviderErrorKind, &str)> {
    ProviderErrorKind::ALL.into_iter().find_map(|kind| {
        error
            .strip_prefix(kind.prefix())
            .and_then(|rest| rest.strip_prefix(": "))
            .map(|message| (kind, message))
    })
}

#[cfg(test)]
mod tests;
