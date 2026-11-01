use std::collections::BTreeSet;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::cli::{parse_format, render, Format};
use super::document::{operation_id, path_params};
use super::{document, ROUTES};
use crate::acp::AcpManager;
use crate::web::auth::{WebAuth, WebAuthToken};
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::ws::HistoryMode;

fn collect_refs<'a>(value: &'a Value, refs: &mut Vec<&'a str>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(target)) = map.get("$ref") {
                refs.push(target);
            }
            map.values().for_each(|child| collect_refs(child, refs));
        }
        Value::Array(items) => items.iter().for_each(|item| collect_refs(item, refs)),
        _ => {}
    }
}

#[test]
fn the_document_is_openapi_3_1_at_the_crate_version() {
    let doc = document();
    assert_eq!(doc["openapi"], "3.1.0");
    assert_eq!(doc["info"]["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn every_ref_resolves_inside_the_document() {
    let doc = document();
    let mut refs = Vec::new();
    collect_refs(&doc, &mut refs);
    assert!(refs.len() > 100, "expected the spec to share schemas, found {} refs", refs.len());
    let dangling: BTreeSet<&str> = refs
        .into_iter()
        .filter(|target| {
            let pointer = target.strip_prefix('#').unwrap_or(target);
            !target.starts_with("#/") || doc.pointer(pointer).is_none()
        })
        .collect();
    assert!(dangling.is_empty(), "unresolved $ref targets: {dangling:?}");
}

#[test]
fn every_route_row_is_one_operation_with_its_path_parameters() {
    let doc = document();
    let paths = doc["paths"].as_object().expect("paths object");
    let operations: usize = paths.values().map(|item| item.as_object().map_or(0, |ops| ops.len())).sum();
    assert_eq!(operations, ROUTES.len(), "one operation per ROUTES row");

    let mut operation_ids = BTreeSet::new();
    for route in ROUTES {
        let operation = &doc["paths"][route.openapi_path()][route.method.as_str()];
        assert!(operation.is_object(), "no operation for {} {}", route.method.as_str(), route.path);
        assert!(
            operation_ids.insert(operation_id(route)),
            "duplicate operationId {}",
            operation_id(route)
        );
        let declared: BTreeSet<&str> = operation["parameters"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|param| param["in"] == "path")
            .filter_map(|param| param["name"].as_str())
            .collect();
        let in_path: BTreeSet<&str> =
            path_params(route.path).into_iter().map(|(name, _)| name).collect();
        assert_eq!(declared, in_path, "path parameters of {}", route.path);
    }
}

#[test]
fn operations_carry_bearer_auth_exactly_where_the_gate_applies() {
    let doc = document();
    let bearer = json!([{ "bearerAuth": [] }]);
    assert_eq!(doc["paths"]["/projects"]["get"]["security"], bearer);
    assert_eq!(doc["paths"]["/openapi.json"]["get"]["security"], bearer);
    assert_eq!(doc["paths"]["/health"]["get"]["security"], json!([]));
    assert_eq!(doc["paths"]["/ws"]["get"]["security"], json!([]));
    assert_eq!(doc["paths"]["/canvas/{id}/{rest}"]["get"]["security"], json!([]));
    assert_eq!(
        doc["paths"]["/projects"]["get"]["responses"]["401"]["$ref"],
        "#/components/responses/Unauthorized"
    );
}

#[test]
fn json_replies_are_wrapped_in_the_envelope_with_typed_data() {
    let doc = document();
    let schema = &doc["paths"]["/git/status"]["post"]["responses"]["200"]["content"]
        ["application/json"]["schema"];
    assert_eq!(schema["allOf"][0]["$ref"], "#/components/schemas/IpcEnvelope");
    assert_eq!(
        schema["allOf"][1]["properties"]["data"],
        json!({ "type": "array", "items": { "$ref": "#/components/schemas/GitStatusDetail" } })
    );
    let status = &doc["components"]["schemas"]["GitStatusDetail"]["properties"];
    assert!(status.get("path").is_some(), "camelCase wire fields: {status}");
}

#[test]
fn the_yaml_output_parses_back_to_the_document() {
    let parsed: Value = serde_norway::from_str(&render(Format::Yaml)).expect("valid YAML");
    assert_eq!(parsed, document());
    let parsed: Value = serde_json::from_str(&render(Format::Json)).expect("valid JSON");
    assert_eq!(parsed, document());
}

#[test]
fn the_cli_defaults_to_yaml_and_rejects_unknown_formats() {
    let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    assert_eq!(parse_format(&[]), Ok(Format::Yaml));
    assert_eq!(parse_format(&args(&["--format", "json"])), Ok(Format::Json));
    assert_eq!(parse_format(&args(&["--format=yaml"])), Ok(Format::Yaml));
    assert_eq!(
        parse_format(&args(&["--format", "xml"])),
        Err("unknown format `xml` (expected yaml or json)".to_string())
    );
    assert_eq!(parse_format(&args(&["--format"])), Err("--format needs a value".to_string()));
}

/// The production [`crate::web::router::router`] with the token gate on.
fn gated_production_router() -> axum::Router {
    let pty = crate::web::test_pty_manager();
    crate::web::router::router(
        Arc::new(AcpManager::new(vec![])),
        pty.clone(),
        pty.terminal_events(),
        pty.cwd_tracker(),
        pty.git_tracker(),
        pty.exit_code_tracker(),
        Arc::new(WsRelaySink::new()),
        Arc::new(ProjectRegistry::new()),
        HistoryMode::LiveOnly,
        None,
        None,
        None,
        false,
        false,
        "http://127.0.0.1".to_string(),
        Some(Arc::new(WebAuth::new(WebAuthToken::new("t0ken").expect("non-empty")))),
        crate::web::origin::OriginPolicy::default(),
        crate::web::host_allow::HostAllowList::loopback(),
        crate::web::connection_runtime::ConnectionRuntime::default(),
        None,
    )
}

fn openapi_request(token: Option<&str>) -> Request<Body> {
    let mut request = Request::builder().uri("/openapi.json").header("host", "127.0.0.1");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    request.body(Body::empty()).expect("build request")
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("JSON body")
}

#[tokio::test]
async fn openapi_json_needs_the_bearer_token_when_the_gate_is_on() {
    let response = gated_production_router()
        .oneshot(openapi_request(None))
        .await
        .expect("router response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(json_body(response).await["code"], "UNAUTHORIZED");
}

#[tokio::test]
async fn openapi_json_serves_the_document_with_the_token() {
    let response = gated_production_router()
        .oneshot(openapi_request(Some("t0ken")))
        .await
        .expect("router response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/json");
    let body = json_body(response).await;
    assert_eq!(body["openapi"], "3.1.0");
    assert_eq!(body["info"]["version"], env!("CARGO_PKG_VERSION"));
    assert!(body["paths"]["/openapi.json"]["get"].is_object());
}

#[test]
fn fs_raw_documents_exactly_the_media_types_it_serves() {
    let served: BTreeSet<&str> =
        crate::media_bytes::MEDIA_TYPES.iter().map(|(_, _, mime)| *mime).collect();
    let documented: BTreeSet<&str> = super::routes::MEDIA.iter().copied().collect();
    assert_eq!(documented, served);
}

#[test]
fn hand_parsed_request_fields_document_the_shape_the_server_parses() {
    use crate::web::fs_api::Expected;
    let doc = document();
    let schemas = &doc["components"]["schemas"];

    assert_eq!(schemas["Expected"]["oneOf"][0]["const"], "absent");
    assert_eq!(schemas["Expected"]["oneOf"][1]["required"], json!(["sha256"]));
    let hash = "a".repeat(64);
    assert!(serde_json::from_value::<Expected>(json!("absent")).is_ok());
    assert!(serde_json::from_value::<Expected>(json!({ "sha256": hash })).is_ok());
    assert!(serde_json::from_value::<Expected>(json!("Absent")).is_err());

    assert_eq!(
        schemas["ApplyAppBody"]["properties"]["op"],
        json!({ "$ref": "#/components/schemas/AppOpWire" })
    );
    assert_eq!(
        schemas["ApplyProjectBody"]["properties"]["op"],
        json!({ "$ref": "#/components/schemas/ProjectOpWire" })
    );
}

/// Every `description` in the document, with its JSON pointer, and the
/// `properties` names of the object it describes.
fn descriptions<'a>(value: &'a Value, pointer: String, out: &mut Vec<(String, &'a str, BTreeSet<&'a str>)>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(description)) = map.get("description") {
                let properties = map
                    .get("properties")
                    .and_then(Value::as_object)
                    .map(|properties| properties.keys().map(String::as_str).collect())
                    .unwrap_or_default();
                out.push((pointer.clone(), description, properties));
            }
            for (key, child) in map {
                descriptions(child, format!("{pointer}/{key}"), out);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                descriptions(item, format!("{pointer}/{index}"), out);
            }
        }
        _ => {}
    }
}

