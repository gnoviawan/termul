//! The one `launch_digest` (AD-7): SHA-256 over canonical JSON of the launch
//! spec and its catalog provenance. Secret values are not an input, so
//! rotating a key is not drift. The renderer never computes it.
//!
//! Canonical form: a fixed-field struct serialized by `serde_json` (field
//! order is the struct's, never a caller's map order), env and header names
//! sorted, argv in order. The `v` field versions the form itself; bump it
//! only with a migration of every stored approval.
//!
//! Secret references (AD-6) enter the digest through the slot name: a ref is
//! owned by exactly one entry, so `<entryId>` plus `env:<NAME>` or
//! `header:<NAME>` identifies it, and the name is already here. Story 8 must
//! derive its ref ids from the slot name for this to hold. If it mints random
//! ids and adds them here, a plan can no longer carry the digest its entry
//! will have, and CAP-3's "saved digest equals the consented digest" breaks.

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

/// `sha256:<hex>` of the canonical launch spec.
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
