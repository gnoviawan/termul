// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Initialize logger.
    // In debug builds, default to "debug" level if RUST_LOG is not set.
    // In release builds, default to "warn" level and also log to file.
    // Override with RUST_LOG env var, for example:
    //   RUST_LOG=trace npm run dev
    //   RUST_LOG=termul_manager=debug npm run dev
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var(
            "RUST_LOG",
            if cfg!(debug_assertions) { "debug" } else { "warn" },
        );
    }
    let _ = env_logger::try_init();

    termul_manager_lib::run()
}
