use std::path::Path;

/// Returns the failure message when a release-profile desktop build would
/// compile with Tauri's `cfg(dev)` on (no `custom-protocol`), which makes the
/// binary load `devUrl` and show "Could not connect to localhost".
///
/// `dev` is `tauri_build::is_dev()` (the `DEP_TAURI_DEV` value emitted by the
/// `tauri` crate's build script, `true` whenever `tauri/custom-protocol` is
/// off). Never guards the standalone `termul-server` build (`standalone-server`
/// feature) or when the escape hatch is `1` / `true`.
fn release_custom_protocol_guard(
    profile: &str,
    dev: bool,
    standalone_server: bool,
    allow_override: &str,
) -> Option<String> {
    let allowed = matches!(allow_override.trim(), "1" | "true");
    if profile != "release" || !dev || standalone_server || allowed {
        return None;
    }
    Some(
        [
            "termul: refusing to build a release desktop binary without the `custom-protocol` feature.",
            "Without it Tauri compiles with cfg(dev) and the app loads `devUrl` instead of the embedded",
            "frontend, showing \"Could not connect to localhost\".",
            "Fix: run `cargo build --release --features custom-protocol`, or build through the Tauri CLI",
            "(`bun run build:tauri --no-bundle`).",
            "For `cargo test/clippy --release` only, set TERMUL_ALLOW_RELEASE_WITHOUT_CUSTOM_PROTOCOL=1.",
        ]
        .join("\n"),
    )
}

fn main() {
    // The Vite web build output (`../dist-web/`) is embedded into BOTH the
    // standalone `termul-server` binary and the desktop app (the desktop's
    // in-process shared-live server serves the embedded bundle in a release
    // install). Watch it so a web-client rebuild triggers a cargo rebuild, for
    // both build targets.
    println!("cargo:rerun-if-changed=../dist-web");

    // Declare the custom `web_embed_missing` cfg so the 2024 edition's
    // unexpected-cfg check doesn't reject the `#[cfg(web_embed_missing)]` in
    // `assets.rs`.
    println!("cargo:rustc-check-cfg=cfg(web_embed_missing)");
    // Set by `.cargo/config.toml` (repo root and src-tauri) so async-process
    // uses its SIGCHLD reaper instead of the Linux pidfd epoll loop.
    println!("cargo:rustc-check-cfg=cfg(async_process_force_signal_backend)");

    // Build sequencing + clear missing-bundle failure:
    // `rust-embed`'s `#[allow_missing]` compiles an EMPTY embed when
    // `dist-web/` is absent — fine for dev (`cargo check`/`cargo clippy`
    // without `bun run build:web`) and CI compile-green. But a RELEASE build
    // with a missing/stale bundle would ship a self-contained binary that 404s
    // every static route — a silent deploy bug. Emit a `web_embed_missing` cfg
    // so the release path (NOT debug) hits a `compile_error!` in `assets.rs`
    // telling the operator to run `bun run build:web` first. The Vite build
    // MUST run before `cargo build --bin termul-server` (rust-embed embeds at
    // build time) — CI enforces this ordering (`.github/workflows/*`).
    // `index.html` alone is not sufficient: a stale `dist-web/` that predates
    // the PWA files would compile cleanly yet ship an `index.html` linking a
    // manifest + registering a service worker that 404. Require the whole
    // PWA surface — manifest, worker, favicon, and every install icon — so a
    // stale bundle also trips the release-time gate.
    let required = [
        "index.html",
        "manifest.webmanifest",
        "sw.js",
        "favicon.ico",
        "icons/pwa-192.png",
        "icons/pwa-512.png",
        "icons/pwa-maskable-512.png",
        "icons/apple-touch-icon.png",
    ];
    if required
        .iter()
        .any(|file| !Path::new("../dist-web").join(file).is_file())
    {
        println!("cargo:rustc-cfg=web_embed_missing");
    }

    // Fail fast on a raw release desktop build without `custom-protocol`.
    println!("cargo:rerun-if-env-changed=TERMUL_ALLOW_RELEASE_WITHOUT_CUSTOM_PROTOCOL");
    if let Some(message) = release_custom_protocol_guard(
        &std::env::var("PROFILE").unwrap_or_default(),
        tauri_build::is_dev(),
        std::env::var_os("CARGO_FEATURE_STANDALONE_SERVER").is_some(),
        &std::env::var("TERMUL_ALLOW_RELEASE_WITHOUT_CUSTOM_PROTOCOL").unwrap_or_default(),
    ) {
        panic!("{message}");
    }

    tauri_build::build()
}
