// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Self-spawned `--internal-mcp-plan-server` child: the agent spawns this
    // binary (current_exe) as the injected `McpServer::Stdio` for the
    // host-injected `plan` tool. Branch BEFORE any Tauri/log setup so
    // the child never initializes the app / plugins / sinks — it just runs
    // an rmcp MCP server over stdio + forwards calls to the parent's TCP
    // listener. See `acp::host_mcp::child` + spec `spec-acp-host-todo-plan-tool.md`.
    if termul_manager_lib::host_mcp::is_child_invocation() {
        std::process::exit(termul_manager_lib::host_mcp::child::run());
    }

    // Seed a default RUST_LOG so module-level overrides keep working, e.g.:
    //   RUST_LOG=trace npm run dev
    //   RUST_LOG=termul_manager_lib=debug npm run dev
    // The global logger itself (file sink in release, console in debug) is
    // installed by tauri-plugin-log inside `run()`; its level floor is set
    // there (info in release, debug in debug builds).
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var(
            "RUST_LOG",
            if cfg!(debug_assertions) { "debug" } else { "info" },
        );
    }

    termul_manager_lib::run()
}
