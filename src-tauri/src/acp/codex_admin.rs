//! Local-only Codex Account commands for the standalone `troupe-server`
//! (`troupe-server codex account ...`). They run before the server binds a
//! socket. They print account ids and names only — never login details.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::acp::{CodexAgentService, CodexSignInCheck};

/// Dispatch `troupe-server codex <args...>`.
pub fn run(args: &[String]) -> ExitCode {
    let mut command_args = Vec::new();
    let mut state_dir = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--state-dir" {
            if index + 1 >= args.len() {
                eprintln!("troupe-server codex: --state-dir requires a path");
                return ExitCode::from(2);
            }
            state_dir = Some(PathBuf::from(&args[index + 1]));
            index += 2;
        } else {
            command_args.push(args[index].clone());
            index += 1;
        }
    }
    // Only a directory the operator typed is repeated in the login hint.
    // The resolved default directory stays off stdout.
    let explicit_state_dir = state_dir.clone();
    let state_dir = explicit_state_dir.clone().unwrap_or_else(|| {
        crate::web::ServerConfig::from_args(Vec::<String>::new())
            .map(|config| config.service_account_state_dir())
            .unwrap_or_else(|_| std::env::temp_dir().join("termul"))
    });
    let service = CodexAgentService::system(state_dir.join("acp-registry-binaries"));
    match command_args.as_slice() {
        [area, rest @ ..] if area == "account" => {
            run_account(&service, explicit_state_dir.as_deref(), rest)
        }
        _ => {
            eprintln!("{}", usage());
            ExitCode::from(2)
        }
    }
}

/// Run one account operation. `login` of a real Account starts `codex login
/// --device-auth` in this terminal.
pub(crate) fn run_account(
    service: &CodexAgentService,
    explicit_state_dir: Option<&Path>,
    args: &[String],
) -> ExitCode {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    if args.iter().any(|arg| matches!(*arg, "-h" | "--help")) {
        println!("{}", usage_text());
        return ExitCode::SUCCESS;
    }
    let result = match args.as_slice() {
        ["list"] => {
            let runtime = match tokio::runtime::Runtime::new() {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("troupe-server codex: could not start runtime: {error}");
                    return ExitCode::from(1);
                }
            };
            runtime.block_on(service.profile_list()).map(|snapshot| {
                for row in &snapshot.profiles {
                    let default = if row.id == snapshot.default_account_id {
                        " (default)"
                    } else {
                        ""
                    };
                    let signed_in = row.signed_in.map(yes_no).unwrap_or("unknown");
                    println!("{}  {}{default}  signed in: {signed_in}", row.id, row.name);
                }
                for (project, choice) in &snapshot.project_profiles {
                    println!("project {project} uses {choice}");
                }
            })
        }
        ["add", name] => service.insert_profile(name).map(|created| {
            println!("Added account {} ({}).", created.name, created.id);
            println!("{}", login_hint(explicit_state_dir, &created.id));
        }),
        ["login", id] => service.run_account_cli_login(id),
        ["rename", id, name] => service.rename_account(id, name),
        ["remove", id] => match tokio::runtime::Runtime::new() {
            Ok(runtime) => runtime.block_on(service.remove_account(id)).map(|moved| {
                println!(
                    "Removed. {} projects moved to the default account.",
                    moved.len()
                );
            }),
            Err(error) => Err(format!("could not start runtime: {error}")),
        },
        ["default", id] => block_on(service.set_default_account(id, CodexSignInCheck::Skip)),
        ["project", project, "default"] => block_on(async {
            service
                .set_project_account(project, None, None, CodexSignInCheck::Skip)
                .await
                .map(drop)
        }),
        ["project", project, id] => block_on(async {
            service
                .set_project_account(project, Some(id), None, CodexSignInCheck::Skip)
                .await
                .map(drop)
        }),
        _ => {
            eprintln!("{}", usage_text());
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("troupe-server codex: {error}");
            ExitCode::from(1)
        }
    }
}

fn block_on(
    operation: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    tokio::runtime::Runtime::new()
        .map_err(|error| format!("could not start runtime: {error}"))?
        .block_on(operation)
}

/// The command the operator can copy. A directory they passed with
/// `--state-dir` is repeated. The host default is omitted, because a later
/// `troupe-server codex account login` uses that same default.
pub(crate) fn login_hint(explicit_state_dir: Option<&Path>, account_id: &str) -> String {
    match explicit_state_dir {
        Some(dir) => format!(
            "Sign in with: troupe-server codex --state-dir {} account login {account_id}",
            quote_arg(&dir.display().to_string())
        ),
        None => format!("Sign in with: troupe-server codex account login {account_id}"),
    }
}

/// Quote one shell argument. Paths without spaces stay bare so the printed
/// command can be copied. A space or quote is wrapped and the quote escaped.
fn quote_arg(value: &str) -> String {
    if value.contains([' ', '\t', '"']) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

fn usage_text() -> &'static str {
    "Usage: troupe-server codex [--state-dir PATH] account <list|add NAME|login ID|rename ID NAME|remove ID|default ID|project PROJECT_ID ID|default>"
}

fn usage() -> &'static str {
    "Usage: troupe-server codex [--state-dir PATH] account <list|add NAME|login ID|rename ID NAME|remove ID|default ID|project PROJECT_ID ID|default>"
}

#[cfg(test)]
#[path = "codex_admin_tests.rs"]
mod tests;
