//! Host key verification against OpenSSH `known_hosts` files.
//!
//! Two stores are consulted: the app-managed `~/.ssh/known_hosts_termul`
//! (written by Termul, one plain OpenSSH line per trusted host) and the
//! user's `~/.ssh/known_hosts` (read-only — system ssh owns it). A key is
//! trusted when either store matches it. An unknown key is never accepted
//! silently: the caller must ask the user and then call [`trust`].
//!
//! The parser understands what `ssh` writes: comma-separated host patterns,
//! `[host]:port`, hashed names (`|1|salt|hash`), `*`/`?` wildcards, `!`
//! negation and the `@revoked` marker. Lines it cannot read are skipped, so
//! one exotic entry never blocks every connection.

use hmac::{Hmac, KeyInit, Mac};
use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;
use sha1::Sha1;
use std::path::PathBuf;
use std::sync::Mutex;

/// Serializes writes to the app-managed file (two sessions may trust hosts
/// at the same time).
static APP_FILE_LOCK: Mutex<()> = Mutex::new(());

/// What the server presented, in the form shown to the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    /// OpenSSH key type name, e.g. `ssh-ed25519`.
    pub key_type: String,
    /// `SHA256:<base64>` — the same format `ssh-keygen -lf` prints.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyStatus {
    Trusted,
    /// No entry for this host (with this key type) in either store.
    Unknown,
    /// An entry exists for this host and key type, but with a different key
    /// (or the presented key is marked `@revoked`).
    Changed,
}

/// Result of checking one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileVerdict {
    Match,
    Mismatch,
    NotFound,
}

pub fn info_for(host: &str, port: u16, key: &PublicKey) -> HostKeyInfo {
    HostKeyInfo {
        host: host.to_string(),
        port,
        key_type: key.algorithm().as_str().to_string(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
    }
}

/// `host` for port 22, `[host]:port` otherwise (OpenSSH known_hosts syntax).
pub(crate) fn host_entry(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    }
}

/// `*` and `?` glob match, case-insensitive like OpenSSH host matching.
fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    match (pattern.first(), text.first()) {
        (None, None) => true,
        (Some(b'*'), _) => {
            glob_match(&pattern[1..], text) || (!text.is_empty() && glob_match(pattern, &text[1..]))
        }
        (Some(b'?'), Some(_)) => glob_match(&pattern[1..], &text[1..]),
        (Some(p), Some(t)) if p.eq_ignore_ascii_case(t) => glob_match(&pattern[1..], &text[1..]),
        _ => false,
    }
}

fn hashed_match(pattern: &str, entry: &str) -> bool {
    let mut parts = pattern.trim_start_matches("|1|").split('|');
    let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else {
        return false;
    };
    let (Some(salt), Some(hash)) = (
        super::keys::base64_decode(salt),
        super::keys::base64_decode(hash),
    ) else {
        return false;
    };
    let Ok(mac) = <Hmac<Sha1> as KeyInit>::new_from_slice(&salt) else {
        return false;
    };
    mac.chain_update(entry.as_bytes())
        .verify_slice(&hash)
        .is_ok()
}

/// Does a comma-separated pattern list name `entry` (`host` or `[host]:port`)?
pub(crate) fn patterns_match(patterns: &str, entry: &str) -> bool {
    let mut matched = false;
    for pattern in patterns.split(',') {
        if let Some(negated) = pattern.strip_prefix('!') {
            if glob_match(negated.as_bytes(), entry.as_bytes()) {
                return false;
            }
        } else if pattern.starts_with("|1|") {
            matched |= hashed_match(pattern, entry);
        } else {
            matched |= glob_match(pattern.as_bytes(), entry.as_bytes());
        }
    }
    matched
}

