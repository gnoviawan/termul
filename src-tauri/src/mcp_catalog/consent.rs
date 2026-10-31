use serde::Serialize;

use super::form::Origin;
use super::resolved::ResolvedConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConsentWarning {
    RunsLocalCode,
    SendsDataRemote,
    MutableTag,
    Deprecated,
    FromFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Namespace {
    Github { account: String },
    Domain { domain: String },
}

impl Namespace {
    pub(crate) fn of(registry_name: &str) -> Self {
        let prefix = registry_name.split('/').next().unwrap_or(registry_name);
        match prefix.strip_prefix("io.github.") {
            Some(account) => Self::Github {
                account: account.to_string(),
            },
            None => Self::Domain {
                domain: prefix.to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentProvenance {
    pub namespace: Namespace,
    pub repository_url: Option<String>,
    pub version: String,
    pub mutable_tag: bool,
    pub snapshot_fetched_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentValue {
    pub name: String,
    pub value: Option<String>,
    pub is_secret: bool,
    pub origin: Origin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentView {
    pub transport: &'static str,
    pub command: Option<String>,
    pub argv: Vec<String>,
    pub url: Option<String>,
    pub env: Vec<ConsentValue>,
    pub headers: Vec<ConsentValue>,
    pub warnings: Vec<ConsentWarning>,
    pub provenance: Option<ConsentProvenance>,
}

fn must_escape(ch: char) -> bool {
    ch.is_control()
        || matches!(
            ch,
            '\u{061C}'
                | '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

#[must_use]
pub fn escape_for_display(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ch if must_escape(ch) => {
                out.push_str(&format!("\\u{{{:04X}}}", u32::from(ch)));
            }
            ch => out.push(ch),
        }
    }
    out
}

pub(crate) struct ShownValue {
    pub name: String,
    pub is_secret: bool,
    pub value: Option<(String, Origin)>,
}

impl ShownValue {
    /// Only a value the user typed into a secret field is withheld. Registry
    /// or file text is shown even when flagged secret, because the user did
    /// not choose it and is consenting to it.
    fn consent(&self) -> ConsentValue {
        let (value, origin) = match &self.value {
            Some((value, origin)) if !self.is_secret || *origin != Origin::User => {
                (Some(escape_for_display(value)), *origin)
            }
            Some((_, origin)) => (None, *origin),
            None => (None, Origin::User),
        };
        ConsentValue {
            name: escape_for_display(&self.name),
            is_secret: value.is_none(),
            value,
            origin,
        }
    }
}

pub(crate) struct ConsentInput<'a> {
    pub config: &'a ResolvedConfig,
    pub values: &'a [ShownValue],
    pub provenance: Option<ConsentProvenance>,
    pub deprecated: bool,
    pub from_file: bool,
}

impl ConsentView {
    pub(crate) fn build(input: ConsentInput<'_>) -> Self {
        let shown: Vec<ConsentValue> = input.values.iter().map(ShownValue::consent).collect();
        let mut warnings = Vec::new();
        let (transport, command, argv, url, env, headers) = match input.config {
            ResolvedConfig::Stdio { command, args, .. } => {
                warnings.push(ConsentWarning::RunsLocalCode);
                (
                    "stdio",
                    Some(escape_for_display(command)),
                    std::iter::once(command.as_str())
                        .chain(args.iter().map(String::as_str))
                        .map(escape_for_display)
                        .collect(),
                    None,
                    shown,
                    Vec::new(),
                )
            }
            ResolvedConfig::Http { url, .. } | ResolvedConfig::Sse { url, .. } => {
                warnings.push(ConsentWarning::SendsDataRemote);
                let transport = if matches!(input.config, ResolvedConfig::Http { .. }) {
                    "http"
                } else {
                    "sse"
                };
                (
                    transport,
                    None,
                    Vec::new(),
                    Some(escape_for_display(url)),
                    Vec::new(),
                    shown,
                )
            }
        };
        if input.provenance.as_ref().is_some_and(|p| p.mutable_tag) {
            warnings.push(ConsentWarning::MutableTag);
        }
        if input.deprecated {
            warnings.push(ConsentWarning::Deprecated);
        }
        if input.from_file {
            warnings.push(ConsentWarning::FromFile);
        }
        Self {
            transport,
            command,
            argv,
            url,
            env,
            headers,
            warnings,
            provenance: input.provenance,
        }
    }
}
