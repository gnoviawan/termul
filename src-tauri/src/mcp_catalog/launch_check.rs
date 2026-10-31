//! Launch rules for an imported stdio command (AD-5: the AD-4 deny-list,
//! package grammar and cmd metacharacter rules apply to imports). An import
//! may name any executable, but a runner (`npx`, `uvx`, `docker`, `dotnet`)
//! must take the AD-4 template's shape, and an `env` wrapper is read through
//! so neither it nor the command it wraps can smuggle a denied variable.

use std::sync::LazyLock;

use regex::Regex;

use super::consent::escape_for_display;
use super::convert::{
    check_env_name, check_package_spec, has_cmd_metacharacter, is_denied_env_name,
    is_valid_identifier, McpCatalogReason, Runner,
};

fn command_base(command: &str) -> String {
    let base = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase();
    [".exe", ".cmd", ".bat"]
        .iter()
        .find_map(|ext| base.strip_suffix(ext))
        .map_or_else(|| base.clone(), str::to_string)
}

fn is_batch_file(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

fn runner_of(base: &str) -> Option<Runner> {
    match base {
        "npx" => Some(Runner::Npx),
        "uvx" => Some(Runner::Uvx),
        "docker" => Some(Runner::Docker),
        "dotnet" => Some(Runner::Dotnet),
        _ => None,
    }
}

fn unsupported(command: &str, argument: &str) -> McpCatalogReason {
    McpCatalogReason::UnsupportedLaunchArgument {
        command: command.to_string(),
        argument: escape_for_display(argument),
    }
}

/// `NAME=value` as a whole argument, or behind a flag (`-eNAME=value`,
/// `--env=NAME=value`, `--setenv=NAME=value`): how `env`, `sudo`, `docker`,
/// `systemd-run` and shells take an environment assignment.
fn denied_assignment(arg: &str) -> Option<String> {
    static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:-[A-Za-z]|-[^=]*=)?([A-Za-z_][A-Za-z0-9_]*)=").expect("assignment regex")
    });
    let name = &ASSIGNMENT.captures(arg)?[1];
    is_denied_env_name(name).then(|| name.to_string())
}

/// Reads `env [-i] [-u NAME]… [NAME=value]… command args…` and returns the
/// command it runs. Any other `env` option is refused rather than guessed at.
fn unwrap_env(args: &[String]) -> Result<(&str, &[String]), McpCatalogReason> {
    let mut rest = args;
    while let Some((arg, tail)) = rest.split_first() {
        match arg.as_str() {
            "-i" | "--ignore-environment" | "-" => rest = tail,
            "-u" | "--unset" => match tail.split_first() {
                Some((_, tail)) => rest = tail,
                None => return Err(unsupported("env", arg)),
            },
            "--" => {
                rest = tail;
                break;
            }
            _ if arg.starts_with("--unset=") => rest = tail,
            _ if arg.starts_with('-') => return Err(unsupported("env", arg)),
            _ => break,
        }
    }
    while let Some((arg, tail)) = rest.split_first() {
        let Some((name, _)) = arg.split_once('=') else {
            break;
        };
        check_env_name(name)?;
        rest = tail;
    }
    match rest.split_first() {
        Some((command, args)) if !command.starts_with('-') => Ok((command, args)),
        _ => Err(McpCatalogReason::InvalidCommand),
    }
}

/// The command an import really runs once `env` and `nohup` are read through.
fn unwrap<'a>(
    mut command: &'a str,
    mut args: &'a [String],
) -> Result<(&'a str, &'a [String]), McpCatalogReason> {
    loop {
        (command, args) = match command_base(command).as_str() {
            "env" => unwrap_env(args)?,
            "nohup" => match args.split_first() {
                Some((inner, rest)) if !inner.starts_with('-') => (inner.as_str(), rest),
                Some((flag, _)) => return Err(unsupported("nohup", flag)),
                None => return Err(McpCatalogReason::InvalidCommand),
            },
            _ => return Ok((command, args)),
        };
    }
}

/// Runner flags an import may pass before the package, each taking no value.
fn allowed_flag(runner: Runner, flag: &str) -> bool {
    match runner {
        Runner::Npx | Runner::Dotnet => matches!(flag, "-y" | "--yes"),
        Runner::Uvx | Runner::Docker => false,
    }
}

/// Flags, then exactly one grammar-checked package spec. Returns what follows
/// the spec.
fn take_package(runner: Runner, args: &[String]) -> Result<&[String], McpCatalogReason> {
    let mut rest = args;
    while let Some((arg, tail)) = rest.split_first() {
        if !arg.starts_with('-') {
            check_package_spec(runner, arg)?;
            return Ok(tail);
        }
        if !allowed_flag(runner, arg) {
            return Err(unsupported(runner.command(), arg));
        }
        rest = tail;
    }
    Err(McpCatalogReason::InvalidPackage)
}

