//! Shell integration planning and atomic command configuration.

use super::gate::CompletionProvider;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    Zsh,
}

#[derive(Debug)]
pub enum InjectionPlan {
    Raw,
    Inject(Injection),
}

#[derive(Debug)]
pub struct Injection {
    pub shell: ShellKind,
    pub session_id: String,
    pub nonce: String,
    /// In-band completion prefixes for T12 to register; planning does not touch the gate.
    /// Bytes: ESC 0 D i Ctrl-U (1b 30 44 69 15), then `__termul_complete `,
    /// including the trailing space. The trigger enters insertion mode and clears the draft.
    /// Live shell tests prove history, user status, and prompt restoration for both wrappers.
    pub providers: Vec<CompletionProvider>,
}

impl Injection {
    pub fn script(&self) -> &'static str {
        match self.shell {
            ShellKind::Bash => include_str!("../../../resources/shell-integration/bash.sh"),
            ShellKind::Zsh => include_str!("../../../resources/shell-integration/zsh.sh"),
        }
    }
}

pub fn injection_plan(shell_path: &str, program: Option<&str>) -> InjectionPlan {
    if program.is_some() || crate::pty::env_refresh::shell_wants_login_arg(shell_path) != Some("-l")
    {
        return InjectionPlan::Raw;
    }
    let shell = match std::path::Path::new(shell_path)
        .file_name()
        .and_then(|s| s.to_str())
    {
        Some("bash") => ShellKind::Bash,
        Some("zsh") => ShellKind::Zsh,
        _ => return InjectionPlan::Raw,
    };
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        log::warn!("Session integration planning failed: entropy unavailable");
        return InjectionPlan::Raw;
    }
    InjectionPlan::Inject(Injection {
        shell,
        providers: vec![CompletionProvider {
            id: match shell {
                ShellKind::Bash => "bash",
                ShellKind::Zsh => "zsh",
            }
            .to_string(),
            command: b"\x1b0Di\x15__termul_complete ".to_vec(),
            restorable: true,
        }],
        session_id: uuid::Uuid::new_v4().to_string(),
        nonce: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
    })
}

/// Write an isolated startup directory before changing any command arguments or environment.
#[cfg(not(target_os = "windows"))]
pub fn install(
    plan: &InjectionPlan,
    base: &std::path::Path,
    env: &std::collections::HashMap<String, String>,
    command: &mut portable_pty::CommandBuilder,
) -> std::io::Result<()> {
    use std::fs;
    use std::os::unix::fs::DirBuilderExt;

    let InjectionPlan::Inject(injection) = plan else {
        return Ok(());
    };
    let directory = base.join(format!("termul-shell-{}", injection.session_id));
    fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let user_dir = env.get("ZDOTDIR").or_else(|| env.get("HOME"));
    let result = (|| {
        let script = write_script(injection, &directory)?;
        if injection.shell == ShellKind::Zsh {
            write_zsh_shims(&directory, &script, user_dir)?;
        }
        Ok(script)
    })();
    let script = match result {
        Ok(script) => script,
        Err(error) => {
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
    };
    configure_command(injection, &directory, &script, user_dir, command);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn write_script(
    injection: &Injection,
    directory: &std::path::Path,
) -> std::io::Result<std::path::PathBuf> {
    let script = directory.join(match injection.shell {
        ShellKind::Bash => "bash.sh",
        ShellKind::Zsh => "zsh.sh",
    });
    std::fs::write(&script, injection.script())?;
    Ok(script)
}

#[cfg(not(target_os = "windows"))]
fn quote_path(path: &std::path::Path) -> std::io::Result<String> {
    let path = path.to_str().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "non-UTF-8 startup directory",
        )
    })?;
    Ok(format!("'{}'", path.replace('\'', "'\\''")))
}

#[cfg(not(target_os = "windows"))]
fn write_zsh_shims(
    directory: &std::path::Path,
    script: &std::path::Path,
    user_dir: Option<&String>,
) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    user_dir.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "missing startup directory",
        )
    })?;
    let shim_dir = directory.join("zsh");
    std::fs::DirBuilder::new().mode(0o700).create(&shim_dir)?;
    let shim_path = quote_path(&shim_dir)?;
    let script_path = quote_path(script)?;
    let directory_path = quote_path(directory)?;
    for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
        let mut shim = String::from("# Original Termul login startup shim.\n");
        if name == ".zshenv" {
            shim.push_str("typeset +x __termul_session_id __termul_nonce __termul_user_zdotdir\n__termul_session_id=${TERMUL_SESSION_ID-}\n__termul_nonce=${TERMUL_SESSION_NONCE-}\n__termul_user_zdotdir=${TERMUL_USER_ZDOTDIR-}\nunset TERMUL_SESSION_ID TERMUL_SESSION_NONCE TERMUL_USER_ZDOTDIR\n");
        }
        shim.push_str(&format!(
        "ZDOTDIR=$__termul_user_zdotdir\nif [[ -r \"$ZDOTDIR/{name}\" ]]; then\n    source \"$ZDOTDIR/{name}\"\nfi\n__termul_user_zdotdir=${{ZDOTDIR:-$HOME}}\n"
    ));
        if name == ".zlogin" {
            shim.push_str(&format!(
                "ZDOTDIR=$__termul_user_zdotdir\n__termul_startup_session_id=$__termul_session_id\nsource {script_path}\n\
                 __termul_startup_directory={directory_path}\n\
                 if [[ ${{__termul_startup_directory:t}} = termul-shell-$__termul_startup_session_id ]]; then\n\
                     command rm -rf -- \"$__termul_startup_directory\"\n\
                 fi\nunset __termul_startup_directory __termul_startup_session_id __termul_user_zdotdir\n"
            ));
        } else {
            shim.push_str(&format!("ZDOTDIR={shim_path}\n"));
        }
        std::fs::write(shim_dir.join(name), shim)?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn configure_command(
    injection: &Injection,
    directory: &std::path::Path,
    script: &std::path::Path,
    user_dir: Option<&String>,
    command: &mut portable_pty::CommandBuilder,
) {
    match injection.shell {
        ShellKind::Bash => {
            command.arg("--init-file");
            command.arg(script);
            command.arg("-i");
        }
        ShellKind::Zsh => {
            command.arg("-l");
            command.env("ZDOTDIR", directory.join("zsh"));
            command.env("TERMUL_USER_ZDOTDIR", user_dir.unwrap());
        }
    }
    command.env("TERMUL_SESSION_ID", &injection.session_id);
    command.env("TERMUL_SESSION_NONCE", &injection.nonce);
}

/// Keep the existing login arguments whenever planning or installation stays raw.
#[cfg(not(target_os = "windows"))]
pub fn configure_launch(
    shell_path: &str,
    program: Option<&str>,
    env: &std::collections::HashMap<String, String>,
    command: &mut portable_pty::CommandBuilder,
) -> InjectionPlan {
    let plan = injection_plan(shell_path, program);
    if matches!(plan, InjectionPlan::Inject(_)) {
        match install(&plan, &std::env::temp_dir(), env, command) {
            Ok(()) => {
                log::debug!("Session integration installed for local login shell");
                return plan;
            }
            Err(error) => log::warn!(
                "Session integration installation failed: {:?}",
                error.kind()
            ),
        }
    }
    if program.is_none() {
        if let Some(login_arg) = crate::pty::env_refresh::shell_wants_login_arg(shell_path) {
            command.arg(login_arg);
        }
    }
    InjectionPlan::Raw
}
