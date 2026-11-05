//! Assembles the OpenAPI document from [`ROUTES`].

use std::collections::{BTreeMap, BTreeSet};

use schemars::SchemaGenerator;
use serde_json::{json, Map, Value};

use super::{into_object, ref_to, settings, ApiRoute, Reply, Tag, ROUTES};

const ENVELOPE: &str = "IpcEnvelope";

/// Suffix for a request-side schema whose shape differs from the reply-side
/// schema of the same type (`#[serde(default)]` fields are optional on input
/// but always present on output).
const INPUT_SUFFIX: &str = "Input";

const API_DESCRIPTION: &str = "\
The HTTP API of a Termul host: the standalone `termul-server` or the desktop \
app's shared-live remote access.

**Envelope.** JSON routes answer `{ success, data?, error?, code? }`. A refusal \
sets `success: false` with a human-readable `error` and a machine-readable \
`code`. Some refusals arrive with status `200`, so check `success`, not only \
the HTTP status.

**Authentication.** When the host is configured with a token, every operation \
marked with `bearerAuth` needs `Authorization: Bearer <token>`. The token is \
never accepted in the query string. Without a configured token the gate is off.

**Writes.** Operations that change host state accept loopback peers only, \
unless the server runs with `--allow-remote-writes`. The desktop shared-live \
host refuses every write. Ledgered writes accept an optional `X-Command-Id` \
header (1-128 characters of `A-Z a-z 0-9 _ -`): resending the same id replays \
the first outcome instead of running the command twice.

**Realtime.** `/ws` and `/terminal/ws` are WebSocket upgrades. Their message \
protocol is out of scope for this spec.";

/// The OpenAPI 3.1 document for every route in [`ROUTES`].
pub fn document() -> Value {
    let mut requests = settings().for_deserialize().into_generator();
    let mut replies = settings().for_serialize().into_generator();
    let mut operations = ROUTES
        .iter()
        .map(|route| {
            let request = request_parts(route, &mut requests);
            let responses = responses(route, &mut replies);
            (route, request, responses)
        })
        .collect::<Vec<_>>();

    let request_schemas = requests.take_definitions(true);
    let reply_schemas = replies.take_definitions(true);
    let renames = input_renames(&request_schemas, &reply_schemas);
    for (_, request, _) in &mut operations {
        for value in request.values_mut() {
            rename_refs(value, &renames);
        }
    }
    let mut schemas: BTreeMap<String, Value> = BTreeMap::new();
    for (name, mut schema) in request_schemas {
        rename_refs(&mut schema, &renames);
        let name = renames.get(&name).cloned().unwrap_or(name);
        schemas.insert(name, schema);
    }
    for (name, schema) in reply_schemas {
        if let Some(previous) = schemas.insert(name.clone(), schema.clone()) {
            assert_eq!(previous, schema, "two different schemas are named {name}");
        }
    }
    assert!(
        !schemas.contains_key(ENVELOPE),
        "a Rust type is named {ENVELOPE}; it would shadow the envelope schema"
    );
    schemas.insert(ENVELOPE.to_string(), envelope_schema());

    let mut paths: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    for (route, request, responses) in operations {
        let mut operation = Map::new();
        operation.insert("operationId".into(), json!(operation_id(route)));
        operation.insert("summary".into(), json!(route.summary));
        if let Some(description) = route.description {
            operation.insert("description".into(), json!(description));
        }
        operation.insert("tags".into(), json!([route.tag.name()]));
        operation.insert("security".into(), security(route));
        operation.extend(request);
        operation.insert("responses".into(), Value::Object(responses));
        let previous = paths
            .entry(route.openapi_path())
            .or_default()
            .insert(route.method.as_str().into(), Value::Object(operation));
        assert!(
            previous.is_none(),
            "ROUTES lists {} {} twice",
            route.method.as_str(),
            route.path
        );
    }

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Termul server API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": API_DESCRIPTION,
            "license": { "name": "MIT", "identifier": "MIT" },
        },
        "servers": [{
            "url": "http://{host}:{port}",
            "description": "A Termul host",
            "variables": {
                "host": { "default": "localhost" },
                "port": { "default": "8080" },
            },
        }],
        "tags": Tag::ALL
            .iter()
            .map(|tag| json!({ "name": tag.name(), "description": tag.description() }))
            .collect::<Vec<_>>(),
        "paths": paths,
        "components": {
            "securitySchemes": {
                "bearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "The host's web auth token. Enforced only when the host has one configured.",
                },
            },
            "responses": {
                "IpcError": {
                    "description": "Refused: `success` is `false` and `code` names the reason.",
                    "content": { "application/json": { "schema": ref_to(ENVELOPE) } },
                },
                "Unauthorized": {
                    "description": "Missing or wrong bearer token (`code: UNAUTHORIZED`).",
                    "content": { "application/json": { "schema": ref_to(ENVELOPE) } },
                },
            },
            "schemas": schemas,
        },
    })
}

