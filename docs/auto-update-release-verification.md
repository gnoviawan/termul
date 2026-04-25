# Auto-update Release Verification

Use this checklist after publishing a tagged release to verify that stable clients can detect and apply the update.

## Preconditions

- The release tag is stable unless you are intentionally testing prerelease behavior.
- `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` all use the same app version as the tag without the leading `v`.
- CI release workflow completed successfully.

## Stable release verification

1. Install or keep a locally packaged build older than the target release.
2. Confirm the GitHub release contains a `latest.json` asset.
3. Open the asset URL in a browser:
   - `https://github.com/gnoviawan/termul/releases/latest/download/latest.json`
4. Verify the manifest version matches the released app version.
5. Launch the older installed app.
6. Trigger **Check for Updates** from the app menu or preferences.
7. Confirm the app surfaces the new version.
8. Start the download.
9. Confirm the UI describes the next step as restart-based application of the update.
10. Restart from the updater action and verify the relaunched app reports the new version.

## Prerelease verification

Current policy: stable clients intentionally ignore prerelease tags because the shipped app checks only the stable updater manifest at `/releases/latest/download/latest.json`.

1. Publish a prerelease tag such as `v0.3.2-beta.1`.
2. Confirm CI marks the GitHub release as prerelease.
3. Confirm CI logs the stable-channel notice for prereleases.
4. Verify stable clients do **not** detect that prerelease via `/releases/latest/download/latest.json`.
5. If prerelease support is needed later, add a separate prerelease channel strategy before expecting stable clients to consume it.

## Failure triage

- If update checks fail, capture the full in-app error message.
- If stable clients cannot detect the release, confirm `latest.json` exists on the published stable release.
- If CI fails before publish, confirm the tag version matches all three version files exactly.
- If the UI implies install-on-quit behavior, treat that as a regression; the current supported flow is download/stage then restart.