fn camel_case(snake: &str) -> String {
    let mut parts = snake.split('_');
    let mut camel = parts.next().unwrap_or_default().to_string();
    for part in parts {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            camel.extend(first.to_uppercase());
            camel.push_str(chars.as_str());
        }
    }
    camel
}

#[test]
fn descriptions_are_written_for_api_readers_not_rust_readers() {
    let internal = [
        (regex::Regex::new(r"\[`").unwrap(), "a rustdoc intra-doc link"),
        (regex::Regex::new(r"crate::").unwrap(), "a crate path"),
        (regex::Regex::new(r"\w\.rs\b").unwrap(), "a Rust source file"),
        (regex::Regex::new(r"\b(CAP|AD|ADR)[- ]\d|\bEpic \d").unwrap(), "a planning tag"),
    ];
    let code_span = regex::Regex::new(r"`([a-z0-9]+(?:_[a-z0-9]+)+)`").unwrap();
    let doc = document();
    let mut found = Vec::new();
    descriptions(&doc, String::new(), &mut found);
    let leaks: Vec<String> = found
        .iter()
        .flat_map(|(pointer, description, properties)| {
            let references = internal
                .iter()
                .filter(|(pattern, _)| pattern.is_match(description))
                .map(|(_, what)| what.to_string());
            let rust_fields = code_span
                .captures_iter(description)
                .map(|capture| capture[1].to_string())
                .filter(|snake| properties.contains(camel_case(snake).as_str()))
                .map(|snake| format!("the Rust field name `{snake}` (wire name `{}`)", camel_case(&snake)));
            references
                .chain(rust_fields)
                .map(move |what| format!("{pointer}: {what}"))
                .collect::<Vec<_>>()
        })
        .collect();
    assert!(
        leaks.is_empty(),
        "Descriptions that reach the public spec name internals. Reword the doc comment or \
         override it with #[schemars(description = \"..\")]:\n  {}",
        leaks.join("\n  ")
    );
}

