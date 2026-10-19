//! One-shot self-heal for npm's shared npx cache (issue #1413).
//!
//! Agents launched as `npx -y <pkg>@<version>` depend on the cache entry
//! npm keeps per spec (`~/.npm/_npx/<hash>/`). That entry can end up with a
//! populated `node_modules` but no `package.json` (a partially-created or
//! interrupted bootstrap). npm then refuses every later launch with
//! `npm error code ENOENT … <entry>/package.json` and exits 254 — npx never
//! repairs the entry, so each retry fails identically, and the spawn surfaces
//! as an opaque `initialize timed out` / `Incoming transport closed`.
//!
//! [`heal_npx_cache`] detects exactly that signature in a recorded spawn
//! failure, removes the named cache entry, and returns the removed path so
//! the caller can retry the spawn once. A broken spec other than the cache
//! entry produces the same ENOENT text *without* a `…/_npx/` directory, so
//! it does not match and is reported as before.
//!
//! Removing the entry is safe: npm treats it as absent, re-resolves the spec
//! against the registry, and rebuilds the entry (verified in the issue).
//! Removal is bounded to `<cache_root>/_npx/<8-64 hex>/` shaped paths so a
//! hostile or corrupted error string can never steer the deletion at an
//! unrelated directory.
use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;

/// The error signature: npm's ENOENT report naming the missing file. The
/// `npm error` prefix keeps this from matching a generic filesystem ENOENT
const NEEDLE: &str = "npm error code enoent";

static NPX_ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[/\\]_npx[/\\][0-9a-fA-F]{8,64}$").expect("valid npx-entry pattern")
});

/// Whether the failure text carries npm's broken-cache-entry signature.
pub(super) fn is_broken_npx_cache_failure(failure: &str) -> bool {
    if !failure.to_ascii_lowercase().contains(NEEDLE) {
        return false;
    }
    extract_npx_entry(failure).is_some()
}

/// Extract the npx cache entry npm named in the failure, or `None` when the
/// named path is not an `…/_npx/<hash>` entry.
fn extract_npx_entry(failure: &str) -> Option<PathBuf> {
    for line in failure.lines() {
        let line = line.trim();
        // npm prints the named path after `npm error path` / `npm error enoent`
        // on its own line (possibly with trailing detail after a colon).
        let Some(candidate) = line
            .rsplit_once("path ")
            .map(|(_, rest)| rest)
            .or_else(|| line.rsplit_once("path: ").map(|(_, rest)| rest))
        else {
            continue;
        };
        let path_text = split_trailing_detail(candidate).trim().trim_matches('"');
        if path_text.contains("_npx") && NPX_ENTRY.is_match(path_text) {
            return Some(PathBuf::from(path_text));
        }
    }
    None
}

/// Drop npm's trailing detail after the named path, keeping a Windows drive
/// prefix (`C:/Users/…`) intact.
fn split_trailing_detail(candidate: &str) -> &str {
    candidate
        .split_once(':')
        .filter(|(prefix, _)| {
            // A single ASCII letter before the colon is a drive letter, not a
            // detail separator; anything longer is npm's `path: detail`.
            prefix.len() != 1 || !prefix.chars().next().is_some_and(char::is_ascii_alphabetic)
        })
        .map_or(candidate, |(path, _)| path)
}

/// The npm cache root: `$npm_config_cache`, else `~/.npm`.
fn npm_cache_root() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("npm_config_cache") {
        return Some(PathBuf::from(configured));
    }
    home_dir().map(|home| home.join(".npm"))
}

/// `$HOME` (`$USERPROFILE` on Windows), or `None` when neither is set.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Remove a broken npx cache entry so the next launch rebuilds it.
///
/// The entry is removed only when it sits under the npm cache root and the
/// directory itself has no `package.json` (the broken shape). `None` means
/// nothing was removed. The caller retries the spawn exactly once either way;
/// a removal failure leaves the original error report intact.
pub(super) fn heal_npx_cache(failure: &str) -> Option<PathBuf> {
    let entry = extract_npx_entry(failure)?;
    let root = npm_cache_root()?;
    if !entry.starts_with(root) {
        return None;
    }
    if entry.join("package.json").is_file() {
        // The entry is populated and healthy; the ENOENT names something
        // else. Removing a healthy entry would only add an install cost.
        return None;
    }
    match std::fs::remove_dir_all(&entry) {
        Ok(()) => {
            log::warn!(
                "[acp] npx cache entry was broken (missing package.json); removed for one self-heal retry: {}",
                entry.display()
            );
            Some(entry)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            log::warn!(
                "[acp] failed to remove the broken npx cache entry {}: {error}",
                entry.display()
            );
            None
        }
    }
}

/// Whether the config launches through npx, so the spawn path only consults
/// the npx self-heal for agents npm bootstraps. Windows resolves npx to its
/// `.cmd`/`.bat` shim (`npx.cmd`), so those count too.
pub(super) fn launches_via_npx(config: &crate::acp::config::AgentConfig) -> bool {
    let command = config.command.trim();
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    base.eq_ignore_ascii_case("npx")
        || base.eq_ignore_ascii_case("npx.cmd")
        || base.eq_ignore_ascii_case("npx.bat")
}

#[cfg(test)]
mod tests;
