//! Links from an Account config directory back to the shared Claude config
//! directory (ADR-0004). The login and `.claude.json` stay per Account; the
//! entries below are shared so history, settings, and skills are the same on
//! every Account.

use std::fs;
use std::io;
use std::path::Path;

/// Shared directories. A missing one is created in the shared directory first,
/// so an Account never grows a private copy that diverges from the others.
pub const SHARED_DIRS: &[&str] = &[
    "projects",
    "skills",
    "plugins",
    "rules",
    "plans",
    "file-history",
    "agents",
    "commands",
];

/// Shared files. A missing one is skipped: a link to a missing target would
/// make the Account write a file that the shared directory does not have.
pub const SHARED_FILES: &[&str] = &["settings.json", "CLAUDE.md"];

/// Link every shared entry of `shared` into `account`. Existing correct links
/// are kept, wrong links are replaced, and real files or directories that
/// Claude Code already wrote in `account` are left alone (never deleted).
/// Returns the number of entries that could not be linked.
pub fn ensure_links(shared: &Path, account: &Path) -> io::Result<usize> {
    fs::create_dir_all(account)?;
    let mut failed = 0;
    for name in SHARED_DIRS {
        let target = shared.join(name);
        if let Err(error) = fs::create_dir_all(&target) {
            log::warn!(
                "[claude-accounts] could not create shared dir {name}: {:?}",
                error.kind()
            );
            failed += 1;
            continue;
        }
        if !link_entry(&target, &account.join(name), name, true) {
            failed += 1;
        }
    }
    for name in SHARED_FILES {
        let target = shared.join(name);
        if !target.is_file() {
            continue;
        }
        if !link_entry(&target, &account.join(name), name, false) {
            failed += 1;
        }
    }
    Ok(failed)
}

/// Remove the shared-entry links from `account`, never their targets.
pub fn remove_links(account: &Path) {
    let entries = SHARED_DIRS
        .iter()
        .map(|name| (*name, true))
        .chain(SHARED_FILES.iter().map(|name| (*name, false)));
    for (name, is_dir) in entries {
        let link = account.join(name);
        let is_link = fs::symlink_metadata(&link).is_ok_and(|meta| meta.file_type().is_symlink());
        if is_link {
            if let Err(error) = remove_link(&link, is_dir) {
                log::warn!(
                    "[claude-accounts] could not remove shared entry {name}: {:?}",
                    error.kind()
                );
            }
        }
    }
}

fn link_entry(target: &Path, link: &Path, name: &str, is_dir: bool) -> bool {
    match fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if fs::read_link(link).is_ok_and(|current| current == target) {
                return true;
            }
            if let Err(error) = remove_link(link, is_dir) {
                log::warn!(
                    "[claude-accounts] could not replace shared entry {name}: {:?}",
                    error.kind()
                );
                return false;
            }
        }
        Ok(_) => {
            log::warn!("[claude-accounts] shared entry {name} is a real file; leaving it");
            return false;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            log::warn!(
                "[claude-accounts] could not read shared entry {name}: {:?}",
                error.kind()
            );
            return false;
        }
    }
    match create_link(target, link, is_dir) {
        Ok(()) => true,
        Err(error) => {
            log::warn!(
                "[claude-accounts] could not link shared entry {name}: {:?}",
                error.kind()
            );
            false
        }
    }
}

#[cfg(unix)]
fn create_link(target: &Path, link: &Path, _is_dir: bool) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_link(target: &Path, link: &Path, is_dir: bool) -> io::Result<()> {
    if is_dir {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

#[cfg(unix)]
fn remove_link(link: &Path, _is_dir: bool) -> io::Result<()> {
    fs::remove_file(link)
}

#[cfg(windows)]
fn remove_link(link: &Path, is_dir: bool) -> io::Result<()> {
    if is_dir {
        fs::remove_dir(link)
    } else {
        fs::remove_file(link)
    }
}