fn request_parts(route: &ApiRoute, generator: &mut SchemaGenerator) -> Map<String, Value> {
    let mut parameters: Vec<Value> = path_params(route.path)
        .into_iter()
        .map(|(name, catch_all)| {
            let mut param = json!({
                "name": name,
                "in": "path",
                "required": true,
                "schema": { "type": "string" },
            });
            if catch_all {
                param["description"] = json!("The rest of the path; may contain `/`.");
            }
            param
        })
        .collect();
    if let Some(query) = route.query {
        parameters.extend(query_params(route, query(generator).to_value()));
    }
    let mut parts = Map::new();
    if !parameters.is_empty() {
        parts.insert("parameters".into(), Value::Array(parameters));
    }
    if let Some(body) = route.body {
        parts.insert(
            "requestBody".into(),
            json!({
                "required": true,
                "content": { "application/json": { "schema": body(generator).to_value() } },
            }),
        );
    }
    parts
}

/// `(name, is_catch_all)` for each `{param}` / `{*param}` in an axum path.
pub(super) fn path_params(path: &str) -> Vec<(&str, bool)> {
    path.split('/')
        .filter_map(|segment| segment.strip_prefix('{')?.strip_suffix('}'))
        .map(|name| match name.strip_prefix('*') {
            Some(rest) => (rest, true),
            None => (name, false),
        })
        .collect()
}

/// One `in: query` parameter per field of the query struct's schema.
fn query_params(route: &ApiRoute, schema: Value) -> Vec<Value> {
    let mut schema = into_object(schema);
    let required: BTreeSet<String> = schema
        .remove("required")
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let Some(Value::Object(properties)) = schema.remove("properties") else {
        panic!(
            "{} {}: the query type must be a struct with named fields",
            route.method.as_str(),
            route.path
        );
    };
    properties
        .into_iter()
        .map(|(name, property)| {
            let mut property = into_object(property);
            let mut param = json!({
                "name": name,
                "in": "query",
                "required": required.contains(&name),
            });
            if let Some(description) = property.remove("description") {
                param["description"] = description;
            }
            param["schema"] = Value::Object(property);
            param
        })
        .collect()
}

fn responses(route: &ApiRoute, generator: &mut SchemaGenerator) -> Map<String, Value> {
    let mut responses = into_object(match route.reply {
        Reply::Ipc(data) => ipc_responses(data(generator).to_value()),
        Reply::IpcEmpty => ipc_responses(json!({ "type": "null" })),
        Reply::Bare(body) => json!({
            "200": {
                "description": "OK",
                "content": { "application/json": { "schema": body(generator).to_value() } },
            },
        }),
        Reply::Refused => json!({
            "401": {
                "description": "Always refused (`code: UNAUTHORIZED`).",
                "content": { "application/json": { "schema": ref_to(ENVELOPE) } },
            },
        }),
        Reply::Bytes(content_types) => json!({
            "default": { "$ref": "#/components/responses/IpcError" },
            "200": {
                "description": "The raw bytes.",
                "content": content_types
                    .iter()
                    .map(|content_type| {
                        (content_type.to_string(), json!({ "schema": { "type": "string", "format": "binary" } }))
                    })
                    .collect::<Map<_, _>>(),
            },
        }),
        Reply::Redirect => json!({
            "303": {
                "description": "Redirects back to the app.",
                "headers": { "Location": { "schema": { "type": "string" } } },
            },
            "400": {
                "description": "Malformed or unknown callback.",
                "content": { "text/plain": { "schema": { "type": "string" } } },
            },
            "500": {
                "description": "The token exchange failed.",
                "content": { "text/plain": { "schema": { "type": "string" } } },
            },
        }),
        Reply::Upgrade => json!({
            "101": { "description": "Switching Protocols: the connection becomes a WebSocket." },
        }),
    });
    for (status, description) in route.errors {
        let previous = responses.insert(
            status.to_string(),
            json!({
                "description": description,
                "content": { "application/json": { "schema": error_body_schema() } },
            }),
        );
        assert!(
            previous.is_none(),
            "{} {} documents {status} twice",
            route.method.as_str(),
            route.path
        );
    }
    if route.requires_token() {
        responses.insert(
            "401".into(),
            json!({ "$ref": "#/components/responses/Unauthorized" }),
        );
    }
    responses
}

