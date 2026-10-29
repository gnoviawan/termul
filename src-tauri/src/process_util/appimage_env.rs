//! Child-environment hygiene for Linux AppImage builds.
//!
//! The AppImage runtime (`AppRun`) exports a batch of variables before our app
//! starts so the bundled Qt/GTK/WebKit libraries resolve against the libraries
//! packed inside the mount: `LD_LIBRARY_PATH` is prepended with `$APPDIR/usr/lib…`,
//! `APPDIR`/`APPIMAGE`/`ARGV0`/`OWD` are set, sometimes `LD_PRELOAD` too, and
//! `PATH`/`XDG_DATA_DIRS`/`PYTHONPATH`/`PERLLIB` gain entries under `$APPDIR`.
//!
//! Every host tool we spawn (node/npx ACP agents, git, xdg-open, a system `rg`)
//! inherits those and then resolves *host* binaries against the *bundled*
//! libraries, e.g. `libffi.so.8: LIBFFI_CALL_PLAN_8.4 not found` from
//! `/tmp/.mount_*/usr/lib`. The fix is to scrub the AppImage-specific entries
//! from each **child `Command`'s** environment — never the process-wide
//! environment, because WebKitGTK spawns its own helper processes that still
//! need the AppImage `LD_LIBRARY_PATH`, and the installer wrapper from #1497
//! (which exports `LD_PRELOAD=<host libwayland-client>` for the app/WebKit) must
//! keep working.
//!
//! [`plan_appimage_env_cleanup`] is a pure function over an env snapshot so it
//! can be unit-tested without touching the real process env; [`clean_appimage_env`]
//! reads the real env, plans, and applies the edits to a `Command`. Both are
//! no-ops unless both `APPDIR` and `APPIMAGE` are set and non-empty (the
//! AppImage gate), so non-AppImage behaviour — including on macOS and Windows —
//! is byte-for-byte unchanged.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Variables whose colon list is filtered to drop entries under `$APPDIR` while
/// keeping the host's own entries in order. `remove_when_empty` controls what
/// happens when filtering removes every entry: `true` emits a [`EnvEdit::Remove`],
/// `false` (PATH) leaves the variable untouched so we never hand a child an
/// empty `PATH`.
const FILTERED_PATH_VARS: &[(&str, bool)] = &[
    ("PATH", false),
    ("XDG_DATA_DIRS", true),
    ("PYTHONPATH", true),
    ("PERLLIB", true),
];

/// Variables that are always removed from the child when the gate is open (they
/// only describe the AppImage mount and mean nothing to a host tool).
const REMOVED_VARS: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/// One edit to apply to a child `Command`'s environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EnvEdit {
    /// Overwrite the variable with this value.
    Set(OsString),
    /// Remove the variable from the child's environment.
    Remove,
}

