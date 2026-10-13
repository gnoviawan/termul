use serde_json::json;

use super::*;

fn rpc(code: i32, message: &str, data: Option<Value>) -> AcpErrorDetail {
    AcpErrorDetail {
        message: message.to_string(),
        code: Some(code),
        data,
        timed_out: false,
        connection_closed: false,
    }
}

/// Provider failures as agents report them, and the verdict each earns.
#[test]
fn classification_table() {
    use ProviderErrorKind::{QuotaExceeded, RequestRejected, SessionLimit};
    let cases: Vec<(&str, AcpErrorDetail, Option<ProviderErrorKind>)> = vec![
        (
            "claude session limit with rate_limit kind",
            rpc(
                -32603,
                "Internal error: You've hit your session limit · resets 8:20pm",
                Some(json!({ "errorKind": "rate_limit" })),
            ),
            Some(SessionLimit),
        ),
        (
            "claude billing error",
            rpc(
                -32603,
                "Internal error",
                Some(json!({ "errorKind": "billing_error" })),
            ),
            Some(QuotaExceeded),
        ),
        (
            "claude rate limit kind",
            rpc(
                -32603,
                "Internal error",
                Some(json!({ "errorKind": "rate_limit" })),
            ),
            Some(QuotaExceeded),
        ),
        (
            "claude invalid request kind",
            rpc(
                -32603,
                "Internal error",
                Some(json!({ "errorKind": "invalid_request" })),
            ),
            Some(RequestRejected),
        ),
        (
            "http 429 in data",
            rpc(-32603, "Internal error", Some(json!({ "status": 429 }))),
            Some(QuotaExceeded),
        ),
        (
            "http 402 as numeric string",
            rpc(
                -32603,
                "Internal error",
                Some(json!({ "statusCode": "402" })),
            ),
            Some(QuotaExceeded),
        ),
        (
            "http 400 nested under error",
            rpc(
                -32603,
                "Internal error",
                Some(json!({ "error": { "status": 400 } })),
            ),
            Some(RequestRejected),
        ),
        (
            "http 422 in data",
            rpc(
                -32603,
                "Internal error",
                Some(json!({ "http_status": 422 })),
            ),
            Some(RequestRejected),
        ),
        (
            "429 in message",
            rpc(
                -32603,
                "API Error: 429 {\"type\":\"rate_limit_error\"}",
                None,
            ),
            Some(QuotaExceeded),
        ),
        (
            "api error status in message",
            rpc(
                -32603,
                "API Error: 400 {\"type\":\"invalid_request_error\"}",
                None,
            ),
            Some(RequestRejected),
        ),
        (
            "bare status in message is not a rejection",
            rpc(-32603, "request failed with status code 400", None),
            None,
        ),
        (
            "usage limit wording",
            rpc(
                -32603,
                "You have reached your usage limit for this period",
                None,
            ),
            Some(QuotaExceeded),
        ),
        (
            "quota wording",
            rpc(
                -32603,
                "You exceeded your current quota, please check your plan",
                None,
            ),
            Some(QuotaExceeded),
        ),
        (
            "too many requests wording",
            rpc(-32603, "Too many requests", None),
            Some(QuotaExceeded),
        ),
        (
            "insufficient credit wording",
            rpc(-32603, "insufficient credit", None),
            Some(QuotaExceeded),
        ),
        (
            "session limit wording",
            rpc(-32603, "session limit reached", None),
            Some(SessionLimit),
        ),
        // Never a provider failure.
        (
            "auth required stays auth",
            rpc(-32000, "Authentication required", None),
            None,
        ),
        (
            "401 is authentication",
            rpc(-32603, "Internal error", Some(json!({ "status": 401 }))),
            None,
        ),
        (
            "403 is authentication",
            rpc(
                -32603,
                "Internal error",
                Some(json!({ "status": 403, "errorKind": "rate_limit" })),
            ),
            None,
        ),
        (
            "authentication_failed kind",
            rpc(
                -32603,
                "Internal error",
                Some(json!({ "errorKind": "authentication_failed" })),
            ),
            None,
        ),
        (
            "server error",
            rpc(-32603, "Internal error", Some(json!({ "status": 503 }))),
            None,
        ),
        (
            "request timeout",
            rpc(-32603, "status 408 request timeout", None),
            None,
        ),
        (
            "disk quota is not a provider quota",
            rpc(-32603, "Disk quota exceeded writing /tmp/x", None),
            None,
        ),
        (
            "bare internal error",
            rpc(-32603, "Internal error", None),
            None,
        ),
        (
            "unrelated digits",
            rpc(-32603, "status was fine but 404 rows changed", None),
            None,
        ),
        (
            "url is not a status",
            rpc(-32603, "failed to fetch http://localhost:8404/x", None),
            None,
        ),
        (
            "unknown data shape",
            rpc(
                -32603,
                "Internal error",
                Some(json!({ "status": { "nested": 429 } })),
            ),
            None,
        ),
        (
            "plain string without a code",
            AcpErrorDetail::from("rate limit exceeded".to_string()),
            None,
        ),
    ];
    for (name, detail, expected) in cases {
        assert_eq!(classify_provider_error(&detail), expected, "{name}");
    }
}

#[test]
fn timeout_and_closed_transport_are_never_provider_failures() {
    let mut detail = rpc(-32603, "rate limit", Some(json!({ "status": 429 })));
    detail.timed_out = true;
    assert_eq!(classify_provider_error(&detail), None);
    detail.timed_out = false;
    detail.connection_closed = true;
    assert_eq!(classify_provider_error(&detail), None);
}

#[test]
fn tag_round_trips_through_split() {
    for kind in ProviderErrorKind::ALL {
        let detail = match kind {
            ProviderErrorKind::QuotaExceeded => rpc(-32603, "x", Some(json!({ "status": 429 }))),
            ProviderErrorKind::SessionLimit => rpc(-32603, "session limit", None),
            ProviderErrorKind::RequestRejected => rpc(-32603, "x", Some(json!({ "status": 400 }))),
        };
        let tagged = tag_provider_error(&detail);
        assert!(tagged.starts_with(kind.prefix()));
        let (split_kind, message) = split_provider_tag(&tagged).expect("tagged");
        assert_eq!(split_kind, kind);
        assert_eq!(message, detail.message);
    }
}

#[test]
fn untagged_errors_pass_through_verbatim() {
    let detail = rpc(-32603, "Internal error", None);
    assert_eq!(tag_provider_error(&detail), "Internal error");
    assert_eq!(split_provider_tag("Internal error"), None);
    assert_eq!(
        split_provider_tag("ACP_PROVIDER_QUOTA_EXCEEDED no colon"),
        None
    );
}

#[test]
fn wire_codes_match_the_reserved_ws_codes() {
    use crate::web::ws::WsErrorCode;
    assert_eq!(
        ProviderErrorKind::QuotaExceeded.code(),
        WsErrorCode::ProviderQuotaExceeded.as_str()
    );
    assert_eq!(
        ProviderErrorKind::SessionLimit.code(),
        WsErrorCode::ProviderSessionLimit.as_str()
    );
    assert_eq!(
        ProviderErrorKind::RequestRejected.code(),
        WsErrorCode::ProviderRequestRejected.as_str()
    );
}
