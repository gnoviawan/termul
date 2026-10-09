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

The macOS jobs check these categories immediately after checkout, before dependency installation. Missing values fail with names only; values are never printed. The same job imports the `.p12` into a temporary keychain, then passes the signing identity, Apple ID, app-specific password, and Team ID into the macOS build so Tauri can sign and notarize the app and the DMG. The `codesign`, `spctl`, and `stapler` checks run on every macOS build.

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
5. Build the standalone Linux server as one workflow artifact per architecture (x64 on `ubuntu-22.04`, arm64 on the native `ubuntu-22.04-arm` runner) after creating the embedded browser bundle.
6. In one publish job, download every workflow artifact, reject conflicting asset names, deeply validate each updater `{url, signature}` record, reject conflicting duplicate platform records, require every supported updater key (desktop and both server keys), and authoritatively create `latest.json`.
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
- `linux-x86_64-server` (asset `termul-server`)
- `linux-aarch64-server` (asset `termul-server-linux-aarch64`)

The two server keys come from the standalone-server job's per-architecture fragments. The aarch64 key is required, so a failed arm64 build fails the whole publish rather than shipping a release without it.

Every record must have a nonempty URL and minisign signature. Missing keys, malformed records, version mismatches, and conflicting duplicate records fail before upload.

## Platform Notes

### Linux and Browser Bundle

Linux desktop and standalone-server builds preserve the current Ubuntu 22.04 dependency setup, including WebKitGTK, appindicator, SVG, D-Bus, and `patchelf`. The standalone server builds natively on both architectures: `ubuntu-22.04` for x64 and `ubuntu-22.04-arm` for arm64, with no cross-compilation. Both build paths create and validate `dist-web/index.html` before Rust compilation so the in-process browser client is embedded rather than relying on files outside the installation.

#### Installing `termul-server`

The x64 asset keeps the name `termul-server`; the arm64 asset is `termul-server-linux-aarch64`. Pick the one matching `uname -m`:

```bash
case "$(uname -m)" in
  x86_64)          asset=termul-server ;;
  aarch64|arm64)   asset=termul-server-linux-aarch64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
curl -fL -o termul-server "https://github.com/gnoviawan/termul/releases/latest/download/$asset"
chmod +x termul-server
```

`releases/latest/download/` resolves to the latest stable release only. For the nightly channel use `https://github.com/gnoviawan/termul/releases/download/nightly/$asset`. Each asset has a minisign signature next to it (`$asset.sig`) and is listed in the release's `SHA256SUMS.txt`. The arm64 binary is built on Ubuntu 22.04 (glibc 2.35 or newer required), so musl-based distributions such as Alpine are not supported.

The opt-in self-updater selects its manifest key from the architecture the binary was built for (`linux-x86_64-server` or `linux-aarch64-server`), so each host updates to its own binary and keeps the installed filename.

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

## PWA / Installable Web Client

The web bundle (`dist-web/`, served by `termul-server` and the desktop shared-live host) is installable as a Progressive Web App. `public/manifest.webmanifest`, `public/sw.js`, and `public/icons/` ship inside the bundle, and `index.html` links the manifest, favicon, `apple-touch-icon`, and the og/twitter card image.

**Install requirements.** Service workers and browser install prompts are gated by the platform secure-context rule: the client must be reached over `https://` (for example through the cloudflared tunnel) or via `localhost`. A plain `http://<LAN-IP>` visit stays a normal browser tab — registration is skipped deliberately and logged via `console.info` (the backend `POST /log/frontend-error` endpoint is loopback-gated, so a report from a non-loopback origin would be refused anyway). The desktop app never registers a service worker.

**Installing.** There is no in-app install button by design — use the browser-native affordance:

- Desktop Chrome/Edge: the install icon in the address bar (or menu → "Install Termul").
- Android Chrome: menu → "Add to Home screen" / install prompt.
- iOS Safari: Share → "Add to Home Screen" (`apple-mobile-web-app-capable` + `black-translucent` status bar + opaque `apple-touch-icon` are set).

Launched installed, the app runs `display: standalone` with the Termul name/icon. `start_url`/`scope` are `/`. Token auth normally carries over because `web-auth-token.ts` moves the `#token=` fragment into `localStorage` and strips it from the URL on first load.

**iOS caveat.** Home-screen web apps get an isolated `localStorage` separate from Safari's. On a token-gated server the token stored in the browser tab does NOT carry into the installed iOS app — since `#token=` is consumed into `localStorage` on first load, the installed app may need the token re-entered once in its own storage. This is a web-auth limitation, not PWA-specific.

**Notifications need HTTPS too.** Browser notifications (terminal idle/exit,
agent chat turn finished / permission or question waiting) use the Web
Notifications API, which — like service workers — is gated on a secure
context. Over plain `http://<LAN-IP>` the send path no-ops: the permission
prompt never appears and no notifications arrive. Serve over `https://`
(or `localhost`) for notifications; they are also skipped while the tab is
already showing the chat or terminal that finished, by design.

