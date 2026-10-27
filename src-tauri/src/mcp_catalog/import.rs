//! `import` plans (AD-5, CAP-7): an `mcpServers` JSON blob, or one bare
//! server object, becomes a launch spec whose every value came from a file.
//! The AD-4 env deny-list, package grammar and URL rules apply exactly as to
//! catalog conversion, through the same `convert.rs` functions.

use std::fmt;

use serde_json::{Map, Value};

use super::convert::{
    check_env_name, check_header_name, check_package_spec, check_remote_url, McpCatalogReason,
    RemoteTransport, Runner,
};
use super::form::{FieldTarget, FormModel};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ImportedLaunch {
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
    Remote {
        transport: RemoteTransport,
        url: String,
        headers: Vec<(String, String)>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImportedServer {
    pub name: String,
    pub launch: ImportedLaunch,
}

/// Why the blob is not an import (`MCP_IMPORT_INVALID`). Messages never
/// echo file values, only keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ImportError {
    Json,
    NotAnObject,
    NoServers,
    ServerNotFound(String),
    SeveralServers(Vec<String>),
    Shape { server: String, field: String },
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json => f.write_str("the import is not valid JSON"),
            Self::NotAnObject => f.write_str("the import must be a JSON object"),
            Self::NoServers => f.write_str("the import has no servers"),
            Self::ServerNotFound(name) => write!(f, "the import has no server named `{name}`"),
            Self::SeveralServers(names) => write!(
                f,
                "the import has {} servers ({}); pass `server` to pick one",
                names.len(),
                names.join(", ")
            ),
            Self::Shape { server, field } => {
                write!(f, "server `{server}`: `{field}` has the wrong shape")
            }
        }
    }
}

/// `{"name": "value"}` maps and `[{"name", "value"}]` lists both read as pairs.
fn name_value_pairs(value: Option<&Value>) -> Option<Vec<(String, String)>> {
    match value {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(name, value)| Some((name.clone(), value.as_str()?.to_string())))
            .collect(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                Some((
                    item.get("name")?.as_str()?.to_string(),
                    item.get("value")?.as_str()?.to_string(),
                ))
            })
            .collect(),
        Some(_) => None,
    }
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect(),
        Some(_) => None,
    }
}

fn string_field(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn server_from(name: &str, raw: &Map<String, Value>) -> Result<ImportedServer, ImportError> {
    let shape = |field: &str| ImportError::Shape {
        server: name.to_string(),
        field: field.to_string(),
    };
    let command = string_field(raw.get("command"));
    let url = string_field(raw.get("url"));
    let transport = match (raw.get("type").and_then(Value::as_str), &command, &url) {
        (Some("stdio"), _, _) => "stdio",
        (Some("http"), _, _) => "http",
        (Some("sse"), _, _) => "sse",
        (_, Some(_), _) => "stdio",
        (_, None, Some(_)) => "http",
        _ => "stdio",
    };
    let launch = if transport == "stdio" {
        ImportedLaunch::Stdio {
            command: command.ok_or_else(|| shape("command"))?,
            args: string_list(raw.get("args")).ok_or_else(|| shape("args"))?,
            env: name_value_pairs(raw.get("env")).ok_or_else(|| shape("env"))?,
        }
    } else {
        ImportedLaunch::Remote {
            transport: if transport == "sse" {
                RemoteTransport::Sse
            } else {
                RemoteTransport::Http
            },
            url: url.ok_or_else(|| shape("url"))?,
            headers: name_value_pairs(raw.get("headers")).ok_or_else(|| shape("headers"))?,
        }
    };
    Ok(ImportedServer {
        name: name.to_string(),
        launch,
    })
}

/// Pick one server out of the blob. `server` is the `mcpServers` key; it is
/// required when the blob holds several.
pub(crate) fn parse_import(
    json: &str,
    server: Option<&str>,
) -> Result<ImportedServer, ImportError> {
    let parsed: Value = serde_json::from_str(json).map_err(|_| ImportError::Json)?;
    let Value::Object(root) = parsed else {
        return Err(ImportError::NotAnObject);
    };
    match root.get("mcpServers") {
        Some(Value::Object(servers)) => {
            if servers.is_empty() {
                return Err(ImportError::NoServers);
            }
            let (name, raw) = match server {
                Some(name) => (
                    name,
                    servers
                        .get(name)
                        .ok_or_else(|| ImportError::ServerNotFound(name.to_string()))?,
                ),
                None if servers.len() == 1 => servers.iter().next().map_or_else(
                    || unreachable!("one server"),
                    |(name, raw)| (name.as_str(), raw),
                ),
                None => {
                    return Err(ImportError::SeveralServers(
                        servers.keys().cloned().collect(),
                    ))
                }
            };
            let Value::Object(raw) = raw else {
                return Err(ImportError::Shape {
                    server: name.to_string(),
                    field: "server".to_string(),
                });
            };
            server_from(name, raw)
        }
        Some(_) => Err(ImportError::Shape {
            server: String::new(),
            field: "mcpServers".to_string(),
        }),
        None => {
            let name = string_field(root.get("name")).unwrap_or_else(|| "imported".to_string());
            server_from(&name, &root)
        }
    }
}

fn has_control_char(text: &str) -> bool {
    text.chars().any(char::is_control)
}

fn no_control(text: &str, field: impl Into<String>) -> Result<(), McpCatalogReason> {
    if has_control_char(text) {
        Err(McpCatalogReason::ControlCharacter {
            field: field.into(),
        })
    } else {
        Ok(())
    }
}

/// Which fixed runner a command on a file names, if any.
fn runner_of(command: &str) -> Option<Runner> {
    let base = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase();
    let base = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".cmd"))
        .unwrap_or(&base);
    match base {
        "npx" => Some(Runner::Npx),
        "uvx" => Some(Runner::Uvx),
        "docker" => Some(Runner::Docker),
        "dotnet" => Some(Runner::Dotnet),
        _ => None,
    }
}

