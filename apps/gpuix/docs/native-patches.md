# Native patches: a self-built @gpuix/native

Some parity gaps cannot be closed in TypeScript. Italic text, the chat's link colour and inline-code chip, and the browser helper's window lookup all need changes inside the GPUIX native addon or inside Zed's GPUI. This page explains how Termul builds `@gpuix/native` 0.11.0 from source with its own patch series, how to run the app on that build, and how to carry the series to a new upstream release.

The published npm addon stays the default. Nothing changes for a developer who never builds the native addon.

## Layout

| Path | Contents |
|---|---|
| `native/gpuix-native/pins.env` | The upstream commits: gpuix `2e31b47` (the `@gpuix/native@0.11.0` release), its Zed submodule `f77e5cf`, and Rust 1.97.1. |
| `native/gpuix-native/build.sh` | Fetch, patch, build, test and drift-check commands. |
| `native/gpuix-native/patches/zed/*.patch` | Changes to Zed's GPUI, applied in name order to the Zed checkout. |
| `native/gpuix-native/patches/gpuix/*.patch` | Changes to the napi crate (`packages/native`), applied in name order to the gpuix checkout. |
| `native/gpuix-native/build/` | The built addon (git-ignored). |
| `src/native-patches.d.ts` | The TypeScript surface the patches add. |
| `tools/native/patch-check.ts` | The on-screen check for every patch. |

The upstream sources are not vendored. `build.sh` fetches them at the pinned commits.

## Build the addon

Requirements on Linux x64:

- `rustup`. The script selects the pinned toolchain, and rustup installs it on first use.
- The packages GPUIX's CI installs: `gcc g++ libfontconfig-dev libwayland-dev libxkbcommon-x11-dev libx11-xcb-dev libssl-dev libzstd-dev libvulkan1`. If only the runtime `libxkbcommon-x11-0` and `libx11-xcb1` are present, `build.sh` links through `.so` symlinks under the work dir instead.
- About 4 GB of disk in the work dir.

Run it from `apps/gpuix`:

```sh
bun run native:build          # fetch + patch + cargo build + load check
```

The output is `native/gpuix-native/build/gpuix-native.linux-x64-gnu.node`. The build uses the same flags as the published Linux addon: `--release --no-default-features`, with LTO from the crate's release profile.

The work dir holds the sources and the cargo target. It defaults to `~/gpuix-native-target`; set `TERMUL_GPUIX_NATIVE_WORK` to move it. The build runs under `nice -n 19` and stops itself when the work dir grows past `TERMUL_GPUIX_NATIVE_MAX_GB` (14) or `/` falls under `TERMUL_GPUIX_NATIVE_MIN_FREE_GB` (8) free.

Measured on the 8-core development box (2026-10-25):

| Build | Wall time | Work dir |
|---|---|---|
| Cold, no patches | 20 min 10 s | 2.2 GB |
| Zed and napi patches changed | 2 to 4 min | 3 GB |
| `build.sh test`, first run | 15 min | 3.5 GB |

The unpatched build is 52,433,848 bytes. The published addon is 52,449,896 bytes.

Other commands:

```sh
sh native/gpuix-native/build.sh fetch   # shallow-fetch both repos at the pins
sh native/gpuix-native/build.sh patch   # reset both checkouts to the pins and apply the series
sh native/gpuix-native/build.sh build   # cargo build + package, after patch
sh native/gpuix-native/build.sh test    # the napi crate's own unit tests on the patched source
bun run native:check                    # drift check, see below
```

`patch` is idempotent. It records the applied series as a local commit, `termul-patches <series hash>`, on top of each pin. A rerun with an unchanged series and a clean tree does nothing, so cargo keeps its incremental state. Any other state is reset to the pin and the series is applied again.

## Run the app on the self-built addon

`@gpuix/native` loads the file named by `NAPI_RS_NATIVE_LIBRARY_PATH` instead of the npm package. Every launcher and tool inherits it:

```sh
export NAPI_RS_NATIVE_LIBRARY_PATH=$PWD/native/gpuix-native/build/gpuix-native.linux-x64-gnu.node
bun run test
bun run native:patch-check
bun tools/terminal/parity.ts --bytes tools/terminal/fixtures/italic.bin
```

Unset it to return to the published addon. The published addon ignores the style and theme keys that only the patches read, so the app code sets them unconditionally.

## The patch series

| Patch | Adds | Used by |
|---|---|---|
| `zed/0001-run-font-scale` | A per-run glyph scale in GPUI's Linux text system. A font requested with the pseudo feature `tszl` (value in per mille) is shaped, laid out and painted at that fraction of the line's font size. A scaled font has its own `FontId`, so the layout cache and the glyph atlas need no other change. | `0002`: inline-code chips at `0.88em`. |
| `zed/0002-reexport-raw-window-handle` | `gpui::raw_window_handle`, so the napi crate can read the window handle without a new dependency (the lockfile stays `--locked`). | `0003`. |
| `gpuix/0001-font-style` | The style prop `fontStyle: 'italic' \| 'normal'`, inherited down the tree like the rest of the text style. GPUI picks the family's italic face. | Terminal SGR 3 (`TerminalView`), the Tailwind `italic` and `not-italic` utilities. |
| `gpuix/0002-markdown-theme` | `<markdown>` theme fields: `link`, `linkUnderline`, `linkWeight`, `fontStyle` (every run italic), and metrics `mdInlineCodeScale`, `mdInlineCodePaddingX`, `mdInlineCodeInsetY`. | `src/chat/theme.ts`: links in medium primary, inline code at `0.88em` with `0.3em` padding, italic quotes. |
| `gpuix/0003-native-window-handle` | `GpuixRenderer.getNativeWindowHandle()`: `{ kind: 'x11', id }` on X11, `{ kind: 'wayland' }` on Wayland, `null` before a window exists. | The browser-pane helper starts with `--parent <id>`; without an id it falls back to `--parent-pid` and the `_NET_WM_PID` search. |
| `gpuix/0004-input-unfocused-scroll` | An unfocused `<input>` given a new value shows the start of the text, as a DOM input does. Only a focused field scrolls to keep the caret in view. | The browser URL bar in a narrow pane (URL-INPUT). |