/// Check `key` against the contents of one known_hosts file.
pub(crate) fn verdict(contents: &str, entry: &str, key: &PublicKey) -> FileVerdict {
    let mut mismatch = false;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let mut first = fields.next().unwrap_or("");
        let marker = first.strip_prefix('@').map(str::to_string);
        if marker.is_some() {
            first = fields.next().unwrap_or("");
        }
        let (Some(key_type), Some(blob)) = (fields.next(), fields.next()) else {
            continue;
        };
        if !patterns_match(first, entry) {
            continue;
        }
        let Ok(recorded) = PublicKey::from_openssh(&format!("{} {}", key_type, blob)) else {
            continue;
        };
        match marker.as_deref() {
            // A revoked key is never trusted, whatever else the file says.
            Some("revoked") if recorded.key_data() == key.key_data() => {
                return FileVerdict::Mismatch
            }
            Some(_) => continue,
            None => {}
        }
        if recorded.algorithm() != key.algorithm() {
            continue;
        }
        if recorded.key_data() == key.key_data() {
            return FileVerdict::Match;
        }
        mismatch = true;
    }
    if mismatch {
        FileVerdict::Mismatch
    } else {
        FileVerdict::NotFound
    }
}

/// Combine the per-file results. Either store matching is enough; a
/// mismatch in either store with no match anywhere means the key changed.
pub(crate) fn combine(app: FileVerdict, user: FileVerdict) -> HostKeyStatus {
    match (app, user) {
        (FileVerdict::Match, _) | (_, FileVerdict::Match) => HostKeyStatus::Trusted,
        (FileVerdict::Mismatch, _) | (_, FileVerdict::Mismatch) => HostKeyStatus::Changed,
        _ => HostKeyStatus::Unknown,
    }
}

fn ssh_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    Some(home.join(".ssh"))
}

pub(crate) fn app_known_hosts_path() -> Option<PathBuf> {
    ssh_dir().map(|d| d.join("known_hosts_termul"))
}

fn user_known_hosts_path() -> Option<PathBuf> {
    ssh_dir().map(|d| d.join("known_hosts"))
}

/// Read a known_hosts file; a missing file is empty. `strict` makes other
/// read errors fatal (the app-managed file is ours; failing open would
/// downgrade a populated store to "unknown").
fn read_store(path: Option<PathBuf>, strict: bool) -> Result<String, String> {
    let Some(path) = path else {
        return Ok(String::new());
    };
    match std::fs::read(&path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) if strict => {
            log::error!("[SSH] Failed to read app known_hosts: {}", e);
            Err(format!("Failed to read {}: {}", path.display(), e))
        }
        Err(e) => {
            log::warn!("[SSH] Could not read user known_hosts: {}", e);
            Ok(String::new())
        }
    }
}

/// Verify the presented key against both stores.
pub fn check(host: &str, port: u16, key: &PublicKey) -> Result<HostKeyStatus, String> {
    let entry = host_entry(host, port);
    let app = read_store(app_known_hosts_path(), true)?;
    let user = read_store(user_known_hosts_path(), false)?;
    Ok(combine(
        verdict(&app, &entry, key),
        verdict(&user, &entry, key),
    ))
}

/// Drop the app-file lines whose first field names exactly `entry` (Termul
/// writes one host pattern per line, so other lines are left untouched).
pub(crate) fn without_entry(contents: &str, entry: &str) -> String {
    let mut kept = String::with_capacity(contents.len());
    for line in contents.lines() {
        let first = line.split_whitespace().next().unwrap_or("");
        let names_host = first.split(',').any(|name| name == entry);
        if !names_host {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    kept
}

/// Persist trust for this host key in the app-managed file, replacing any
/// previous Termul entry for the same host and port.
pub fn trust(host: &str, port: u16, key: &PublicKey) -> Result<(), String> {
    let path = app_known_hosts_path().ok_or_else(|| "Home directory not found".to_string())?;
    let entry = host_entry(host, port);
    let mut public = key.clone();
    public.set_comment("");
    let encoded = public
        .to_openssh()
        .map_err(|e| format!("Could not encode the host key: {}", e))?;
    let line = format!("{} {}\n", entry, encoded.trim());

    let _guard = APP_FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create ~/.ssh: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let existing = read_store(Some(path.clone()), true)?;
    let mut next = without_entry(&existing, &entry);
    next.push_str(&line);

    // Write a sibling temp file then rename, so a crash never leaves a
    // truncated store behind.
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, next).map_err(|e| format!("Failed to write known hosts: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to save known hosts: {}", e)
    })?;
    log::info!(
        "[SSH] Trusted host key {} ({})",
        key.fingerprint(HashAlg::Sha256),
        key.algorithm().as_str()
    );
    Ok(())
}

#[cfg(test)]
mod tests;
