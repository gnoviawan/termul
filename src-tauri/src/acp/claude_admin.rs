//! Local-only Claude setup commands for the standalone `termul-server`
//! (`termul-server claude ...`). Extracted from `server_main.rs`, which stays
//! a thin wiring file (same pattern as the `onboard` module).
//!
//! These commands run before the server binds a socket, so API-key
//! provisioning is never exposed through HTTP or WS. They refuse echoing TTY
//! input, cap input size, and never print or log the key.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use crate::acp::{AcpCatalogService, AcpInstallService, ClaudeAgentService, ClaudeAuthMode};
use crate::web::ServerConfig;

/// Dispatch `termul-server claude <args...>`. Handled by the binary before any
/// tokio/app setup so the subcommand never reaches the server bootstrap.
pub fn run(args: &[String]) -> ExitCode {
    use std::io::{IsTerminal, Read};

    let mut command_args = Vec::new();
    let mut state_dir = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--state-dir" {
            if index + 1 >= args.len() {
                eprintln!("termul-server claude: --state-dir requires a path");
                return ExitCode::from(2);
            }
            state_dir = Some(PathBuf::from(&args[index + 1]));
            index += 2;
        } else {
            command_args.push(args[index].clone());
            index += 1;
        }
    }
    let state_dir = state_dir.unwrap_or_else(|| {
        ServerConfig::from_args(Vec::<String>::new())
            .map(|config| config.service_account_state_dir())
            .unwrap_or_else(|_| std::env::temp_dir().join("termul"))
    });
    let install_root = state_dir.join("acp-registry-binaries");
    let service = ClaudeAgentService::system(install_root.clone());

    match command_args.as_slice() {
        [area, action] if area == "auth" && action == "status" => {
            let runtime = match tokio::runtime::Runtime::new() {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("termul-server claude: could not start runtime: {error}");
                    return ExitCode::from(1);
                }
            };
            match runtime.block_on(service.setup_status()) {
                Ok(status) => {
                    println!(
                        "Claude Code CLI installed: {}",
                        yes_no(status.cli_installed)
                    );
                    println!(
                        "Claude Code CLI signed in: {}",
                        status.cli_authenticated.map(yes_no).unwrap_or("unknown")
                    );
                    println!(
                        "Authentication mode: {}",
                        match status.auth_mode {
                            ClaudeAuthMode::ClaudeCode => "Claude Code login",
                            ClaudeAuthMode::ApiKey => "API key",
                        }
                    );
                    println!(
                        "API key stored in OS keychain: {}",
                        yes_no(status.api_key_configured)
                    );
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("termul-server claude: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [area, action] if area == "auth" && action == "login" => match service.run_cli_login() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("termul-server claude: {error}");
                ExitCode::from(1)
            }
        },
        [area, action, mode] if area == "auth" && action == "mode" => {
            let mode = match mode.as_str() {
                "claude-code" => ClaudeAuthMode::ClaudeCode,
                "api-key" => ClaudeAuthMode::ApiKey,
                _ => {
                    eprintln!("Use `claude-code` or `api-key`.");
                    return ExitCode::from(2);
                }
            };
            match service.set_auth_mode(mode) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("termul-server claude: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [area, action] if area == "api-key" && action == "set" => {
            let stdin = std::io::stdin();
            if stdin.is_terminal() {
                eprintln!(
                    "Refusing an echoing terminal input. Use a hidden prompt, then pipe the key to this command."
                );
                return ExitCode::from(2);
            }
            let mut input = stdin.take(8193);
            let mut bytes = Vec::new();
            if let Err(error) = input.read_to_end(&mut bytes) {
                eprintln!("termul-server claude: could not read key from stdin: {error}");
                return ExitCode::from(1);
            }
            if bytes.len() > 8192 {
                eprintln!("termul-server claude: API key input is too large");
                return ExitCode::from(2);
            }
            let key = match String::from_utf8(bytes) {
                Ok(key) => key.trim().to_string(),
                Err(_) => {
                    eprintln!("termul-server claude: API key input must be UTF-8");
                    return ExitCode::from(2);
                }
            };
            match service.save_api_key(key) {
                Ok(()) => {
                    println!("Claude API key saved in the OS keychain.");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("termul-server claude: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [area, action] if area == "api-key" && action == "delete" => {
            match service.delete_api_key() {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("termul-server claude: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [action] if action == "install" => {
            let runtime = match tokio::runtime::Runtime::new() {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("termul-server claude: could not start runtime: {error}");
                    return ExitCode::from(1);
                }
            };
            let result = runtime.block_on(async {
                let catalog = AcpCatalogService::open(state_dir.join("acp-catalog")).await?;
                let installer = AcpInstallService::open(install_root, Arc::clone(&catalog)).await?;
                installer
                    .install_by_id("claude-acp")
                    .await
                    .map_err(|error| std::io::Error::other(error.message))
            });
            match result {
                Ok(_) => {
                    println!("Pinned Claude Agent ACP package installed.");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("termul-server claude: install failed: {error}");
                    ExitCode::from(1)
                }
            }
        }
        _ => {
            eprintln!("{}", usage());
            ExitCode::from(2)
        }
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

fn usage() -> &'static str {
    "Usage: termul-server claude [--state-dir PATH] <auth status|auth login|auth mode claude-code|api-key|api-key set|api-key delete|install>"
}
