//! Launch rules for an imported stdio command (AD-5: the AD-4 deny-list,
//! package grammar and cmd metacharacter rules apply to imports). An import
//! may name any executable, but a runner (`npx`, `uvx`, `docker`, `dotnet`
//! and the same tools under another name) must take the AD-4 template's
//! shape. Pass-through wrappers (`env`, `sudo`, `timeout`, …) are read through
//! by their own option grammar, so a runner can't hide behind one.

use std::sync::LazyLock;

use regex::Regex;

use super::consent::{escape_for_display, HostMount};
use super::convert::{
    check_env_name, check_package_spec, has_cmd_metacharacter, is_denied_env_name,
    is_valid_identifier, McpCatalogReason, Runner,
};

/// The executable's name as Windows resolves it: no directory, lowercase, no
/// trailing dots or spaces (which Windows drops), no executable extension.
fn command_base(command: &str) -> String {
    let base = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .trim_end_matches(['.', ' '])
        .to_ascii_lowercase();
    [".exe", ".cmd", ".bat", ".com"]
        .iter()
        .find_map(|ext| base.strip_suffix(ext))
        .map_or_else(|| base.clone(), str::to_string)
}

fn is_batch_file(command: &str) -> bool {
    let lower = command.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
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

/// A command that runs the command after its own options and operands. Only
/// the options listed here are read; any other is refused, not guessed at.
struct Wrapper {
    /// Options that take no value.
    flags: &'static [&'static str],
    /// Options that take a value: the next argument, `--long=value`, or
    /// `-xVALUE`.
    valued: &'static [&'static str],
    /// Operands before the command, such as `timeout`'s duration.
    operands: usize,
    /// Whether `NAME=value` assignments may precede the command.
    assignments: bool,
}

const fn wrapper(
    flags: &'static [&'static str],
    valued: &'static [&'static str],
    operands: usize,
    assignments: bool,
) -> Wrapper {
    Wrapper {
        flags,
        valued,
        operands,
        assignments,
    }
}

fn wrapper_of(base: &str) -> Option<Wrapper> {
    Some(match base {
        "env" => wrapper(&["-i", "--ignore-environment", "-"], &["-u", "--unset"], 0, true),
        "nohup" => wrapper(&[], &[], 0, false),
        "nice" => wrapper(&[], &["-n", "--adjustment"], 0, false),
        "timeout" => wrapper(
            &["--preserve-status", "--foreground", "-v", "--verbose"],
            &["-k", "--kill-after", "-s", "--signal"],
            1,
            false,
        ),
        "stdbuf" => wrapper(&[], &["-i", "-o", "-e", "--input", "--output", "--error"], 0, false),
        "setsid" => wrapper(&["-c", "--ctty", "-f", "--fork", "-w", "--wait"], &[], 0, false),
        "sudo" => wrapper(
            &["-E", "--preserve-env", "-H", "--set-home", "-n", "--non-interactive"],
            &["-u", "--user", "-g", "--group"],
            0,
            true,
        ),
        "doas" => wrapper(&["-n"], &["-u"], 0, false),
        // `-I` and `-i` substitute stdin into the command line, so they are
        // left out: the command could no longer be read here.
        "xargs" => wrapper(
            &["-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-x", "--exit"],
            &["-n", "--max-args", "-L", "--max-lines", "-P", "--max-procs", "-s", "--max-chars"],
            0,
            false,
        ),
        _ => return None,
    })
}

fn takes_attached_value(valued: &[&str], arg: &str) -> bool {
    valued.iter().any(|option| {
        if option.starts_with("--") {
            arg.strip_prefix(option)
                .is_some_and(|rest| rest.starts_with('='))
        } else {
            arg.len() > option.len() && arg.starts_with(option)
        }
    })
}

