//! Undo the Linux installer launcher's `LD_PRELOAD` for terminal children.
//!
//! `scripts/install.sh` installs a `termul-manager` launcher in front of the
//! AppImage. On Wayland it appends the host `libwayland-client.so.0` to
//! `LD_PRELOAD` so WebKitGTK can create an EGL display with Mesa 25 or later
//! (#1682), and records the entry it appended in [`LAUNCHER_PRELOAD_VAR`].
//! The app and its WebKit helpers need that preload. A user's shell does not,
//! so the terminal environment drops exactly that entry and keeps any
//! `LD_PRELOAD` the user had set before launching.

#[cfg(not(target_os = "windows"))]
use std::collections::HashMap;

/// Set by the installer launcher to the entry it appended to `LD_PRELOAD`.
pub(crate) const LAUNCHER_PRELOAD_VAR: &str = "TERMUL_LAUNCHER_PRELOAD";

#[cfg(not(target_os = "windows"))]
const LD_PRELOAD: &str = "LD_PRELOAD";

/// Remove the launcher's `LD_PRELOAD` entry and its marker from `env`.
///
/// The launcher writes either `<entry>` (no user value) or
/// `<user value>:<entry>`. Any other shape means something rewrote
/// `LD_PRELOAD` after the launcher, so it is left as is rather than guessing
/// which part is the user's.
#[cfg(not(target_os = "windows"))]
pub(crate) fn remove_launcher_preload(env: &mut HashMap<String, String>) {
    let Some(added) = env.remove(LAUNCHER_PRELOAD_VAR) else {
        return;
    };
    let Some(preload) = env.get(LD_PRELOAD) else {
        return;
    };

    if *preload == added {
        env.remove(LD_PRELOAD);
    } else if let Some(user) = preload
        .strip_suffix(added.as_str())
        .and_then(|rest| rest.strip_suffix(':'))
    {
        let user = user.to_string();
        env.insert(LD_PRELOAD.to_string(), user);
    } else {
        log::warn!(
            "[process_util] LD_PRELOAD no longer ends with the launcher's entry; leaving it unchanged for the terminal"
        );
    }
}
