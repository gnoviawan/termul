#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;

/// Windows flag to suppress the transient console window that would otherwise
/// flash for every short-lived helper process (git.exe, where.exe, cmd.exe).
/// Without this, GUI/release builds pop a console window on each invocation
/// — highly visible when worktree status polling runs `git status` every 2s.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Build a helper command that does not spawn a visible console window.
/// On Windows this applies the `CREATE_NO_WINDOW` creation flag; on other
/// platforms it is a plain `Command::new`.
pub(super) fn quiet_command(program: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(program)
    }
}

/// Directories that should never be symlinked into worktrees.
const SYMLINK_EXCLUSION_LIST: &[&str] = &[
    ".git",
    ".termul",
    ".worktrees",
    ".claude",
    ".codex",
    ".opencode",
    ".pi",
    ".pi-lens",
    ".agents",
    ".auto-claude",
    ".vscode",
    ".idea",
    "_bmad",
    "_bmad-output",
    "_bmad-bkp",
];

/// Check if a directory name is in the hardcoded exclusion list.
pub(super) fn is_excluded_dir(dir_name: &str) -> bool {
    SYMLINK_EXCLUSION_LIST.iter().any(|excluded| {
        dir_name == *excluded || dir_name.starts_with(&format!("{}{}", *excluded, "/"))
    })
}