/// Plan the AppImage env cleanup for a child process given an env snapshot.
///
/// `get` resolves a variable name to its value (as [`clean_appimage_env`] wires
/// to [`std::env::var_os`]); tests pass a `HashMap`-backed closure. Returns the
/// edits to apply, in a deterministic order, or an empty `Vec` when the gate is
/// closed (both `APPDIR` and `APPIMAGE` must be present and non-empty).
///
/// Values are handled as [`OsString`]/[`Path`] throughout, so non-UTF-8 values
/// never panic. Colon lists are split/rejoined with [`std::env::split_paths`] /
/// [`std::env::join_paths`]; entries are matched against `$APPDIR` with
/// [`Path::starts_with`], which is component-wise, so `/tmp/.mount_abc` does not
/// match `/tmp/.mount_abcd/…`.
pub(crate) fn plan_appimage_env_cleanup(
    get: impl Fn(&str) -> Option<OsString>,
) -> Vec<(String, EnvEdit)> {
    let non_empty = |name: &str| get(name).filter(|v| !v.is_empty());

    // The AppImage gate: both must be present and non-empty, else no edits.
    let (Some(appdir), Some(_appimage)) = (non_empty("APPDIR"), non_empty("APPIMAGE")) else {
        return Vec::new();
    };
    let appdir = PathBuf::from(appdir);

    let mut edits: Vec<(String, EnvEdit)> = Vec::new();

    // LD_LIBRARY_PATH: restore the saved host original when a wrapper stashed
    // one, otherwise drop the `$APPDIR` entries and keep the host's own.
    plan_loader_var(&get, &appdir, "LD_LIBRARY_PATH", true, &mut edits);

    // LD_PRELOAD: the issue's acceptance criteria require children not to
    // inherit the AppImage LD_PRELOAD. The #1497 installer wrapper sets
    // LD_PRELOAD to a host `libwayland-client.so.0` purely for the app's own
    // WebKit rendering — it is meaningless for rg/node/git/xdg-open — so for
    // children we restore `LD_PRELOAD_ORIG` when present and otherwise drop
    // LD_PRELOAD entirely rather than filtering it.
    plan_loader_var(&get, &appdir, "LD_PRELOAD", false, &mut edits);

    // Colon-list vars: drop only the `$APPDIR` entries, keep the rest in order.
    for &(name, remove_when_empty) in FILTERED_PATH_VARS {
        if let Some(value) = get(name) {
            if let Some(edit) = plan_filtered_path(&value, &appdir, remove_when_empty) {
                edits.push((name.to_string(), edit));
            }
        }
    }

    // PYTHONHOME is removed only when it points under `$APPDIR` (a host
    // PYTHONHOME must survive).
    if let Some(value) = get("PYTHONHOME") {
        if Path::new(&value).starts_with(&appdir) {
            edits.push(("PYTHONHOME".to_string(), EnvEdit::Remove));
        }
    }

    // Pure-marker vars: always removed when present.
    for &name in REMOVED_VARS {
        if get(name).is_some() {
            edits.push((name.to_string(), EnvEdit::Remove));
        }
    }

    edits
}

/// Plan `LD_LIBRARY_PATH` / `LD_PRELOAD`. When `<VAR>_ORIG` is present (some
/// runtimes/wrappers stash the original host value there), restore it: a
/// non-empty value becomes [`EnvEdit::Set`], an empty value becomes
/// [`EnvEdit::Remove`]. Otherwise, `filter` controls the fallback:
/// `true` filters the list against `$APPDIR` (LD_LIBRARY_PATH), `false` removes
/// the variable outright when it is set (LD_PRELOAD).
fn plan_loader_var(
    get: &impl Fn(&str) -> Option<OsString>,
    appdir: &Path,
    name: &str,
    filter: bool,
    edits: &mut Vec<(String, EnvEdit)>,
) {
    if let Some(orig) = get(&format!("{name}_ORIG")) {
        let edit = if orig.is_empty() {
            EnvEdit::Remove
        } else {
            EnvEdit::Set(orig)
        };
        edits.push((name.to_string(), edit));
        return;
    }

    let Some(value) = get(name) else {
        return;
    };

    if filter {
        if let Some(edit) = plan_filtered_path(&value, appdir, true) {
            edits.push((name.to_string(), edit));
        }
    } else {
        edits.push((name.to_string(), EnvEdit::Remove));
    }
}

/// Filter a colon-separated list, dropping entries equal to or under `$APPDIR`.
/// Returns `None` when nothing was dropped (leave the variable untouched).
/// When every entry is dropped, `remove_when_empty` chooses between
/// [`EnvEdit::Remove`] and leaving it untouched (used for `PATH`, which must
/// never be emptied).
fn plan_filtered_path(value: &OsStr, appdir: &Path, remove_when_empty: bool) -> Option<EnvEdit> {
    let entries: Vec<PathBuf> = std::env::split_paths(value).collect();
    let kept: Vec<PathBuf> = entries
        .iter()
        .filter(|entry| !entry.starts_with(appdir))
        .cloned()
        .collect();

    if kept.len() == entries.len() {
        // Nothing under `$APPDIR` — do not touch the variable.
        return None;
    }

    if kept.is_empty() {
        return remove_when_empty.then_some(EnvEdit::Remove);
    }

    // `join_paths` only fails if an entry contains the separator, which cannot
    // happen for entries produced by `split_paths`; treat a failure as "leave
    // untouched" out of caution.
    std::env::join_paths(kept).ok().map(EnvEdit::Set)
}

