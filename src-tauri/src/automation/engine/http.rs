//! `http` nodes. The only place secret values are read. Every hop's host
//! must be in `allowed_hosts`, redirects included, and any secret value the
//! response or an error echoes back is redacted before it is stored.

use std::collections::HashMap;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, LOCATION};
use reqwest::{Method, StatusCode, Url};
use serde_json::{json, Map, Value};

use super::nodes::{render, render_text, NodeError, NodeScope};
use super::HttpConfig;
use crate::automation::model::{HttpMethod, NamedTemplate, Template};
use crate::automation::secrets::SecretError;

const MAX_REDIRECTS: usize = 5;
const KEPT_HEADERS: [&str; 6] = [
    "content-type",
    "content-length",
    "etag",
    "last-modified",
    "location",
    "retry-after",
];
const REDACTED: &str = "[redacted]";

pub(super) struct HttpRunner {
    client: reqwest::Client,
    config: HttpConfig,
}

impl HttpRunner {
    pub(super) fn new(config: HttpConfig) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        for (host, addr) in &config.resolve {
            builder = builder.resolve(host, *addr);
        }
        let client = builder
            .build()
            .map_err(|e| format!("automation http client: {e}"))?;
        Ok(Self { client, config })
    }
}

pub(super) struct HttpSpec<'a> {
    pub method: HttpMethod,
    pub url: &'a Template,
    pub headers: &'a [NamedTemplate],
    pub body: Option<&'a Template>,
    pub allowed_hosts: &'a [String],
    pub secret_names: Vec<String>,
}

pub(super) async fn run(scope: &NodeScope<'_>, spec: HttpSpec<'_>) -> Result<Value, NodeError> {
    let secrets = resolve_secrets(scope, spec.secret_names).await?;
    let redactor = Redactor::new(&secrets);
    let ctx = scope.render_context(Some(&secrets));
    let mut url = Url::parse(&render_text(spec.url, &ctx)?)
        .map_err(|e| NodeError::failed(redactor.text(&format!("invalid_url: {e}"))))?;
    check_allowed(&url, spec.allowed_hosts, "host_not_allowed").map_err(|e| redactor.error(e))?;
    let mut headers = HeaderMap::new();
    for header in spec.headers {
        let value = render_text(&header.value, &ctx)?;
        let name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|_| NodeError::failed(format!("invalid_header: {}", header.name)))?;
        let value = HeaderValue::from_str(&value)
            .map_err(|_| NodeError::failed(format!("invalid_header: {}", header.name)))?;
        headers.append(name, value);
    }
    let mut body = match spec.body {
        None => None,
        Some(template) => Some(match render(template, &ctx)? {
            Value::String(text) => text.into_bytes(),
            other => {
                if !headers.contains_key(CONTENT_TYPE) {
                    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                }
                other.to_string().into_bytes()
            }
        }),
    };
    let idempotency_key = format!("{}:{}", scope.run.run.id, scope.node_id);
    let runner = &scope.run.engine.http;
    let mut method = to_method(spec.method);
    for _ in 0..=MAX_REDIRECTS {
        let mut request = runner
            .client
            .request(method.clone(), url.clone())
            .headers(headers.clone())
            .header("Idempotency-Key", &idempotency_key)
            .timeout(runner.config.request_timeout);
        if let Some(bytes) = &body {
            request = request.body(bytes.clone());
        }
        let response = tokio::select! {
            sent = request.send() => sent.map_err(|e| request_error(&redactor, e))?,
            _ = scope.run.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        let status = response.status();
        if let Some(next) = redirect_target(&url, &response) {
            check_allowed(&next, spec.allowed_hosts, "redirect_blocked")
                .map_err(|e| redactor.error(e))?;
            if status == StatusCode::SEE_OTHER
                || (matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND)
                    && method != Method::GET
                    && method != Method::HEAD)
            {
                method = Method::GET;
                body = None;
                headers.remove(CONTENT_TYPE);
            }
            url = next;
            continue;
        }
        let output = tokio::select! {
            read = read_output(response, runner.config.body_cap) => read.map_err(|e| request_error(&redactor, e))?,
            _ = scope.run.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        let output = redactor.value(output);
        if !status.is_success() {
            return Err(NodeError::Failed {
                message: format!("http_status:{}", status.as_u16()),
                output: Some(output),
            });
        }
        return Ok(output);
    }
    Err(NodeError::failed("too_many_redirects"))
}

