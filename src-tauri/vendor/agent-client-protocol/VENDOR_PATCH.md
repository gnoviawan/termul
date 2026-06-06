# Vendored `agent-client-protocol` 0.12.1 — Termul patch

This is a vendored copy of [`agent-client-protocol`](https://crates.io/crates/agent-client-protocol)
`0.12.1`, consumed via `[patch.crates-io]` in `src-tauri/Cargo.toml`.

## Why it's vendored

The crate spawns the agent subprocess inside `AcpAgent::spawn_process` and
exposes no hook to set OS process-creation flags. On Windows that spawn omits
`CREATE_NO_WINDOW`, so a console window flashes when Termul (a GUI app) launches
an ACP agent. Every other Termul subprocess sets this flag; this patch brings the
ACP spawn in line.

## The only functional change

`src/acp_agent.rs`, in `spawn_process`, immediately before `cmd.spawn()`:

```rust
// Termul patch: on Windows, suppress the console window. CREATE_NO_WINDOW = 0x08000000.
#[cfg(target_os = "windows")]
{
    use async_process::windows::CommandExt as _;
    cmd.creation_flags(0x0800_0000);
}
```

## Trimmed for size

`examples/` and `tests/` were deleted (not part of the library build), along with
their `[[example]]`/`[[test]]` entries and the `clap`/`expect-test` dev-deps in
`Cargo.toml`. No library source was otherwise modified.

## Upgrading

To move to a newer upstream version: re-vendor that version, re-apply the
`spawn_process` change above, and delete `examples/`, `tests/`, and their
`Cargo.toml` entries + dev-deps again. Then run `cargo build` from `src-tauri`.