/// A command builder whose child environment can be scrubbed of AppImage-only
/// variables. Mirrors [`crate::process_util::ConsoleCommand`] so the single
/// hygiene helper works for both std and tokio commands.
pub(crate) trait AppImageEnvCommand {
    fn appimage_env_set(&mut self, key: &str, value: &OsStr) -> &mut Self;
    fn appimage_env_remove(&mut self, key: &str) -> &mut Self;
}

impl AppImageEnvCommand for std::process::Command {
    fn appimage_env_set(&mut self, key: &str, value: &OsStr) -> &mut Self {
        self.env(key, value)
    }

    fn appimage_env_remove(&mut self, key: &str) -> &mut Self {
        self.env_remove(key)
    }
}

impl AppImageEnvCommand for tokio::process::Command {
    fn appimage_env_set(&mut self, key: &str, value: &OsStr) -> &mut Self {
        self.env(key, value)
    }

    fn appimage_env_remove(&mut self, key: &str) -> &mut Self {
        self.env_remove(key)
    }
}

/// Scrub AppImage-only variables from a child `Command`'s environment.
///
/// On non-Linux targets this returns the command untouched. On Linux it reads
/// the real process env, plans with [`plan_appimage_env_cleanup`], and applies
/// the edits via [`AppImageEnvCommand`]. Call this **before** the caller's own
/// explicit `.env(…)` calls so those explicit values still win. Outside an
/// AppImage the plan is empty and the command is untouched.
pub(crate) fn clean_appimage_env<C: AppImageEnvCommand + ?Sized>(command: &mut C) -> &mut C {
    // The AppImage runtime only exists on Linux. On macOS/Windows `APPDIR` and
    // `APPIMAGE` could still be set for unrelated reasons, so refuse to touch a
    // child's env there — keeping non-Linux behaviour byte-for-byte unchanged.
    if !cfg!(target_os = "linux") {
        return command;
    }
    clean_appimage_env_with(command, |name| std::env::var_os(name))
}

/// Plan and apply the AppImage env cleanup against a caller-supplied env getter.
///
/// [`clean_appimage_env`] wraps this with [`std::env::var_os`] after the Linux
/// gate; tests drive it with a `HashMap`-backed getter so the real process env
/// is never mutated. Emits one `debug` line naming the edited variables (never
/// their values) when edits are applied.
pub(crate) fn clean_appimage_env_with<C: AppImageEnvCommand + ?Sized>(
    command: &mut C,
    get: impl Fn(&str) -> Option<OsString>,
) -> &mut C {
    let edits = plan_appimage_env_cleanup(get);
    if edits.is_empty() {
        return command;
    }

    let names = apply_edits(command, &edits);
    log::debug!(
        "[process_util] AppImage child-env hygiene edited: {}",
        names.join(", ")
    );
    command
}

/// Apply a planned set of edits to `command`, returning the edited variable
/// names (for logging). Split out so tests can drive it with a crafted plan.
pub(crate) fn apply_edits<'a, C: AppImageEnvCommand + ?Sized>(
    command: &mut C,
    edits: &'a [(String, EnvEdit)],
) -> Vec<&'a str> {
    let mut names: Vec<&str> = Vec::with_capacity(edits.len());
    for (name, edit) in edits {
        match edit {
            EnvEdit::Set(value) => {
                command.appimage_env_set(name, value);
            }
            EnvEdit::Remove => {
                command.appimage_env_remove(name);
            }
        }
        names.push(name.as_str());
    }
    names
}