async fn resolve_secrets(
    scope: &NodeScope<'_>,
    names: Vec<String>,
) -> Result<HashMap<String, String>, NodeError> {
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let secrets = scope.run.engine.secrets.clone();
    let project_id = scope.run.project_id.to_string();
    let resolved = tokio::task::spawn_blocking(move || secrets.resolve(&project_id, &names))
        .await
        .unwrap_or(Err(SecretError::KeychainUnavailable));
    resolved.map_err(|error| {
        log::warn!(
            "[Automation] run {} step {}: {error}",
            scope.run.run.id,
            scope.node_id
        );
        NodeError::failed(error.to_string())
    })
}

fn to_method(method: HttpMethod) -> Method {
    match method {
        HttpMethod::Get => Method::GET,
        HttpMethod::Post => Method::POST,
        HttpMethod::Put => Method::PUT,
        HttpMethod::Patch => Method::PATCH,
        HttpMethod::Delete => Method::DELETE,
    }
}

fn check_allowed(url: &Url, allowed: &[String], code: &str) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{code}: scheme {}", url.scheme()));
    }
    let host = url.host_str().unwrap_or_default();
    if allowed.iter().any(|a| a.eq_ignore_ascii_case(host)) {
        Ok(())
    } else {
        Err(format!("{code}:{host}"))
    }
}

fn redirect_target(current: &Url, response: &reqwest::Response) -> Option<Url> {
    if !response.status().is_redirection() {
        return None;
    }
    let location = response.headers().get(LOCATION)?.to_str().ok()?;
    current.join(location).ok()
}

fn request_error(redactor: &Redactor, error: reqwest::Error) -> NodeError {
    let kind = if error.is_timeout() {
        "http_timeout"
    } else {
        "http_error"
    };
    NodeError::failed(redactor.text(&format!("{kind}: {}", error.without_url())))
}

/// `{ status, headers, body }`: a subset of headers, the body as JSON when it
/// parses and as text otherwise, cut at `cap` bytes (`truncated: true`).
async fn read_output(mut response: reqwest::Response, cap: usize) -> Result<Value, reqwest::Error> {
    let status = response.status().as_u16();
    let headers: Map<String, Value> = KEPT_HEADERS
        .iter()
        .filter_map(|name| {
            let value = response.headers().get(*name)?.to_str().ok()?;
            Some((name.to_string(), Value::String(value.to_string())))
        })
        .collect();
    let mut bytes = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response.chunk().await? {
        let room = cap - bytes.len();
        if chunk.len() > room {
            bytes.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = match serde_json::from_slice::<Value>(&bytes) {
        Ok(json) if !truncated => json,
        _ => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
    };
    let mut output = json!({ "status": status, "headers": headers, "body": body });
    if truncated {
        output["truncated"] = Value::Bool(true);
    }
    Ok(output)
}

/// Replaces every secret value the node used wherever it appears.
struct Redactor<'a> {
    values: Vec<&'a str>,
}

impl<'a> Redactor<'a> {
    fn new(secrets: &'a HashMap<String, String>) -> Self {
        Self {
            values: secrets
                .values()
                .map(String::as_str)
                .filter(|v| !v.is_empty())
                .collect(),
        }
    }

    fn text(&self, text: &str) -> String {
        self.values.iter().fold(text.to_string(), |acc, secret| {
            acc.replace(secret, REDACTED)
        })
    }

    fn error(&self, message: String) -> NodeError {
        NodeError::failed(self.text(&message))
    }

    fn value(&self, value: Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.text(&s)),
            Value::Array(items) => Value::Array(items.into_iter().map(|v| self.value(v)).collect()),
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(k, v)| (self.text(&k), self.value(v)))
                    .collect(),
            ),
            other => other,
        }
    }
}
