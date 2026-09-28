use std::path::Path;

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
    // PWA surface so a stale bundle also trips the release-time gate.
    let required = ["index.html", "manifest.webmanifest", "sw.js"];
    if required
        .iter()
        .any(|file| !Path::new("../dist-web").join(file).exists())
    {
        println!("cargo:rustc-cfg=web_embed_missing");
    }

    tauri_build::build()
}

