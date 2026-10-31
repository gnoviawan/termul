use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use super::form::{Origin, Shown};
use super::launch_check::runs_inline_code;
use super::resolved::ResolvedConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConsentWarning {
    RunsLocalCode,
    RunsInlineCode,
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

/// A backslash, so an escape can't be forged, plus every character that
/// draws nothing or reorders what follows: controls (Cc), format characters
/// (Cf: bidi overrides, zero-width joiners, soft hyphen, tag characters),
/// line and paragraph separators, and the Hangul fillers, which render blank.
static MUST_ESCAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\x{115F}\x{1160}\x{3164}\x{FFA0}]")
        .expect("escape regex")
});

#[must_use]
pub fn escape_for_display(text: &str) -> String {
    MUST_ESCAPE
        .replace_all(text, |capture: &regex::Captures<'_>| {
            let ch = capture[0].chars().next().expect("one character matched");
            if ch == '\\' {
                "\\\\".to_string()
            } else {
                format!("\\u{{{:04X}}}", u32::from(ch))
            }
        })
        .into_owned()
}

pub(crate) struct ShownValue {
    pub name: String,
    pub shown: Shown,
}

impl ShownValue {
    fn consent(&self) -> ConsentValue {
        ConsentValue {
            name: escape_for_display(&self.name),
            value: self.shown.text.as_deref().map(escape_for_display),
            is_secret: self.shown.withheld,
            origin: self.shown.origin,
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
                if runs_inline_code(command, args) {
                    warnings.push(ConsentWarning::RunsInlineCode);
                }
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