/// `docker run [-i] [--rm] [-e NAME]… [-v SPEC]… <image> args…`. An `-e`
/// names a variable passed through from the entry's env, never a value.
fn check_docker(args: &[String]) -> Result<(), McpCatalogReason> {
    let Some((subcommand, mut rest)) = args.split_first() else {
        return Err(McpCatalogReason::InvalidPackage);
    };
    if subcommand != "run" {
        return Err(unsupported("docker", subcommand));
    }
    let env_name = |flag: &str, name: &str| -> Result<(), McpCatalogReason> {
        match name.split_once('=') {
            Some((name, _)) => {
                check_env_name(name)?;
                Err(unsupported("docker", &format!("{flag} {name}=…")))
            }
            None => check_env_name(name),
        }
    };
    while let Some((arg, tail)) = rest.split_first() {
        rest = tail;
        match arg.as_str() {
            "-i" | "--interactive" | "--rm" => {}
            "-e" | "--env" | "-v" | "--volume" => {
                let Some((value, tail)) = rest.split_first() else {
                    return Err(unsupported("docker", arg));
                };
                rest = tail;
                if matches!(arg.as_str(), "-e" | "--env") {
                    env_name(arg, value)?;
                }
            }
            _ if arg.starts_with("--env=") => env_name("--env", &arg["--env=".len()..])?,
            _ if arg.starts_with("--volume=") => {}
            _ if arg.starts_with('-') => return Err(unsupported("docker", arg)),
            image if is_valid_identifier(Runner::Docker, image) => return Ok(()),
            _ => return Err(McpCatalogReason::InvalidPackage),
        }
    }
    Err(McpCatalogReason::InvalidPackage)
}

/// `dotnet dnx [--yes] <id>[@<version>] [--yes] [-- args…]`, the AD-4 nuget
/// shape. `dnx` reads options and `@file` response files anywhere before `--`,
/// so every argument for the package must follow it.
fn check_dotnet(args: &[String]) -> Result<(), McpCatalogReason> {
    match args.split_first() {
        Some((subcommand, rest)) if subcommand == "dnx" => {
            let after = take_package(Runner::Dotnet, rest)?;
            match after
                .iter()
                .find(|arg| !allowed_flag(Runner::Dotnet, arg))
            {
                Some(arg) if arg != "--" => Err(unsupported("dotnet", arg)),
                _ => Ok(()),
            }
        }
        Some((subcommand, _)) => Err(unsupported("dotnet", subcommand)),
        None => Err(McpCatalogReason::InvalidPackage),
    }
}

/// `npx` and `uvx` hand everything after the package to the package itself.
fn check_runner(runner: Runner, args: &[String]) -> Result<(), McpCatalogReason> {
    match runner {
        Runner::Npx | Runner::Uvx => take_package(runner, args).map(drop),
        Runner::Docker => check_docker(args),
        Runner::Dotnet => check_dotnet(args),
    }
}

pub(crate) fn check_stdio_launch(command: &str, args: &[String]) -> Result<(), McpCatalogReason> {
    for arg in args {
        if let Some(name) = denied_assignment(arg) {
            return Err(McpCatalogReason::DeniedEnv { name });
        }
    }
    let (inner, inner_args) = unwrap(command, args)?;
    let runner = runner_of(&command_base(inner));
    if let Some(runner) = runner {
        check_runner(runner, inner_args)?;
    }
    if runner.is_some() || is_batch_file(inner) {
        if let Some(index) = args.iter().position(|arg| has_cmd_metacharacter(arg)) {
            return Err(McpCatalogReason::CmdMetacharacter {
                field: format!("args[{index}]"),
            });
        }
    }
    Ok(())
}

/// A short option cluster such as `-c` or `-lc` that includes one of `letters`.
fn short_flag(arg: &str, letters: &[char]) -> bool {
    arg.strip_prefix('-').is_some_and(|cluster| {
        !cluster.is_empty()
            && cluster.chars().all(|ch| ch.is_ascii_alphabetic())
            && cluster.chars().any(|ch| letters.contains(&ch))
    })
}

/// Whether the launch hands a shell or interpreter code inline (`sh -c`,
/// `node -e`, `python -c`, `deno eval`, `cmd /c`, any PowerShell), code the
/// consent view can show but the user is unlikely to read as a program.
pub(crate) fn runs_inline_code(command: &str, args: &[String]) -> bool {
    let Ok((inner, args)) = unwrap(command, args) else {
        return false;
    };
    let base = command_base(inner);
    let any = |test: &dyn Fn(&str) -> bool| args.iter().any(|arg| test(arg));
    match base.as_str() {
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "mksh" | "ash" | "fish" => any(&|arg| {
            short_flag(arg, &['c']) || arg == "--command" || arg.starts_with("--command=")
        }),
        "cmd" => any(&|arg| {
            let lower = arg.to_ascii_lowercase();
            lower.starts_with("/c") || lower.starts_with("/k") || lower.starts_with("/r")
        }),
        // Windows PowerShell reads bare arguments as `-Command`.
        "powershell" | "pwsh" => true,
        "node" | "nodejs" | "bun" => any(&|arg| {
            short_flag(arg, &['e', 'p'])
                || ["--eval", "--print"]
                    .iter()
                    .any(|flag| arg == *flag || arg.starts_with(&format!("{flag}=")))
        }),
        "deno" => args
            .iter()
            .find(|arg| !arg.starts_with('-'))
            .is_some_and(|arg| arg == "eval"),
        "perl" => any(&|arg| short_flag(arg, &['e', 'E'])),
        "ruby" | "osascript" | "rscript" | "lua" | "luajit" => any(&|arg| short_flag(arg, &['e'])),
        "php" => any(&|arg| short_flag(arg, &['r'])),
        python if python == "py" || python.starts_with("python") || python.starts_with("pypy") => {
            any(&|arg| short_flag(arg, &['c']))
        }
        _ => false,
    }
}