/// The package spec handed to a runner, when its CLI shape makes it
/// identifiable: the first non-flag argument (`npx`, `uvx`, and `dotnet dnx`)
/// plus any `--flag=value` payload, which is how a package is also named.
/// Docker's image sits behind value-taking flags, so it is not checked.
fn check_runner_package_specs(runner: Runner, args: &[String]) -> Result<(), McpCatalogReason> {
    let args = match runner {
        Runner::Docker => return Ok(()),
        Runner::Dotnet => match args.first().map(String::as_str) {
            Some("dnx") => &args[1..],
            _ => return Ok(()),
        },
        Runner::Npx | Runner::Uvx => args,
    };
    for arg in args {
        if let Some(stripped) = arg.strip_prefix('-') {
            if let Some((_, value)) = stripped.split_once('=') {
                check_package_spec(runner, value)?;
            }
            continue;
        }
        return check_package_spec(runner, arg);
    }
    Ok(())
}

/// The AD-4 rules on a file's launch spec, with the typed reason.
pub(crate) fn check_import(server: &ImportedServer) -> Result<(), McpCatalogReason> {
    match &server.launch {
        ImportedLaunch::Stdio { command, args, env } => {
            if command.starts_with('-') {
                return Err(McpCatalogReason::InvalidCommand);
            }
            no_control(command, "command")?;
            for (index, arg) in args.iter().enumerate() {
                no_control(arg, format!("args[{index}]"))?;
            }
            for (name, value) in env {
                check_env_name(name)?;
                no_control(value, format!("env/{name}"))?;
            }
            if let Some(runner) = runner_of(command) {
                check_runner_package_specs(runner, args)?;
            }
        }
        ImportedLaunch::Remote { url, headers, .. } => {
            check_remote_url(url)?;
            for (name, value) in headers {
                check_header_name(name)?;
                no_control(value, format!("header/{name}"))?;
            }
        }
    }
    Ok(())
}

/// No fields: every slot is a fixed file value.
pub(crate) fn import_form(server: &ImportedServer) -> FormModel {
    match &server.launch {
        ImportedLaunch::Stdio { args, env, .. } => FormModel::fixed(
            args.iter()
                .enumerate()
                .map(|(index, value)| (FieldTarget::Argument { index, name: None }, value.clone()))
                .chain(
                    env.iter().map(|(name, value)| {
                        (FieldTarget::Env { name: name.clone() }, value.clone())
                    }),
                ),
        ),
        ImportedLaunch::Remote { url, headers, .. } => {
            FormModel::fixed(std::iter::once((FieldTarget::Url, url.clone())).chain(
                headers.iter().map(|(name, value)| {
                    (FieldTarget::Header { name: name.clone() }, value.clone())
                }),
            ))
        }
    }
}
