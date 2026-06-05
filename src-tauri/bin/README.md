# Sidecar binaries

This directory holds the `ripgrep` sidecar binaries referenced by the Tauri
`externalBin` config (`bin/rg`). The binaries are **not committed to git** —
they are large (~22 MiB across all platforms) and would bloat every clone.

Instead they are downloaded from the official
[ripgrep releases](https://github.com/BurntSushi/ripgrep/releases) at build
time by [`scripts/fetch-rg.mjs`](../../scripts/fetch-rg.mjs), which runs
automatically via the `beforeBuildCommand` / `beforeDevCommand` hooks in
`tauri.conf.json`.

## Manual fetch

```sh
# Host target (uses rustc --print host-tuple)
node scripts/fetch-rg.mjs

# Specific target(s)
node scripts/fetch-rg.mjs x86_64-pc-windows-msvc x86_64-unknown-linux-gnu

# Every supported target
node scripts/fetch-rg.mjs --all

# Force re-download
node scripts/fetch-rg.mjs --force
```

The pinned ripgrep version lives in `RG_VERSION` at the top of the script.
To bump it, change that constant — the version marker (`.rg-version`) triggers
a re-download on the next build.
