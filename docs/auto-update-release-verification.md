# Auto-update Release Verification

Use this checklist after publishing a tagged release to verify that stable clients can detect and apply the update.

## Preconditions

- The release tag is stable unless you are intentionally testing prerelease behavior.
- `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` all use the same app version as the tag without the leading `v`.
- CI release workflow completed successfully.

## Signing Key Management

### Current Configuration

The updater public key is configured in `src-tauri/tauri.conf.json` at line 39:
```json
"pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZFNDdGQUQ5NTc4M0Q5OTIKUldTUzJZTlgyZnBIYmdObmg3dFc0QS9PN3F5N2Y5dUNoTy94dWcvTmNxam10Y25tS240dm0ySnYK"
```

When decoded, this is a minisign public key with key ID: `6E47FAD95783D992`

### Private Key Storage

The corresponding private key is stored in GitHub Secrets:
- Secret name: `TAURI_SIGNING_PRIVATE_KEY`
- Additional secrets: `TAURI_SIGNING_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Used in: `.github/workflows/release.yml` at lines 218-220

### Key Rotation Procedure

CRITICAL: Key rotation must follow this exact sequence to avoid breaking updates for existing users.

1. **Generate new keypair** using minisign or Tauri CLI:
   ```bash
   # Using Tauri CLI
   npm run tauri signer generate -- -w ~/.tauri/termul.key

   # Or using minisign directly
   minisign -G -p termul.pub -s termul.key
   ```

2. **Extract the key ID** from the new public key:
   ```bash
   # The key ID appears in the first line of the decoded public key
   cat termul.pub
   # Output: untrusted comment: minisign public key: [KEY_ID_HERE]
   ```

3. **Update tauri.conf.json** with the NEW public key:
   - Base64 encode the public key file contents
   - Update the `pubkey` value in `src-tauri/tauri.conf.json` line 39

4. **Ship a release** containing the new public key BEFORE rotating the private key:
   - This release must be signed with the OLD private key
   - Tag and release normally (e.g., v0.3.7)
   - Verify the release contains `.sig` files and `latest.json`
   - Wait for users to update to this version (contains new public key in config)

5. **Update the GitHub secret** with the new private key:
   - Go to repository Settings > Secrets and variables > Actions
   - Update `TAURI_SIGNING_PRIVATE_KEY` with the new private key content
   - Update `TAURI_SIGNING_PUBLIC_KEY` if used
   - Update `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the password changed

6. **Verify the rotation** on the next release:
   - Check CI logs for the key ID in signing output
   - Download `latest.json` and verify it contains the expected key ID
   - Test update from a client running the transition release

### Key Verification

After each release, verify the signing key ID matches expectations:

1. **Check latest.json**:
   ```bash
   curl -L https://github.com/gnoviawan/termul/releases/latest/download/latest.json
   ```
   Look for the signature field containing the key ID.

2. **Check CI logs**:
   - Navigate to the release workflow run
   - Find the "Build and publish release artifacts" step
   - Verify signing output shows the expected key ID (currently: `6E47FAD95783D992`)

3. **Check .sig files**:
   - Download a `.sig` file from the release assets
   - Parse the signature header to confirm key ID

### Troubleshooting

- **Update verification fails**: Public key in `tauri.conf.json` doesn't match the private key used for signing
- **Missing .sig files**: `TAURI_SIGNING_PRIVATE_KEY` secret is not configured or is invalid
- **Wrong key ID in latest.json**: Private key was rotated without shipping the new public key first

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
