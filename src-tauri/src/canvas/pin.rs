//! The pinned figcraft web bundle (`canvas/figcraft.pin`, spine AD-24).
//!
//! The pin file is the single source of truth for which fork bundle a build
//! embeds: the fetch script (`scripts/canvas/fetch-figcraft-bundle.mjs`)
//! downloads and verifies by it, and the mount-time compare against the
//! bundle's `host.describe` tag reads [`pinned_tag`].

use std::sync::OnceLock;

const PIN_TEXT: &str = include_str!("../../../canvas/figcraft.pin");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundlePin {
    pub tag: String,
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinError {
    MalformedLine(String),
    UnknownField(String),
    DuplicateField(&'static str),
    MissingField(&'static str),
    InvalidSha256,
}

impl std::fmt::Display for PinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MalformedLine(line) => write!(f, "malformed pin line {line:?}"),
            Self::UnknownField(name) => write!(f, "unknown pin field {name:?}"),
            Self::DuplicateField(name) => write!(f, "duplicate pin field {name}"),
            Self::MissingField(name) => write!(f, "missing pin field {name}"),
            Self::InvalidSha256 => f.write_str("sha256 must be 64 lowercase hex characters"),
        }
    }
}

impl std::error::Error for PinError {}

pub fn parse_pin(text: &str) -> Result<BundlePin, PinError> {
    let mut tag = None;
    let mut url = None;
    let mut sha256 = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once('=')
            .filter(|(name, _)| !name.is_empty())
            .ok_or_else(|| PinError::MalformedLine(line.to_string()))?;
        let (slot, field) = match name {
            "tag" => (&mut tag, "tag"),
            "url" => (&mut url, "url"),
            "sha256" => (&mut sha256, "sha256"),
            other => return Err(PinError::UnknownField(other.to_string())),
        };
        if slot.replace(value.to_string()).is_some() {
            return Err(PinError::DuplicateField(field));
        }
    }
    let nonempty = |value: Option<String>, field: &'static str| {
        value
            .filter(|value| !value.is_empty())
            .ok_or(PinError::MissingField(field))
    };
    let pin = BundlePin {
        tag: nonempty(tag, "tag")?,
        url: nonempty(url, "url")?,
        sha256: nonempty(sha256, "sha256")?,
    };
    let hex = pin.sha256.len() == 64
        && pin
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !hex {
        return Err(PinError::InvalidSha256);
    }
    Ok(pin)
}

/// The pin this binary was built against. The file is compiled in and
/// checked by `embedded_pin_is_valid`, so a parse failure here is a
/// build-time defect, not a runtime condition.
pub fn pin() -> &'static BundlePin {
    static PIN: OnceLock<BundlePin> = OnceLock::new();
    PIN.get_or_init(|| parse_pin(PIN_TEXT).expect("canvas/figcraft.pin is validated by tests"))
}

pub fn pinned_tag() -> &'static str {
    &pin().tag
}