fn unwrap_with<'a>(
    name: &str,
    grammar: &Wrapper,
    args: &'a [String],
) -> Result<(&'a str, &'a [String]), McpCatalogReason> {
    let mut rest = args;
    while let Some((arg, tail)) = rest.split_first() {
        if arg == "--" {
            rest = tail;
            break;
        }
        if grammar.flags.contains(&arg.as_str()) || takes_attached_value(grammar.valued, arg) {
            rest = tail;
        } else if grammar.valued.contains(&arg.as_str()) {
            rest = tail
                .split_first()
                .map(|(_, tail)| tail)
                .ok_or_else(|| unsupported(name, arg))?;
        } else if arg.starts_with('-') {
            return Err(unsupported(name, arg));
        } else {
            break;
        }
    }
    rest = rest
        .get(grammar.operands..)
        .ok_or(McpCatalogReason::InvalidCommand)?;
    if grammar.assignments {
        while let Some((variable, tail)) = rest
            .split_first()
            .and_then(|(arg, tail)| Some((arg.split_once('=')?.0, tail)))
        {
            check_env_name(variable)?;
            rest = tail;
        }
    }
    match rest.split_first() {
        Some((command, args)) if !command.starts_with('-') => Ok((command, args)),
        _ => Err(McpCatalogReason::InvalidCommand),
    }
}

/// The command an import really runs once every wrapper is read through, and
/// whether any command on the way is a batch file `cmd.exe` parses.
fn unwrap<'a>(
    mut command: &'a str,
    mut args: &'a [String],
) -> Result<(&'a str, &'a [String], bool), McpCatalogReason> {
    let mut batch = false;
    loop {
        batch |= is_batch_file(command);
        let base = command_base(command);
        (command, args) = match wrapper_of(&base) {
            Some(grammar) => unwrap_with(&base, &grammar, args)?,
            // `busybox <applet> args…` runs the applet.
            None if base == "busybox" => match args.split_first() {
                Some((applet, rest)) if !applet.starts_with('-') => (applet.as_str(), rest),
                Some((option, _)) => return Err(unsupported("busybox", option)),
                None => return Err(McpCatalogReason::InvalidCommand),
            },
            None => return Ok((command, args, batch)),
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

/// Flags, then exactly one grammar-checked package spec. Returns the spec and
/// what follows it.
fn take_package<'a>(
    runner: Runner,
    label: &str,
    args: &'a [String],
) -> Result<(&'a str, &'a [String]), McpCatalogReason> {
    let mut rest = args;
    while let Some((arg, tail)) = rest.split_first() {
        if !arg.starts_with('-') {
            check_package_spec(runner, arg)?;
            return Ok((arg, tail));
        }
        if !allowed_flag(runner, arg) {
            return Err(unsupported(label, arg));
        }
        rest = tail;
    }
    Err(McpCatalogReason::InvalidPackage)
}

/// `docker run [-i] [--rm] [-e NAME]… [-v SPEC]… <image> args…`. An `-e`
/// names a variable passed through from the entry's env, never a value.
/// Returns each `-v` spec.
fn check_docker(args: &[String]) -> Result<Vec<&str>, McpCatalogReason> {
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
    let mut volumes = Vec::new();
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
                } else {
                    volumes.push(value.as_str());
                }
            }
            _ if arg.starts_with("--env=") => env_name("--env", &arg["--env=".len()..])?,
            _ if arg.starts_with("--volume=") => volumes.push(&arg["--volume=".len()..]),
            _ if arg.starts_with('-') => return Err(unsupported("docker", arg)),
            image if is_valid_identifier(Runner::Docker, image) => return Ok(volumes),
            _ => return Err(McpCatalogReason::InvalidPackage),
        }
    }
    Err(McpCatalogReason::InvalidPackage)
}

/// `dnx [--yes] <id>[@<version>] [--yes] [-- args…]`, the AD-4 nuget shape.
/// `dnx` reads options and `@file` response files anywhere before `--`, so
/// every argument for the package must follow it.
fn check_dnx(label: &str, args: &[String]) -> Result<(), McpCatalogReason> {
    let (_, after) = take_package(Runner::Dotnet, label, args)?;
    match after
        .iter()
        .find(|arg| !allowed_flag(Runner::Dotnet, arg))
    {
        Some(arg) if arg != "--" => Err(unsupported(label, arg)),
        _ => Ok(()),
    }
}

