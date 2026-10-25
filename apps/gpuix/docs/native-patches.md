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
| `zed/0003-backdrop-blur` | A `Backdrop` scene primitive and `Window::paint_backdrop_blur(bounds, corner_radii, sigma, opacity)`. A backdrop is an ordering barrier: everything painted before it draws first, everything after it draws on top. The wgpu renderer ends the main pass at a backdrop, copies the frame region under it plus a 3-sigma halo, blurs it with a separable Gaussian (downsampled by powers of two until sigma is at most 4 texels, Skia's rule), and composites the result inside the rounded box. The surface is configured with `COPY_SRC` when it allows it; otherwise backdrops are skipped. Metal and DirectX skip them. | `gpuix/0005`. |
| `gpuix/0005-backdrop-blur` | The style prop `backdropBlur: <px>` (CSS `blur()` standard deviation) on `<div>` and `<text>`, painted before the element's background and children, with its border radii and opacity. Not inherited. | Tailwind `backdrop-blur-*` through `src/style/utilities.ts`: the overlay scrims (`bg-overlay/60 backdrop-blur-sm`). |
| `gpuix/0006-focus-events` | `focus` and `blur` events derived each frame from the focused handle, in the DOM's order: blur before focus, a focus event for an element focused as it mounts (`autoFocus`, `focusElement`), and blur and focus when the window loses and regains the X input focus. Upstream subscribed per element through GPUI's `on_focus`/`on_blur`, which activate only after the frame that created them and fire in creation order. | `TerminalView`'s focused cursor (its 150 ms `getFocusedElementId` poll is gone), every compat `onFocus`/`onBlur`. |
| `zed/0004-run-padding` | A per-run inline padding in GPUI's Linux text system. A font requested with the pseudo feature `tpdx` (value in hundredths of a pixel) gets that much space laid out before and after each run of it, as CSS inline padding does: the glyphs after it move, the line is wider, and wrapping, hit testing and caret positions see the space. Adjacent runs with the same padding share one box. Left-to-right text only. | `gpuix/0007`. |
| `gpuix/0007-inline-code-padding` | `<markdown>` inline code requests `tpdx` from `mdInlineCodePaddingX`, and the chip wash spans the laid-out padding instead of painting past the glyphs. | `src/chat/theme.ts`: the `0.3em` chip padding now pushes the text after a chip as the web's does. |
| `gpuix/0008-prompt-for-new-path` | `GpuixRenderer.promptForNewPath({ directory, suggestedName })`: GPUI's save dialog (`App::prompt_for_new_path`, the xdg-desktop-portal `SaveFile` request on Linux). Resolves to the chosen path, or `null` when the user cancels. | `src/launcher/file-dialogs.ts`: `DesktopHost.saveFile`, which the SFTP download uses through `dialogApi.saveFile`. Without the patch the save dialog rejects with a message naming it. |
| `gpuix/0010-table-cell-metrics` | `<markdown>` tables take `mdTableCellPaddingY` (vertical cell padding; `mdTableCellPadding` stays the horizontal one), `mdTableLineHeight`, `mdTableHeaderWeight` (default 700, as before) and the theme colour `tableHeaderBg` (a fill behind the header row). Unset, tables render as before. Numbered after G6's `0009`. | `src/chat/theme.ts`: Streamdown's 8 by 4.8 px cells on a 20 px line, the semibold header and the `bg-muted/80` + `bg-muted/35` header fill. |

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
| Unfocused input given a long value, ink above the baseline at its start | 1000 px | 0 px, only the trailing dots show (FAIL) |
| 4 px stripes beside a `backdropBlur: 8` box, distance from grey (127.5 is sharp) | 127.5 | 127.5 |
| The same stripes under the box (0 is flat) | 0.5 | 127.5 (FAIL) |
| Pixel just outside the box's 12 px rounded corner | 255 (sharp) | 255 |
| `M\`M\`M` with `mdInlineCodePaddingX: 12`, ink width minus the unpadded one (px) | 24 | 0 (FAIL) |
| `dialog-check.ts`: an open dialog picks a file, a save dialog takes a typed path, a second open is cancelled, each answered in the real GTK portal chooser with X key events | 3 PASS | no `Save File` window appears (FAIL) |
| `focus-check.ts`: focus events in an active window, 5 steps | 5 PASS | mount `autoFocus` gets no event; `focusElement(A)` after B gives `focus A` before `blur B` (FAIL) |

Parity against the web client, measured on 2026-10-25:

- Terminal SGR 3 (`tools/terminal/parity.ts --bytes tools/terminal/fixtures/italic.bin`). The perceptual diff of the italic rows against xterm.js falls from 14.87% to 12.85%; the upright control row stays at 7.23%. The slant now matches: shifting the top and bottom halves of the italic row against the web gives the same best offset (-0.75 px), against a -0.25 px offset for the upright row. A steeper skew lowers the row diff slightly (12.0% at 0.40) only by cancelling that constant 0.5 px offset, while the slant stops matching, so the oblique keeps Blink's 0.25.
- Terminal default fixture (`less`, `vim`, `done`): identical cells and pixels on both addons (2.45%, 3.61%, 10.69% exact before; 2.45%, 3.61%, 10.68% after).
- Chat transcript (`tools/chat/parity.ts`), ROI perceptual diff before and after: bottom 3.53% and 3.51%, middle 10.05% and 10.06%, top 6.04% and 5.94%. The whole-ROI number is dominated by layout offsets and the Mermaid diagram the native client shows as source. Line by line, after aligning each line on its own text, a table row with inline code falls from 10.37% to 7.23%, and the link paragraph from 27.80% to 26.39%. Running text that does not overlay the web's glyph for glyph saturates near 45% exact, so the italic quote reads as a match in the crops (`chat-after2/top`) without moving its number.

Backdrop blur against the web client, measured on 2026-10-25 with `bun run parity:matrix` on the published addon (before) and the self-built addon (after), then `bun tools/native/blur-parity.ts <before> <after> <surfaces>`. The number is the mean absolute channel difference (0 to 255) between the two clients over the scrim strip left of each dialog (x < 120 px):

| Surface | Before | After | Whole-frame perceptual diff, before and after |
|---|---|---|---|
| `palette.command-history` (`bg-overlay/40 backdrop-blur-sm`) | 3.00 | 0.51 | 1.33% and 0.33% |
| `palette.save-snapshot` (`bg-overlay/60 backdrop-blur-sm`) | 2.24 | 0.68 | 1.03% and 0.17% |
| `settings.interface` (`bg-overlay/60 backdrop-blur-sm`) | 2.29 | 0.71 | 1.22% and 0.97% |
| `settings.editor` | 2.29 | 0.71 | 1.04% and 0.87% |
| `dialogs.bug-report` (control: `ui/dialog`'s overlay has no blur on the web either) | 0.10 | 0.10 | 0.83% and 0.93% |

Tailwind v4's `backdrop-blur-sm` is `blur(8px)` (`--blur-sm`), which the shipped `dist-web` CSS confirms; the mapping follows the v4 scale (`xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 24, `2xl` 40, `3xl` 64, bare 8).

Frame cost under lavapipe (`bun tools/native/blur-cost.ts --runs 3`): a 1280x800 window redrawing as fast as it can, with a full-window `bg-overlay/60` scrim, took a median 92 ms per frame without blur and 189 ms with `backdropBlur: 8` (load average 4 to 6 from other work on the 8-core host, so single runs vary by 2x). The first, undownsampled version cost 815 ms per frame on the same scene. A rerun on the final series (5 alternating runs per sigma, a sibling perf run active, load average 4.4 to 8.9) spread from 97 to 305 ms per frame without blur (median 111) and from 132 to 563 ms with it (median 400). The spread is host contention: lavapipe rasterizes on the same CPU cores the other jobs use, and the scene's draw-time stats leave that work out. Read these as an upper bound on a software renderer, not a GPU cost. The blur runs only on frames that redraw; an open dialog with no changes costs nothing. A hardware GPU was not measured.

The browser-pane acceptance (`tools/browser/pane-check.ts`) passes all 13 checks on the self-built addon, and the app log shows the helper started with `--parent 2097153`, the id the check reads from X (`0x200001`).

File dialogs under Xvfb, measured on 2026-10-25 with `bun tools/native/dialog-check.ts`. A window manager is not needed, but a session bus is: the check (and every matrix and parity run, through `withGpuix`) starts a private `dbus-daemon` with the display in its activation environment, so GPUI's requests reach `xdg-desktop-portal` and `xdg-desktop-portal-gtk`. The GTK chooser opens as its own X window and `tools/matrix/x11-file-chooser.py` answers it with XTEST key events. On the self-built addon the open dialog returned the picked file, the save dialog returned the path typed into it, and the cancelled open resolved `null` (3 PASS). On the published addon the open dialog opened and took its answer, and no save window appeared (FAIL). The real dialog also drives the matrix's `composer.attach`.

The drop-in proof for the unpatched build: `bun run typecheck`, `bun run test` (297 pass), `tools/parity/workspace-checks.ts` (14 ok) and `tools/terminal/shell-check.ts` (9 PASS) all pass with `NAPI_RS_NATIVE_LIBRARY_PATH` set.

Focus under Xvfb, measured on 2026-10-25 with `bun tools/native/focus-check.ts`. The published addon delivered focus and blur for a plain `focusElement` switch and for window (de)activation, so the 2026-10-23 report of no events at all was the harness: no window manager runs under Xvfb, nothing gives the window the X input focus, and an inactive GPUI window reports no focus changes. Two defects were real and showed in an active window too: an element focused as it mounted never got its `focus` event, and a switch back to an older element delivered `focus` before the other element's `blur`. That first defect is why the terminal's focused cursor needed the poll. The inactive-window run stays at zero events on both addons, which matches a browser: an element in a window without focus is not focused. Tools that screenshot focus state under Xvfb activate the window first (`tools/matrix/x11-focus.py`).

Inline-code padding against the web client, measured on 2026-10-25 with `tools/chat/parity.ts` on the addon before and after `zed/0004` and `gpuix/0007`. On the line "Reject `/c/` with no id" the blank columns between the chip's text and the words around it were 6 and 5 px before, 10 and 10 px after, and 10 and 9 px on the web. The ROI perceptual diff moved from 3.51% to 3.48% (bottom) and 5.94% to 5.97% (top); most of each ROI is unchanged text and layout offsets. The middle ROI holds no inline code: its GPUIX shots are identical before and after, and its number moved from 10.06% to 11.00% only because the web's Mermaid render differed between the two runs.

## Upstream drift

```sh
bun run native:check
GPUIX_COMMIT=<sha> ZED_COMMIT=<its zed pin> bun run native:check
```

`check` applies the series to scratch worktrees of the pinned (or overridden) commits. It fails with the name of the first patch that no longer applies, and it refuses a `ZED_COMMIT` that is not the gpuix commit's submodule pointer. Measured on 2026-10-25: the series applies unchanged to `@gpuix/native@0.10.0` (`9fcd628`, Zed `81c99f8`), and against `0.6.0` (`dfb83f3`, Zed `8b94def`) the check exits 1 with `DRIFT: gpuix/0003-native-window-handle.patch does not apply`.

To move to a new release:

1. Run the check against the new commits.
2. For each failing patch, check out the new upstream in a worktree under the work dir, reapply the change by hand, and write the patch back with `git diff > patches/<repo>/<name>.patch`. Patches apply in name order, so a later patch's context includes the earlier ones: commit each patch in the worktree before you write the next.
3. Update `pins.env` and the `@gpuix/*` pins in `package.json` together, rebuild, and run `bun run native:patch-check` and the parity tools.

## Shipping the self-built addon in the .deb

`bun run package:linux` ships the self-built addon by default. After it installs the runtime packages, it copies `native/gpuix-native/build/gpuix-native.linux-x64-gnu.node` over `node_modules/@gpuix/native-linux-x64-gnu/gpuix-native.linux-x64-gnu.node`, then strips it. The loader picks it up with no wrapper change, and `package:verify`'s `ldd` pass covers it like any other ELF file. The summary line names the addon it shipped: `"nativeAddon":"self-built"` or `"npm"`.

| Flag | Result |
|---|---|
| none, or `--native-addon self-built` | The self-built addon. If `bun run native:build` has not run, the script prints an error banner and ships the npm addon; the summary says `"npm"`. |
| `--native-addon npm` | The npm addon, with no error. |

To prove the packaged addon carries the series, run the patch check on the file `package:verify` extracts:

```sh
bun run package:linux --out /tmp/pkg --server-bin <termul-server> --webview-host <termul-webview-host>
bun run package:verify --deb /tmp/pkg/termul-gpuix_<version>_amd64.deb --root /tmp/pkg-verify
NAPI_RS_NATIVE_LIBRARY_PATH=/tmp/pkg-verify/install/opt/termul-gpuix/node_modules/@gpuix/native-linux-x64-gnu/gpuix-native.linux-x64-gnu.node \
  bun run native:patch-check
```

Measured on 2026-10-25 with the full series (`zed/0001` to `0004`, `gpuix/0001` to `0007`): the .deb is 61,225,856 bytes (58.4 MiB, 222.6 MiB installed), `package:verify` passes 11/11, the browser helper starts with `--parent 0x200001` (patch `0003`), and the patch check passes all 11 rows, blur, run padding and focus events included, on the stripped 39,002,496-byte packaged addon.

## Known gaps

- Backdrop blur is wgpu only (Linux, and the web build of GPUI). The Metal and DirectX renderers skip the primitive, so on macOS and Windows the content behind stays sharp. CSS backdrop filters other than `blur()` (saturate, brightness) are not implemented.
- The blur samples with clamp-to-edge at the window border; Chromium's backdrop filter mirrors. The difference is a few pixels wide at the window edge.
- Inline-code padding (`zed/0004`) assumes left-to-right text. In a right-to-left run the space lands on the wrong side of the glyphs.
- The native markdown list puts its content column about 9 px right of the web's (marker `min_w(18)` plus an 8 px gap). With the chip padding laid out, a chip that starts a list item shows the offset as 9 px instead of 5 px.
- The run scale is implemented for the Linux text system (cosmic-text) only. On macOS and Windows a scaled font renders at the line's size.
- `0004` does not add a selection or scroll API. A focused field that receives a new value still scrolls to the caret at the end, as a DOM input does.
- The patches carry Rust unit tests only where they are pure (`theme.rs`). `build.sh test` runs them: 39 pass for the `theme`, `style` and `markdown` modules.
