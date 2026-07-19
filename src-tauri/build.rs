fn main() {
    // Only the standalone-server build cares about dist-web/ (Story 1.11 embed).
    // Guard so desktop/Tauri rebuilds are not invalidated by web-client builds.
    #[cfg(feature = "standalone-server")]
    {
        println!("cargo:rerun-if-changed=../dist-web");
    }
    tauri_build::build()
}
