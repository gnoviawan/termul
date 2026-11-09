//! Environment variables under the Troupe name with the old product name as a
//! fallback. `TROUPE_<suffix>` wins; `TERMUL_<suffix>` still works and logs
//! one deprecation line per variable per process. Values are never logged.

use std::collections::BTreeSet;
use std::sync::Mutex;

pub const PREFIX: &str = "TROUPE_";
pub const LEGACY_PREFIX: &str = "TERMUL_";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvValue {
    /// The variable that supplied `value`, for error messages.
    pub name: String,
    pub value: String,
}

/// Deprecation lines owed for legacy names read so far. Lines queue until a
/// logger exists: `termul-server` parses its config before it starts tracing.
#[derive(Debug, Default)]
pub(crate) struct Notices {
    reported: BTreeSet<String>,
    pending: Vec<String>,
}

static NOTICES: Mutex<Notices> = Mutex::new(Notices {
    reported: BTreeSet::new(),
    pending: Vec::new(),
});

/// Both names of a variable Troupe sets for a child process, new name first.
#[must_use]
pub fn names(suffix: &str) -> [String; 2] {
    [
        format!("{PREFIX}{suffix}"),
        format!("{LEGACY_PREFIX}{suffix}"),
    ]
}

/// `TROUPE_<suffix>`, else `TERMUL_<suffix>`. A blank `TROUPE_` value does
/// not hide a non-blank `TERMUL_` one, so an empty placeholder in a compose
/// file or unit cannot clear an existing setting.
pub(crate) fn lookup(suffix: &str, read: impl Fn(&str) -> Option<String>) -> Option<EnvValue> {
    let [name, legacy_name] = names(suffix);
    let current = read(&name).map(|value| EnvValue { name, value });
    match current {
        Some(found) if !found.value.trim().is_empty() => Some(found),
        current => match read(&legacy_name) {
            Some(value) if current.is_none() || !value.trim().is_empty() => Some(EnvValue {
                name: legacy_name,
                value,
            }),
            _ => current,
        },
    }
}

/// [`lookup`], queueing a deprecation line the first time a legacy name
/// supplies the value.
pub(crate) fn lookup_noting(
    suffix: &str,
    read: impl Fn(&str) -> Option<String>,
    notices: &mut Notices,
) -> Option<EnvValue> {
    let found = lookup(suffix, read)?;
    if found.name.starts_with(LEGACY_PREFIX) && notices.reported.insert(found.name.clone()) {
        notices.pending.push(format!(
            "{} is deprecated; rename it to {PREFIX}{suffix} ({} still works for now)",
            found.name, found.name
        ));
    }
    Some(found)
}

impl Notices {
    pub(crate) fn take_pending(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending)
    }
}

/// Process-environment read of `TROUPE_<suffix>` then `TERMUL_<suffix>`.
/// Non-UTF-8 values count as unset, as `std::env::var(..).ok()` did.
#[must_use]
pub fn var(suffix: &str) -> Option<EnvValue> {
    let mut notices = NOTICES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let found = lookup_noting(suffix, |name| std::env::var(name).ok(), &mut notices);
    if log::max_level() != log::LevelFilter::Off {
        emit(notices.take_pending());
    }
    found
}

/// `var(suffix)`'s value alone.
#[must_use]
pub fn value(suffix: &str) -> Option<String> {
    var(suffix).map(|found| found.value)
}

/// Log deprecation lines queued before a logger existed. Call once the
/// process logger is installed.
pub fn flush_deprecations() {
    let pending = NOTICES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take_pending();
    emit(pending);
}

fn emit(lines: Vec<String>) {
    for line in lines {
        log::warn!("{line}");
    }
}

#[cfg(test)]
#[path = "brand_env_tests.rs"]
mod tests;
