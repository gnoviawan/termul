# Termul Manager - Deployment Guide

**Date:** 2026-05-09

## Overview

Termul Manager is distributed as a packaged Tauri desktop application. Deployment is release-driven and centered on GitHub Actions workflows that build platform artifacts, sign updater packages, validate release metadata, and publish release assets.

## Packaging Model

The app is bundled through Tauri with:

- desktop binaries and installers for supported platforms
- updater artifacts enabled via `createUpdaterArtifacts: true`
- platform icons and bundle metadata defined in `src-tauri/tauri.conf.json`

Build output is documented as:

- `src-tauri/target/release/bundle/`

## Runtime Configuration

Key runtime/deployment settings live in:

- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.conf.prod.json`

Important configured values include:

- `frontendDist: ../dist-tauri`
- hidden startup window (`visible: false`) until renderer readiness
- updater endpoint: `https://github.com/gnoviawan/termul/releases/latest/download/latest.json`
- updater public key embedded in app config
- bundle targets: `all`

## Local Production Build

```bash
bun run build
```

Additional targeted builds:

```bash
bun run build:tauri:debug
bun run build:tauri:win
bun run build:tauri:mac-arm
bun run build:tauri:mac-x64
bun run build:tauri:linux
```

## Release Workflow

The main release pipeline is `.github/workflows/release.yml`.

### Trigger

- Push a git tag matching `v*`

### Main Stages

1. **Generate changelog**
   - uses `git-cliff`
   - normalizes the version from the tag
   - detects prerelease status

2. **Create or update draft release**
   - creates a GitHub draft release if needed
   - updates body/name when rerun

3. **Build platform artifacts**
   - Windows x64
   - Linux x64
   - macOS arm64

4. **Validate versions**
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
   must all match the tag version

5. **Publish via Tauri action**
   - builds bundles
   - signs updater artifacts
   - uploads to the draft release

6. **Verify updater assets**
   - checks `latest.json`
   - checks `.sig` files
   - blocks stable publish if required updater assets are missing

7. **Publish draft release**
   - finalizes the GitHub release

## CI / Validation Before Release

PR and branch validation are handled separately in `.github/workflows/pr-validation.yml`, which runs:

- lint
- typecheck
- tests
- cargo check
- cargo test
- cargo clippy
- Tauri frontend build verification

## Signing and Auto-Update

Auto-update is enabled in Tauri config and relies on:

- embedded minisign public key in `src-tauri/tauri.conf.json`
- GitHub secrets:
  - `TAURI_SIGNING_PUBLIC_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The app expects stable clients to consume `latest.json` from the GitHub releases latest-download path.

## Release Version Procedure

Per `CONTRIBUTING.md`, maintainers should ensure matching versions in:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Then create and push a tag, for example:

```bash
git tag v0.3.7
git push origin v0.3.7
```

## Platform-Specific Notes

### Linux
The release workflow installs Linux build dependencies such as:

- `libwebkit2gtk-4.1-dev`
- `libappindicator3-dev`
- `librsvg2-dev`
- `patchelf`

### Windows
Windows builds target:

- `x86_64-pc-windows-msvc`

### macOS
Release workflow currently targets:

- `aarch64-apple-darwin`

Repository scripts also support Intel macOS builds locally.

## Additional Distribution Workflow

The repository also contains `.github/workflows/publish-aur.yml`, which updates the Arch Linux AUR package `termul-manager` by:

- resolving the version from tag or workflow input
- cloning the AUR repo
- updating `PKGBUILD`
- regenerating checksums and `.SRCINFO`
- pushing the updated package metadata

## Operational Risks

- version mismatches across JS/Rust/Tauri config will fail release
- missing signing secrets will block updater artifact creation
- missing `latest.json` or signature files will prevent stable release publish
- updater key rotation must be performed carefully to avoid breaking existing clients

## Recommended Release Checklist

1. Run local validation (`bun run lint`, `bun run typecheck`, `bun test`)
2. Run Rust validation in `src-tauri/`
3. Confirm version parity in all three version files
4. Confirm signing secrets are available in GitHub
5. Push release tag
6. Verify draft release assets include installers, `.sig`, and `latest.json`
7. Publish the release

## Related Files

- `src-tauri/tauri.conf.json`
- `.github/workflows/release.yml`
- `.github/workflows/publish-aur.yml`
- `docs/auto-update-release-verification.md`
- `CONTRIBUTING.md`

---

_Generated using BMAD Method `document-project` workflow_
