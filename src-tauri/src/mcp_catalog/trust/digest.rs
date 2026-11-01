use serde::Serialize;
use sha2::{Digest, Sha256};

use super::super::resolved::{Provenance, ResolvedConfig};

const DIGEST_FORM_VERSION: u8 = 1;

#[derive(Serialize)]
struct Canonical<'a> {
    v: u8,
    transport: &'static str,
    command: Option<&'a str>,
    argv: Vec<&'a str>,
    url: Option<&'a str>,
    env: Vec<&'a str>,
    headers: Vec<&'a str>,
    provenance: Option<&'a Provenance>,
}

fn sorted_names(slots: &[super::super::resolved::ValueSlot]) -> Vec<&str> {
    let mut names: Vec<&str> = slots.iter().map(|slot| slot.name.as_str()).collect();
    names.sort_unstable();
    names
}

#[must_use]
pub fn launch_digest(config: &ResolvedConfig, provenance: Option<&Provenance>) -> String {
    let canonical = match config {
        ResolvedConfig::Stdio { command, args, env } => Canonical {
            v: DIGEST_FORM_VERSION,
            transport: "stdio",
            command: Some(command),
            argv: std::iter::once(command.as_str())
                .chain(args.iter().map(String::as_str))
                .collect(),
            url: None,
            env: sorted_names(env),
            headers: Vec::new(),
            provenance,
        },
        ResolvedConfig::Http { url, headers } => Canonical {
            v: DIGEST_FORM_VERSION,
            transport: "http",
            command: None,
            argv: Vec::new(),
            url: Some(url),
            env: Vec::new(),
            headers: sorted_names(headers),
            provenance,
        },
        ResolvedConfig::Sse { url, headers } => Canonical {
            v: DIGEST_FORM_VERSION,
            transport: "sse",
            command: None,
            argv: Vec::new(),
            url: Some(url),
            env: Vec::new(),
            headers: sorted_names(headers),
            provenance,
        },
    };
    let bytes = serde_json::to_vec(&canonical).expect("strings and lists always serialize");
    format!("sha256:{:x}", Sha256::digest(bytes))
}