**Token re-entry (#854).** On a token-gated server the web client probes a
gated route at boot; a missing or rotated token opens a token-entry screen
instead of hanging on "Loading...", so an installed iOS PWA can re-enter a
token even though it cannot edit its URL to add `#token=`.

**Update semantics.** `sw.js` runtime-caches the static shell only — it never intercepts `/ws`, `/terminal/ws`, or any API route (non-GET and cross-origin requests pass straight through), and never caches API responses. Per-path policy:

- `/assets/*` (Vite content-hashed) → **cache-first**, keyed by pathname (query strings ignored).
- `index.html`, `/manifest.webmanifest`, `/sw.js`, `/favicon.ico`, `/icons/*` → **network-first** — unversioned files are never pinned behind a stale cache entry.
- Same-origin GET navigations → **network-first with an 8s `AbortSignal` timeout** (feature-detected; older iOS SW runtimes lack `AbortSignal.timeout`), falling back to the cached `/` shell when the fetch rejects *or answers HTTP 5xx* (a tunnel/proxy 502/503 is the same outage as a refused connection; 4xx responses are real and pass through) — including non-allowlisted paths so a deep-link reload boots the app instead of a browser error page (non-allowlisted responses are never stored).

Cache writes are `event.waitUntil`-covered so the worker can't terminate mid-`put`; a missing or rejecting CacheStorage degrades to a plain `fetch`. `install` precaches the shell files *plus* the hashed `/assets/*` entry bundle parsed from the cached `index.html` — without it, an offline installed launch could open cached HTML whose JS/CSS lived only in the evictable HTTP cache. `install` also calls `self.skipWaiting()` so open tabs don't stall updates. Quota stays bounded: `/assets/*` puts skip bodies over 8 MiB (by `Content-Length`) and each write trims the set to the newest 150 entries — a deploy that leaves `sw.js` unchanged never re-`activate`s, so trimming cannot wait for activation alone; `activate` still purges stale `termul-pwa-*` caches and re-trims as a safety net.

Server headers mirror the policy: the embedded release path serves `assets/` immutable and everything else `no-cache, must-revalidate`, and the disk `ServeDir` path (source-checkout deploys) gets the same shell `no-cache` via the `shell_no_cache_headers` router middleware.

**`CACHE_NAME` discipline.** Bump `termul-pwa-vN` in `public/sw.js` whenever the caching strategy or allowlist changes — `activate` purges every other `termul-pwa-*` cache, so the bump is what evicts entries shaped by the old policy.

**Offline scope.** The app is a thin shell over a live server — offline startup reaches the normal connection-error UI; terminals and chat still require the host.

**Manual verification.** Serve the client over `https://` or `localhost`, then in Chrome/Edge DevTools → **Application**: the Manifest tab shows name/icons with no errors; Service Workers shows `sw.js` activated and running; the install icon appears in the address bar (criteria met). `curl -I` on `/sw.js`, `/manifest.webmanifest`, `/index.html`, and an `/icons/*` file should show `Cache-Control: no-cache, must-revalidate` (and `application/manifest+json` for the manifest); a hashed `/assets/*` file shows `immutable`. On iOS, Share → "Add to Home Screen" should preview the opaque icon and "Termul" title.

## Standalone server origins

`termul-server` checks an `Origin` header when a client sends one. The header must name the same host and port as the request's `Host` header, or an origin passed to `--allowed-origins` / `TERMUL_ALLOWED_ORIGINS`. The embedded web client is served by the same process, so its requests match without an extra entry. Clients that omit `Origin` are unchanged, and `--web-auth-token` / `TERMUL_WEB_AUTH_TOKEN` still apply on their own.

A reverse proxy that preserves the public `Host` header (Caddy and cloudflared do this by default) matches `https://<public-host>` with no extra origin. When the proxy rewrites `Host` to the upstream address, list the public origin explicitly:

```bash
termul-server --host 127.0.0.1 --port 8080 \
    --allowed-origins https://termul.example.com
```

Comma-separate several origins, or repeat `--allowed-origins`. The flag replaces `TERMUL_ALLOWED_ORIGINS` when both are set. The server does not send `Access-Control-Allow-Origin`.

The desktop app talks to the host through Tauri IPC, not these HTTP or WebSocket routes. The desktop shared-live server uses the same host check. Browser clients of that server are served by it, so they match the request host; a proxy in front of it that keeps the public `Host` header does too.

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
5. Confirm both macOS portability/signing/notarization gates pass and that both `standalone-server` matrix entries (x64 and arm64) succeed.
6. Confirm the centralized publish job reports every required updater platform and uploads installers, updater archives, `.sig` files, `termul-server`, `termul-server-linux-aarch64`, and `latest.json` exactly once.
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
- `public/manifest.webmanifest`
- `public/sw.js`
- `public/icons/`
- `src/renderer/lib/pwa-register.ts`
- `index.html`
