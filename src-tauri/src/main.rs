// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
