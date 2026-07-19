fn main() {
    // When building termul-server in release with standalone-server, rust-embed
    // (Story 1.11) will read ../dist-web relative to Cargo.toml. Re-run build.rs
    // when that tree changes. Existence enforcement for release embeds lands
    // fully in Story 1.11; this only wires the rerun-if-changed hook.
    println!("cargo:rerun-if-changed=../dist-web");
    tauri_build::build()
}
