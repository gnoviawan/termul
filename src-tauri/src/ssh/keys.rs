//! Private key inspection for the host editor and the connect pipeline.
//! Formats: OpenSSH, PEM (PKCS#1/PKCS#8) and PuTTY `.ppk`.
//!
//! Only reads headers: enough to tell the user whether a file is a usable
//! private key and whether it needs a passphrase. Key material never leaves
//! this module and is never logged.

use super::config_parser::ssh_dir;
use serde::Serialize;
use std::path::Path;

/// Larger files are not private keys; refuse to slurp them.
const MAX_KEY_FILE_BYTES: u64 = 64 * 1024;
/// Upper bound on keys listed from `~/.ssh`.
const MAX_DISCOVERED_KEYS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyFileStatus {
    Ok,
    NotFound,
    Unreadable,
    /// A public key (`.pub`) or some other file.
    NotPrivateKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFileInfo {
    pub path: String,
    pub status: KeyFileStatus,
    /// The key is protected by a passphrase.
    pub encrypted: bool,
    /// OpenSSH key type when it can be read without the passphrase.
    pub key_type: Option<String>,
}

pub(crate) fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for &c in input.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        acc = (acc << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Read one SSH wire-format string (u32 length + bytes) at `pos`.
fn read_string<'a>(data: &'a [u8], pos: &mut usize) -> Option<&'a [u8]> {
    let len_bytes = data.get(*pos..*pos + 4)?;
    let len = u32::from_be_bytes(len_bytes.try_into().ok()?) as usize;
    let start = *pos + 4;
    let value = data.get(start..start.checked_add(len)?)?;
    *pos = start + len;
    Some(value)
}

/// Parse the unencrypted header of an `openssh-key-v1` blob: returns
/// `(encrypted, key_type)`.
fn parse_openssh_header(blob: &[u8]) -> Option<(bool, Option<String>)> {
    const MAGIC: &[u8] = b"openssh-key-v1\0";
    let mut pos = MAGIC.len();
    if blob.get(..pos)? != MAGIC {
        return None;
    }
    let cipher = read_string(blob, &mut pos)?;
    let _kdf = read_string(blob, &mut pos)?;
    let _kdf_options = read_string(blob, &mut pos)?;
    pos += 4; // number of keys
    let public_key = read_string(blob, &mut pos)?;
    let mut key_pos = 0;
    let key_type = read_string(public_key, &mut key_pos)
        .and_then(|t| std::str::from_utf8(t).ok())
        .map(str::to_string);
    Some((cipher != b"none", key_type))
}

/// Classify key file contents.
pub(crate) fn classify(contents: &str) -> (KeyFileStatus, bool, Option<String>) {
    let text = contents.trim_start();
    if text.starts_with("PuTTY-User-Key-File-") {
        // `PuTTY-User-Key-File-3: ssh-ed25519` then `Encryption: none|aes256-cbc`.
        let key_type = text
            .lines()
            .next()
            .and_then(|line| line.split_once(':'))
            .map(|(_, t)| t.trim().to_string());
        let encrypted = !text.lines().any(|line| line.trim() == "Encryption: none");
        return (KeyFileStatus::Ok, encrypted, key_type);
    }
    if text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        let body: String = text
            .lines()
            .skip(1)
            .take_while(|line| !line.starts_with("-----END"))
            .collect();
        return match base64_decode(&body)
            .as_deref()
            .and_then(parse_openssh_header)
        {
            Some((encrypted, key_type)) => (KeyFileStatus::Ok, encrypted, key_type),
            None => (KeyFileStatus::NotPrivateKey, false, None),
        };
    }
    let pem_types = [
        ("-----BEGIN RSA PRIVATE KEY-----", Some("ssh-rsa")),
        ("-----BEGIN EC PRIVATE KEY-----", Some("ecdsa")),
        ("-----BEGIN DSA PRIVATE KEY-----", Some("ssh-dss")),
        ("-----BEGIN PRIVATE KEY-----", None),
    ];
    for (header, key_type) in pem_types {
        if text.starts_with(header) {
            let encrypted = text.contains("Proc-Type: 4,ENCRYPTED");
            return (KeyFileStatus::Ok, encrypted, key_type.map(str::to_string));
        }
    }
    if text.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        return (KeyFileStatus::Ok, true, None);
    }
    (KeyFileStatus::NotPrivateKey, false, None)
}

/// Inspect a private key file. `~` is expanded.
pub fn inspect(path: &str) -> KeyFileInfo {
    let expanded = super::config_parser::expand_tilde(path.trim());
    let info = |status, encrypted, key_type| KeyFileInfo {
        path: expanded.clone(),
        status,
        encrypted,
        key_type,
    };
    let file_path = Path::new(&expanded);
    let metadata = match std::fs::metadata(file_path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return info(KeyFileStatus::NotPrivateKey, false, None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return info(KeyFileStatus::NotFound, false, None)
        }
        Err(_) => return info(KeyFileStatus::Unreadable, false, None),
    };
    if metadata.len() > MAX_KEY_FILE_BYTES {
        return info(KeyFileStatus::NotPrivateKey, false, None);
    }
    match std::fs::read(file_path) {
        Ok(bytes) => {
            let (status, encrypted, key_type) = classify(&String::from_utf8_lossy(&bytes));
            info(status, encrypted, key_type)
        }
        Err(_) => info(KeyFileStatus::Unreadable, false, None),
    }
}

/// Private keys found in `~/.ssh`, sorted by file name.
pub fn discover() -> Vec<KeyFileInfo> {
    let Some(dir) = ssh_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut keys: Vec<KeyFileInfo> = entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !name.ends_with(".pub")
                && !name.starts_with("known_hosts")
                && name != "config"
                && name != "authorized_keys"
        })
        .filter_map(|entry| {
            let info = inspect(&entry.path().to_string_lossy());
            (info.status == KeyFileStatus::Ok).then_some(info)
        })
        .take(MAX_DISCOVERED_KEYS)
        .collect();
    keys.sort_by(|a, b| a.path.cmp(&b.path));
    keys
}

#[cfg(test)]
mod tests;