Italics also need italic faces. `tools/style/build-fonts.py` builds Inter's real italics and a Paper Mono oblique. Paper Mono has no italic, so the browser draws a synthetic one; the oblique bakes Blink's skew (`SkFont::setSkewX(-1/4)`) into the outlines. The terminal's own Paper Mono files get the same treatment. On the published addon, the prose italics of `<markdown>` already use these faces; `fontStyle` needs patch `0001`.

## Verification

`bun run native:patch-check` paints one sample per patch under Xvfb and lavapipe, grabs the window and asserts what each patch draws. It fails on the published addon, which is what makes it a test:

| Check | Self-built | Published |
|---|---|---|
| Upright `|` strokes, slant | 0 | 0 |
| `fontStyle: 'italic'`, slant (Blink: 0.25) | 0.257 | 0 (FAIL) |
| Link pixels in `theme.link` red | 1025 | 40 (FAIL) |
| Inline-code ink width, scale 0.5 over 1.0 | 0.50 | 1.00 (FAIL) |
| `getNativeWindowHandle()` names the window | `{ kind: 'x11', id: 0x200001 }` | `null` (FAIL) |

Parity against the web client, measured on 2026-10-25:

- Terminal SGR 3 (`tools/terminal/parity.ts --bytes tools/terminal/fixtures/italic.bin`). The perceptual diff of the italic rows against xterm.js falls from 14.87% to 12.85%; the upright control row stays at 7.23%. The slant now matches: shifting the top and bottom halves of the italic row against the web gives the same best offset (-0.75 px), against a -0.25 px offset for the upright row. A steeper skew lowers the row diff slightly (12.0% at 0.40) only by cancelling that constant 0.5 px offset, while the slant stops matching, so the oblique keeps Blink's 0.25.
- Terminal default fixture (`less`, `vim`, `done`): identical cells and pixels on both addons (2.45%, 3.61%, 10.69% exact before; 2.45%, 3.61%, 10.68% after).
- Chat transcript (`tools/chat/parity.ts`), ROI perceptual diff before and after: bottom 3.53% and 3.51%, middle 10.05% and 10.06%, top 6.04% and 5.94%. The whole-ROI number is dominated by layout offsets and the Mermaid diagram the native client shows as source. Line by line, after aligning each line on its own text, a table row with inline code falls from 10.37% to 7.23%, and the link paragraph from 27.80% to 26.39%. Running text that does not overlay the web's glyph for glyph saturates near 45% exact, so the italic quote reads as a match in the crops (`chat-after2/top`) without moving its number.

The drop-in proof for the unpatched build: `bun run typecheck`, `bun run test` (297 pass), `tools/parity/workspace-checks.ts` (14 ok) and `tools/terminal/shell-check.ts` (9 PASS) all pass with `NAPI_RS_NATIVE_LIBRARY_PATH` set.

## Upstream drift

```sh
bun run native:check
GPUIX_COMMIT=<sha> ZED_COMMIT=<its zed pin> bun run native:check
```

`check` applies the series to scratch worktrees of the pinned (or overridden) commits. It fails with the name of the first patch that no longer applies, and it refuses a `ZED_COMMIT` that is not the gpuix commit's submodule pointer.

To move to a new release:

1. Run the check against the new commits.
2. For each failing patch, check out the new upstream in a worktree under the work dir, reapply the change by hand, and write the patch back with `git diff > patches/<repo>/<name>.patch`. Patches apply in name order, so a later patch's context includes the earlier ones: commit each patch in the worktree before you write the next.
3. Update `pins.env` and the `@gpuix/*` pins in `package.json` together, rebuild, and run `bun run native:patch-check` and the parity tools.

## Shipping the self-built addon in the .deb

Not wired yet; `bun run package:linux` still ships the npm addon. The package step that installs the runtime packages (`packaging/linux/package.ts`, step 2) leaves the addon at `node_modules/@gpuix/native-linux-x64-gnu/gpuix-native.linux-x64-gnu.node`, which the script then strips. To ship the self-built addon, copy `native/gpuix-native/build/gpuix-native.linux-x64-gnu.node` over that file before the `strip` call. The loader then picks it with no wrapper change, and `package:verify`'s `ldd` pass covers it like any other ELF file. Setting `NAPI_RS_NATIVE_LIBRARY_PATH` in the wrapper would also work, but it leaves two addons in the package and splits the choice between two files.

## Known gaps

- CSS inline padding takes layout space; the native chip's padding is paint only, so text after a chip sits about 7 px closer to it than on the web.
- The run scale is implemented for the Linux text system (cosmic-text) only. On macOS and Windows a scaled font renders at the line's size.
- `0004` does not add a selection or scroll API. A focused field that receives a new value still scrolls to the caret at the end, as a DOM input does.
- The patches carry Rust unit tests only where they are pure (`theme.rs`). `build.sh test` runs them: 39 pass for the `theme`, `style` and `markdown` modules.
