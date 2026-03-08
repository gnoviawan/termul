// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Initialize logger for development.
    // Set RUST_LOG to control log level, for example:
    //   RUST_LOG=debug npm run tauri dev
    //   RUST_LOG=termul_manager=trace npm run tauri dev
    let _ = env_logger::try_init();

    termul_manager_lib::run()
}
