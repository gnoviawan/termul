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
            if link_points_to(link, target) {
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
        Ok(meta) => return migrate_or_leave(target, link, name, is_dir, &meta),
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

/// Whether the existing link at `link` already resolves to `target`.
#[cfg(unix)]
fn link_points_to(link: &Path, target: &Path) -> bool {
    fs::read_link(link).is_ok_and(|current| current == target)
}

/// Whether the existing link at `link` already resolves to `target`. A Windows
/// directory link is a junction whose stored target is an `\??\`-prefixed NT
/// path, so compare canonical paths instead of the raw reparse target.
#[cfg(windows)]
fn link_points_to(link: &Path, target: &Path) -> bool {
    match (fs::canonicalize(link), fs::canonicalize(target)) {
        (Ok(resolved_link), Ok(resolved_target)) => resolved_link == resolved_target,
        _ => false,
    }
}

/// A real file or directory Claude Code already wrote where a link belongs.
///
/// On Unix the entry is always left alone (the `symlink` path never fails, so a
/// real entry is user data we must not touch). On Windows a privately created
/// shared *directory* means an earlier `symlink_dir` failed for lack of the
/// symlink privilege, so its contents are merged into the shared directory and
/// it is replaced with a privilege-free junction. Returns `true` only when the
/// entry ends up linked.
#[cfg(unix)]
fn migrate_or_leave(
    _target: &Path,
    _link: &Path,
    name: &str,
    _is_dir: bool,
    _meta: &fs::Metadata,
) -> bool {
    log::warn!("[claude-accounts] shared entry {name} is a real file; leaving it");
    false
}

#[cfg(windows)]
fn migrate_or_leave(
    target: &Path,
    link: &Path,
    name: &str,
    is_dir: bool,
    meta: &fs::Metadata,
) -> bool {
    if is_dir && meta.is_dir() {
        return migrate_dir_to_link(target, link, name);
    }
    log::warn!("[claude-accounts] shared entry {name} is a real file; leaving it");
    false
}

/// Merge a private shared directory into the shared one, then replace it with a
/// junction. The private copy is removed only after every file is merged, so a
/// failure leaves the unmerged data in place.
#[cfg(windows)]
fn migrate_dir_to_link(target: &Path, link: &Path, name: &str) -> bool {
    log::info!("[claude-accounts] migrating private {name} into the shared directory");
    if let Err(error) = merge_dir(link, target) {
        log::warn!(
            "[claude-accounts] could not merge private {name} into the shared dir ({:?}); leaving it",
            error.kind()
        );
        return false;
    }
    if let Err(error) = fs::remove_dir_all(link) {
        log::warn!(
            "[claude-accounts] merged private {name} but could not remove it to link ({:?}); leaving it",
            error.kind()
        );
        return false;
    }
    match create_link(target, link, true) {
        Ok(()) => {
            log::info!("[claude-accounts] migrated private {name} to a shared junction");
            true
        }
        Err(error) => {
            log::warn!(
                "[claude-accounts] could not link {name} after migrating its contents: {:?}",
                error.kind()
            );
            false
        }
    }
}

/// Copy every file under `src` into `dst`, keeping the relative layout and
/// never overwriting a name that already exists under `dst` (the shared copy
/// wins a conflict; a uniquely named private file is always preserved). On the
/// first I/O error, already-copied files stay and the error is returned so the
/// caller keeps the source rather than deleting unmerged data.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn merge_dir(src: &Path, dst: &Path) -> io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            fs::create_dir_all(&to)?;
            merge_dir(&from, &to)?;
        } else if !to.exists() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_link(target: &Path, link: &Path, _is_dir: bool) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_link(target: &Path, link: &Path, is_dir: bool) -> io::Result<()> {
    if is_dir {
        // A directory junction needs no symlink privilege, unlike `symlink_dir`.
        crate::junction::create_junction(target, link).map_err(io::Error::other)
    } else {
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => Ok(()),
            // A file symlink needs Developer Mode or elevation. Without it, copy
            // the shared file so the Account still has its contents; the copy
            // will not track later shared edits, which we accept over failing.
            Err(error) => {
                log::warn!(
                    "[claude-accounts] symlink for {} failed ({:?}); copying the shared file instead",
                    link.display(),
                    error.kind()
                );
                fs::copy(target, link).map(|_| ())
            }
        }
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