fn ipc_responses(data: Value) -> Value {
    json!({
        "200": {
            "description": "The envelope. `data` is set when `success` is `true`.",
            "content": {
                "application/json": {
                    "schema": {
                        "allOf": [
                            ref_to(ENVELOPE),
                            { "type": "object", "properties": { "data": data } },
                        ],
                    },
                },
            },
        },
        "default": { "$ref": "#/components/responses/IpcError" },
    })
}

fn error_body_schema() -> Value {
    json!({
        "type": "object",
        "required": ["error"],
        "properties": {
            "error": { "type": "string", "description": "Human-readable reason." },
            "code": { "type": "string", "description": "Machine-readable reason, when the refusal has one." },
        },
    })
}

fn envelope_schema() -> Value {
    json!({
        "type": "object",
        "required": ["success"],
        "properties": {
            "success": { "type": "boolean" },
            "error": { "type": "string", "description": "Human-readable reason when `success` is `false`." },
            "code": { "type": "string", "description": "Machine-readable reason when `success` is `false`." },
            "details": { "description": "Structured refusal details (project commands)." },
            "receipt": {
                "type": "string",
                "enum": ["in_progress"],
                "description": "Set on an `X-Command-Id` resend that arrived while the first run is still going.",
            },
        },
    })
}

fn security(route: &ApiRoute) -> Value {
    if route.requires_token() {
        json!([{ "bearerAuth": [] }])
    } else {
        json!([])
    }
}

/// `post /git/stage-hunk` becomes `post_git_stage_hunk` (`.` maps to `_` too); a path parameter
/// `{id}` becomes `by_id`, and a trailing `/` adds `_dir` so `/canvas/{id}` and
/// `/canvas/{id}/` stay distinct.
pub(super) fn operation_id(route: &ApiRoute) -> String {
    let mut id = String::from(route.method.as_str());
    for segment in route.path.split('/').filter(|segment| !segment.is_empty()) {
        id.push('_');
        match segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            Some(param) => {
                id.push_str("by_");
                id.push_str(&param.trim_start_matches('*').replace('-', "_"));
            }
            None => id.push_str(&segment.replace(['-', '.'], "_")),
        }
    }
    if route.path.len() > 1 && route.path.ends_with('/') {
        id.push_str("_dir");
    }
    id
}

/// Request-side schemas that differ from the reply-side schema of the same
/// name get the [`INPUT_SUFFIX`], and so does every request-side schema that
/// reaches a renamed one through a `$ref`.
fn input_renames(
    requests: &Map<String, Value>,
    replies: &Map<String, Value>,
) -> BTreeMap<String, String> {
    let mut renamed: BTreeSet<&str> = requests
        .iter()
        .filter(|(name, schema)| replies.get(*name).is_some_and(|other| other != *schema))
        .map(|(name, _)| name.as_str())
        .collect();
    loop {
        let reaching: Vec<&str> = requests
            .iter()
            .filter(|(name, schema)| {
                !renamed.contains(name.as_str())
                    && replies.contains_key(*name)
                    && renamed.iter().any(|target| refers_to(schema, target))
            })
            .map(|(name, _)| name.as_str())
            .collect();
        if reaching.is_empty() {
            break;
        }
        renamed.extend(reaching);
    }
    renamed
        .into_iter()
        .map(|name| {
            let input = format!("{name}{INPUT_SUFFIX}");
            assert!(
                !requests.contains_key(&input) && !replies.contains_key(&input),
                "a Rust type is already named {input}"
            );
            (name.to_string(), input)
        })
        .collect()
}

fn refers_to(value: &Value, name: &str) -> bool {
    match value {
        Value::Object(map) => {
            map.get("$ref").and_then(Value::as_str)
                == Some(format!("#/components/schemas/{name}").as_str())
                || map.values().any(|child| refers_to(child, name))
        }
        Value::Array(items) => items.iter().any(|item| refers_to(item, name)),
        _ => false,
    }
}

fn rename_refs(value: &mut Value, renames: &BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(target)) = map.get_mut("$ref") {
                if let Some(name) = target.strip_prefix("#/components/schemas/") {
                    if let Some(renamed) = renames.get(name) {
                        *target = format!("#/components/schemas/{renamed}");
                    }
                }
            }
            for child in map.values_mut() {
                rename_refs(child, renames);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| rename_refs(item, renames)),
        _ => {}
    }
}
