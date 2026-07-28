# Termul Manager - Deployment Guide

**Date:** 2026-07-28

## Overview

Termul Manager is distributed as a packaged Tauri desktop application. Releases are built on GitHub Actions, updater artifacts are signed with the existing Tauri minisign key, macOS bundles are additionally Developer ID signed and notarized, and one publish job owns every GitHub Release upload.

## Packaging Model

The app is bundled through Tauri with updater artifacts enabled by `createUpdaterArtifacts: true`. Runtime and production bundle settings live in:

- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.conf.prod.json`

The stable updater endpoint is:

- `https://github.com/gnoviawan/termul/releases/latest/download/latest.json`

The desktop release build also creates `dist-web/` before compiling so the embedded browser client is present in both desktop binaries and the standalone Linux server.

## Required Release Secrets

All platform builds require the updater signing contract:

- `TAURI_SIGNING_PUBLIC_KEY`
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Both macOS architecture jobs also require:

- `APPLE_CERTIFICATE` — base64 Developer ID Application certificate (`.p12`)
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD` — app-specific password
- `APPLE_TEAM_ID`

The macOS jobs check these categories immediately after checkout, before dependency installation. Missing values fail with names only; values are never printed.

Stable Homebrew publication additionally requires:

- `HOMEBREW_TAP_TOKEN` — write access to `gnoviawan/homebrew-termul`

The reusable Homebrew workflow resolves authoritative GitHub release metadata before this token is checked. Prereleases therefore still receive `SHA256SUMS.txt`, skip the tap update, and do not require the tap token.

## Release Workflow

`.github/workflows/release.yml` is triggered by `v*` tags. Tags must be full SemVer and may contain dotted prerelease/build identifiers, for example `v1.2.3-beta.1+macos.7`.

The workflow order is:

1. Generate the changelog, normalize the tag, and create/update a draft release.
2. Build Windows x64, Linux x64, macOS arm64, and macOS Intel locally with `tauri-action` **without** `tagName`, `releaseId`, or other upload identifiers.
3. Verify both macOS `.app` bundles and DMGs with `codesign`, `spctl`, and `stapler`, and reject non-portable Mach-O dependency or `LC_RPATH` entries before collecting them.
4. Convert each platform's Tauri artifact output into an isolated workflow artifact containing release assets and a platform updater manifest.
5. Build the standalone Linux server as a workflow artifact after creating the embedded browser bundle.
6. In one publish job, download every workflow artifact, reject conflicting asset names, deeply validate each updater `{url, signature}` record, reject conflicting duplicate platform records, require every supported Tauri updater key, and authoritatively create `latest.json`.
7. Upload all release assets and `latest.json` once, then publish the draft.
8. Invoke the reusable Homebrew workflow for every release channel. It always generates `SHA256SUMS.txt`; only stable releases update the tap.

No matrix/platform build job or standalone-server job is permitted to upload GitHub Release assets or write a shared `latest.json`.

## Required Updater Platforms

The centralized merge validates the conventions used by Tauri and the historical v0.4.8 manifest:

- `windows-x86_64`
- `windows-x86_64-msi`
- `windows-x86_64-nsis`
- `linux-x86_64`
- `linux-x86_64-appimage`
- `linux-x86_64-deb`
- `linux-x86_64-rpm`
- `darwin-aarch64`
- `darwin-aarch64-app`
- `darwin-x86_64`
- `darwin-x86_64-app`

Every record must have a nonempty URL and minisign signature. Missing keys, malformed records, version mismatches, and conflicting duplicate records fail before upload.

## Platform Notes

### Linux and Browser Bundle

Linux desktop and standalone-server builds preserve the current `ubuntu-22.04` dependency setup, including WebKitGTK, appindicator, SVG, D-Bus, and `patchelf`. Both build paths create and validate `dist-web/index.html` before Rust compilation so the in-process browser client is embedded rather than relying on files outside the installation.

### Windows

Windows releases target `x86_64-pc-windows-msvc` and collect both MSI and NSIS updater records and signatures.

### macOS Portability, Signing, and Notarization

Both `aarch64-apple-darwin` and `x86_64-apple-darwin` are built. For these targets, the SSH dependency vendors OpenSSL so the packaged app does not require Homebrew OpenSSL on user systems.

The macOS collection gate requires exactly one `.app` and one DMG, resolves the app's declared `CFBundleExecutable`, and inspects that executable with `otool -L` and `otool -l`. It permits system libraries and relocatable `@rpath`, `@loader_path`, and `@executable_path` dependencies, but rejects Homebrew/local prefixes, runner-local absolute paths, unexpected relative load paths, and non-portable `LC_RPATH` entries. It then runs:

```bash
codesign --verify --deep --strict --verbose=2 "Termul Manager.app"
spctl --assess --type execute --verbose=4 "Termul Manager.app"
xcrun stapler validate "Termul Manager.app"
codesign --verify --strict --verbose=2 Termul.Manager_*.dmg
spctl --assess --type open --context context:primary-signature --verbose=4 Termul.Manager_*.dmg
xcrun stapler validate Termul.Manager_*.dmg
```

After maintainers provision the Apple secrets, repeat these checks against both architectures on a real release. Existing v0.4.8 GitHub assets cannot be retroactively notarized.

## Homebrew and Checksums

`.github/workflows/publish-homebrew.yml` is both reusable and manually dispatchable. It:

1. validates full SemVer input;
2. queries the GitHub release's `isPrerelease` metadata;
3. downloads all release assets and uploads `SHA256SUMS.txt` for stable and prerelease channels;
4. skips the tap job for prereleases without evaluating `HOMEBREW_TAP_TOKEN`;
5. for stable releases, strictly resolves exactly one checksum for each macOS DMG and updates the cask idempotently;
6. serializes reusable workflow runs with tap-wide concurrency so different release versions cannot race while pushing the cask.

Version `0.4.8` is a narrow historical exception. Its unsigned/unnotarized DMGs retain the cask `xattr -dr com.apple.quarantine` postflight. The cask generator omits that workaround for every other version, including all future signed/notarized releases.

## Additional Distribution Workflow

`.github/workflows/publish-aur.yml` remains the separate Arch Linux AUR publication workflow. It is not part of the centralized GitHub Release asset upload path.

## Operational Risks and Release Checklist

- Version mismatches across JS, Rust, and Tauri configuration fail the release.
- Missing updater or Apple signing credentials block the affected build before publication.
- Missing signatures, missing updater keys, malformed URLs, conflicting manifests, or conflicting duplicate asset names fail the centralized publish job.
- Updater key rotation must be coordinated carefully to avoid breaking existing clients.

Recommended release checks:

1. Run focused release validation and normal repository CI validation.
2. Confirm version parity in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
3. Confirm updater, Apple, and stable Homebrew secrets are provisioned for the intended channel.
4. Push the release tag.
5. Confirm both macOS portability/signing/notarization gates pass.
6. Confirm the centralized publish job reports every required updater platform and uploads installers, updater archives, `.sig` files, `termul-server`, and `latest.json` exactly once.
7. Confirm `SHA256SUMS.txt` exists; for stable releases, confirm the Homebrew cask update succeeds.

## Local Validation

Focused release validation does not require broad application builds:

```bash
actionlint .github/workflows/release.yml .github/workflows/publish-homebrew.yml
bun run test -- scripts/release/prepare-platform-artifacts.test.ts scripts/release/merge-updater-manifests.test.ts
npx bats scripts/tests/homebrew-release.bats
node --check scripts/release/prepare-platform-artifacts.mjs
node --check scripts/release/merge-updater-manifests.mjs
bash -n scripts/release/homebrew.sh
```

Normal pre-PR validation remains `bun run ci`, `bun run typecheck`, `bun run test`, Rust clippy/tests, and the repository's CI/CodeRabbit gates.

## Related Files

- `.github/workflows/release.yml`
- `.github/workflows/publish-homebrew.yml`
- `.github/workflows/publish-aur.yml`
- `scripts/release/prepare-platform-artifacts.mjs`
- `scripts/release/merge-updater-manifests.mjs`
- `scripts/release/homebrew.sh`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.conf.prod.json`