/// The first of `words` used as a subcommand, before any `--`.
fn subcommand<'a>(args: &[String], words: &[&'a str]) -> Option<&'a str> {
    args.iter()
        .take_while(|arg| *arg != "--")
        .find_map(|arg| words.iter().find(|word| **word == arg).copied())
}

fn alias(command: String) -> McpCatalogReason {
    McpCatalogReason::UnsupportedRunner { command }
}

/// Holds a runner, or a runner alias, to its AD-4 template shape. Returns
/// whether `base` is a runner. `npx` and `uvx` hand everything after the
/// package to the package itself; aliases with their own option grammar and
/// config files are unsupported, since the npx/uvx form says the same thing.
fn check_runner(base: &str, args: &[String]) -> Result<bool, McpCatalogReason> {
    let alias_words: &[&str] = match base {
        "npx" => return take_package(Runner::Npx, "npx", args).map(|_| true),
        "uvx" => return take_package(Runner::Uvx, "uvx", args).map(|_| true),
        "docker" => return check_docker(args).map(|_| true),
        "dnx" => return check_dnx("dnx", args).map(|()| true),
        "dotnet" => {
            return match args.split_first() {
                Some((subcommand, rest)) if subcommand == "dnx" => {
                    check_dnx("dotnet", rest).map(|()| true)
                }
                Some((subcommand, _)) => Err(unsupported("dotnet", subcommand)),
                None => Err(McpCatalogReason::InvalidPackage),
            }
        }
        "uv" => return check_uv(args),
        "bunx" | "pnpx" => return Err(alias(base.to_string())),
        "npm" => &["exec", "x"],
        "pnpm" => &["dlx", "exec"],
        "yarn" => &["dlx"],
        "bun" => &["x"],
        _ => return Ok(false),
    };
    match subcommand(args, alias_words) {
        Some(word) => Err(alias(format!("{base} {word}"))),
        None => Ok(false),
    }
}

/// `uv tool run` is `uvx`. `uv run --with` fetches packages beside the
/// command with no AD-4 shape. Any other `uv run` runs local code.
fn check_uv(args: &[String]) -> Result<bool, McpCatalogReason> {
    if subcommand(args, &["tool"]).is_some() {
        return match args {
            [tool, run, rest @ ..] if tool == "tool" && run == "run" => {
                take_package(Runner::Uvx, "uv tool run", rest).map(|_| true)
            }
            [tool, other, ..] if tool == "tool" => Err(unsupported("uv tool", other)),
            _ => Err(unsupported("uv", args.first().map_or("", String::as_str))),
        };
    }
    let with = args
        .iter()
        .take_while(|arg| *arg != "--")
        .any(|arg| arg.starts_with("--with"));
    if with {
        return Err(alias("uv run --with".to_string()));
    }
    Ok(false)
}