#[test]
fn no_schema_name_is_a_collision_numbered_copy_of_another() {
    let doc = document();
    let schemas = doc["components"]["schemas"].as_object().expect("schemas object");
    let numbered: Vec<&String> = schemas
        .keys()
        .filter(|name| {
            let base = name.trim_end_matches(|c: char| c.is_ascii_digit());
            base.len() < name.len() && schemas.contains_key(base)
        })
        .collect();
    assert!(
        numbered.is_empty(),
        "schemars numbered these schemas because two types share a name (often one generic \
         at several type arguments). Name them with #[schemars(rename = \"..{{T}}..\")]: {numbered:?}"
    );
}

#[test]
fn the_factory_key_routes_document_their_bare_refusals() {
    let doc = document();
    let statuses = |method: &str| -> Vec<String> {
        let mut statuses: Vec<String> = doc["paths"]["/acp/factory-key"][method]["responses"]
            .as_object()
            .expect("responses object")
            .keys()
            .cloned()
            .collect();
        statuses.sort();
        statuses
    };
    assert_eq!(statuses("get"), ["200", "401", "403"]);
    assert_eq!(statuses("post"), ["200", "400", "401", "403"]);
    assert_eq!(
        doc["paths"]["/acp/factory-key"]["post"]["responses"]["400"]["content"]["application/json"]["schema"]
            ["required"],
        json!(["error"])
    );
}