pub(crate) fn check_stdio_launch(command: &str, args: &[String]) -> Result<(), McpCatalogReason> {
    for arg in args {
        if let Some(name) = denied_assignment(arg) {
            return Err(McpCatalogReason::DeniedEnv { name });
        }
    }
    let (inner, inner_args, batch) = unwrap(command, args)?;
    let runner = check_runner(&command_base(inner), inner_args)?;
    if runner || batch {
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

fn long_flag(arg: &str, flags: &[&str]) -> bool {
    flags.iter().any(|flag| {
        arg.strip_prefix(flag)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('='))
    })
}

/// The package a runner fetches, as the command it runs (`node@20` → `node`),
/// and the arguments the package gets.
fn package_command(runner: Runner, args: &[String]) -> Option<(&str, &[String])> {
    let (spec, rest) = take_package(runner, "", args).ok()?;
    let name = match spec.rsplit_once('@') {
        Some((name, _)) if !name.is_empty() => name,
        _ => spec,
    };
    Some((name.rsplit('/').next().unwrap_or(name), rest))
}

/// Whether the launch hands a shell or interpreter code inline (`sh -c`,
/// `node -e`, `python -c`, `deno eval`, `cmd /c`, `npm exec -c`, any
/// PowerShell), through any wrapper or runner. The consent view can show the
/// code, but the user is unlikely to read it as a program.
pub(crate) fn runs_inline_code(command: &str, args: &[String]) -> bool {
    let Ok((inner, args, _)) = unwrap(command, args) else {
        return false;
    };
    let base = command_base(inner);
    let any = |test: &dyn Fn(&str) -> bool| args.iter().any(|arg| test(arg));
    let packaged = match (base.as_str(), args) {
        ("npx", _) => package_command(Runner::Npx, args),
        ("uvx", _) => package_command(Runner::Uvx, args),
        ("uv", [tool, run, rest @ ..]) if tool == "tool" && run == "run" => {
            package_command(Runner::Uvx, rest)
        }
        _ => None,
    };
    if let Some((package, rest)) = packaged {
        return runs_inline_code(package, rest);
    }
    match base.as_str() {
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "mksh" | "ash" | "fish" => {
            any(&|arg| short_flag(arg, &['c']) || long_flag(arg, &["--command"]))
        }
        "cmd" => any(&|arg| {
            let lower = arg.to_ascii_lowercase();
            lower.starts_with("/c") || lower.starts_with("/k") || lower.starts_with("/r")
        }),
        // Windows PowerShell reads bare arguments as `-Command`.
        "powershell" | "pwsh" => true,
        "node" | "nodejs" | "bun" => {
            any(&|arg| short_flag(arg, &['e', 'p']) || long_flag(arg, &["--eval", "--print"]))
        }
        "deno" => args
            .iter()
            .find(|arg| !arg.starts_with('-'))
            .is_some_and(|arg| arg == "eval"),
        "npm" => {
            subcommand(args, &["exec", "x"]).is_some()
                && any(&|arg| arg == "-c" || long_flag(arg, &["--call"]))
        }
        "pnpm" => {
            subcommand(args, &["dlx"]).is_some()
                && any(&|arg| arg == "-c" || long_flag(arg, &["--shell-mode"]))
        }
        "perl" => any(&|arg| short_flag(arg, &['e', 'E'])),
        "ruby" | "osascript" | "rscript" | "lua" | "luajit" => any(&|arg| short_flag(arg, &['e'])),
        "php" => any(&|arg| short_flag(arg, &['r'])),
        python if python == "py" || python.starts_with("python") || python.starts_with("pypy") => {
            any(&|arg| short_flag(arg, &['c']))
        }
        _ => false,
    }
}

/// The host side of a `-v` spec, when it is a host path rather than a named
/// or anonymous volume: `C:\x:/data`, `/x:/data`, `./x:/data`, `~/x:/data`.
fn volume_host_path(spec: &str) -> Option<&str> {
    let bytes = spec.as_bytes();
    let drive = bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let skip = if drive { 2 } else { 0 };
    let end = skip + spec[skip..].find(':')?;
    let source = &spec[..end];
    (drive || source.starts_with(['/', '\\', '.', '~'])).then_some(source)
}

/// The filesystem root, a home directory (or the directory of homes), the
/// docker socket or a directory holding it.
fn is_sensitive_host_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    if lower.contains("docker.sock") || lower.contains("docker_engine") {
        return true;
    }
    if let Some(home) = lower.strip_prefix('~') {
        return !home.trim_end_matches('/').contains('/');
    }
    let bytes = lower.as_bytes();
    let rooted = if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        &lower[2..]
    } else {
        &lower
    };
    if !rooted.starts_with('/') {
        return false;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in rooted.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    matches!(
        parts.as_slice(),
        [] | ["home" | "users" | "root" | "run"]
            | ["home" | "users", _]
            | ["var", "run"]
    )
}

/// Every host path a docker launch mounts, through any wrapper.
pub(crate) fn host_mounts(command: &str, args: &[String]) -> Vec<HostMount> {
    let Ok((inner, args, _)) = unwrap(command, args) else {
        return Vec::new();
    };
    if command_base(inner) != "docker" {
        return Vec::new();
    }
    check_docker(args)
        .unwrap_or_default()
        .into_iter()
        .filter_map(volume_host_path)
        .map(|path| HostMount {
            host_path: escape_for_display(path),
            sensitive: is_sensitive_host_path(path),
        })
        .collect()
}
