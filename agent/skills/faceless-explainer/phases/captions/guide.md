# Captions (Phase 4a.5) - deterministic, no subagent

Captions are produced by **two deterministic scripts** that hand off to each other and emit `compositions/captions.html`; `assemble-index.mjs` then mounts it in `index.html` as a **track-12 clip**. There is **no captions LLM agent** (removed). The entire caption path uses zero LLM calls, so the old class of render-time footguns from "agent hand-writes captions.html" (§6 Illegal invocation / timeline not registered / raw colors / two groups on screen / fitText not wired) is eliminated.

```
captions.mjs group       -> caption_groups.json          (word engine: clean/group/classify/global timing/scene+surface)
captions.mjs html        -> compositions/captions.html   (HTML engine: choose skin + inject words + brand-tokenize + self-check)
assemble-index.mjs       -> if file exists, mount track-12 clip (data-composition-id="captions", data-start=0, data-duration=total)
```

Captions remain an **independent file + sub-composition** (not inline), so the **studio caption editor** (recognizes `.caption-group` + fetchable caption source file) and runtime `captionOverrides` (recognizes `.caption-group/.caption-word`) both continue to work.

---

## 0. Inputs

The following are inputs for `captions.mjs html`; the input for `captions.mjs group` is `group_spec.json` (see §1).

| File                                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caption_groups.json`                               | **Single source of truth for word data**: `groups[]` (`id`/`scene_id`/`surface`/`start`/`end`/`text`/`words[]`, global seconds, cleaned, classed), `total_duration_s`, `stats`. Produced by `captions.mjs group`.                                                                                                                                                                                                             |
| `design-system/chunks/tokens.css`                   | Brand DNA (`--font-display`/`--font-body`/`--brand-primary`/`--canvas`/`--ink` + surface aliases). Used at build for the canvas-measure `FONT_FAMILY` and to validate brand-strict colors; the tokens themselves are declared once globally in `index.html`'s `<head>` (by `assemble-index.mjs`) and inherit into `captions.html` when it mounts, so the per-file `<style data-brand-tokens>` block is stripped before write. |
| `design-system/inference.json` (optional)           | Used for skin scoring (site DNA / selected preset vibe). If missing, fall back based on brand color lightness/darkness.                                                                                                                                                                                                                                                                                                       |
| `design-system/chunks/caption-skin.html` (optional) | **Preset-provided caption skin (first source)** - when the selected preset places `caption-skin.html` in `style-presets/<preset>/`, `emit-chunks` copies it here. **If present -> prefer it** (prebaked, already tokenized; see §2); absent -> fall back to registry scoring.                                                                                                                                                 |

---

## 1. Run (orchestrator runs Bash directly in Step 5.5, before scene fan-out)

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/captions.mjs group \
  --group-spec ./group_spec.json --hyperframes . \
  --tokens design-system/chunks/tokens.css --out ./caption_groups.json)

(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/captions.mjs html \
  --hyperframes . --groups ./caption_groups.json \
  --tokens design-system/chunks/tokens.css \
  --inference design-system/inference.json \
  --out compositions/captions.html)
```

**flags (`captions.mjs html`)**: `--skin caption-<name>` forces a skin (supported set only); `--no-emit` only scores + writes `caption_skin_scores.json`, without installing/generating; `--skin-file <path>` uses a predownloaded skin (offline/CI, skips `npx hyperframes add`).

**skip code (exit 0, not an error)**: `captions: skipped (<reason>)` - no caption groups / no brand tokens. In this case captions.html is not generated, assemble-index does not mount track 12, and the video still renders normally, just without captions.

---

## 2. Source Priority + Supported Skin Set

**First source - preset-provided**: if the selected preset has `chunks/caption-skin.html` (copied by `emit-chunks` from `style-presets/<preset>/caption-skin.html`), `captions.mjs html` **prefers it**. It is a prebaked, brand-tokenized skin; the script only performs **generic fill-in** (inject `var GROUPS` / `var DURATION` / `data-duration` + inline `tokens.css`), with no per-preset code. `--no-preset-skin` disables it, and `--skin <registry>` can still force a registry skin. `design.html` also embeds it as **§C live preview** (see design-system/guide.md). **Only when `caption-skin.html` is absent** does it fall back to scoring the closed registry set below.

**Second source - closed registry set. Two skins have been reviewed in** (script `SKINS` table `supported: true`):

| Skin                   | Readability                                                | Selection condition (`scoreSkins`)                                                                 |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `caption-pill-karaoke` | Built-in opaque pill (no scrim needed)                     | **Safe default**. Wins when `voice_tone` = warm/neutral/missing; any tie falls back to it          |
| `caption-highlight`    | Transparent -> transform injects a brand-strict scrim band | Wins when `voice_tone` = **direct** (+2); loud presets (neo-brutalism/raw-grid/...) get another +1 |

Both satisfy: canonical `.caption-group/.caption-word` (recognized by studio + captionOverrides; highlight adds its own `.hl-*` classes **alongside** the canonical classes), tokenizable CSS colors, bottom placement, and runtime grouping that can be bypassed. `scoreSkins` scores with `site_dna.voice_tone` + `selected.name` from `inference.json`, is **deterministic**, and ties always return pill-karaoke. `--skin <name>` force-overrides scoring.

Other skins each have skin-specific blockers and must be reviewed in **one by one** according to a descriptor (see the `SKINS` table in the script + the corresponding transform branch). **Do not** assume plug-and-play:

| Skin                    | Blocker                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| neon-accent / emoji-pop | Colors/glow are computed in **JS with parseInt(hex)** -> cannot be mechanically tokenized; keywords/emoji are hard-coded English word lists (animations go silent for other products) |
| weight-shift            | No `.caption-word` class (animation acts on the line) -> studio detection gap                                                                                                         |
| clip-wipe               | `.wp-*` class names + RAW_GROUPS/KEYWORDS are **hard-coded by index**                                                                                                                 |
| editorial-emphasis      | Captions are at `top:580px`, in the **middle of the canvas** -> incompatible with the bottom caption-band model                                                                       |

If `--skin` points to an unsupported skin, the script exits 1 and prints the concrete reason.

---

## 3. Deterministic Skin Transformations Performed by `captions.mjs html` (pill-karaoke example)

The script reads the downloaded skin file and performs **asserted string transforms** according to the descriptor (if any handle is missing = registry drift = loud exit 1; never silently emit empty captions):

1. Remove Google Fonts `<link>` (brand @font-face is injected into `index.html` by assemble-index; the flattened sub-composition can use it inside that document).
2. Remove demo `<video>` placeholder + its dead CSS.
3. host `data-composition-id="caption-pill-karaoke"` -> `"captions"`; `data-duration="8"` -> `total_duration_s`.
4. **`var DURATION = 8` -> `total_duration_s`**. Otherwise the skin's `normalizeWords` clamps every word's `end` to 8s -> captions are broken after 8 seconds in a 60-90s video.
5. **Inject engine groups**: `var GROUPS = <caption_groups groups>`, bypassing the skin's built-in `normalizeWords` + scene-agnostic `makeGroups`. Engine groups are already in global seconds, scene-aware, and non-overlapping - this single step solves both "words clamped to 8s" and "captions cross scene cuts."
6. Change per-word karaoke from **editing color values** to **toggling `.is-active` class** (CSS tokens provide color): `.caption-word { color: color-mix(--ink 45%, --canvas) }`, `.caption-word.is-active { color: var(--ink) }`. GSAP cannot interpolate `var()` colors; class flips are both brand-strict and readable.
7. **Double rename**: host `data-composition-id` and `window.__timelines["caption-pill-karaoke"]` are **both** changed to `"captions"` (compositionScoping only remaps writes when timeline key === inner root composition-id; both must change so it lands at `__timelines["captions"]`).
8. Full-film tail anchor `tl.to({}, { duration: DURATION }, 0)`, so the sub-composition timeline duration equals the host clip duration.
9. Inline `tokens.css` into `<style data-brand-tokens>`; tokenize hard-coded CSS colors/fonts: pill bg `#e7e5e7` -> `var(--canvas)`, shadow `rgba(0,0,0,.12)` -> `color-mix(in srgb, var(--ink) 14%, transparent)`, font `"Poppins"` -> `var(--font-display)` (the JS `FONT_FAMILY` for measureText uses the real family name extracted from tokens.css, because canvas text measurement cannot use `var()`).

**Readability (for this skill = visual keep-out + band)**: pill-karaoke has a built-in **opaque pill** (`background: var(--canvas)` + active text `var(--ink)` -> constant contrast), so it needs **no** scrim and **no** render-time contrast probe. Transparent skins (such as caption-highlight) must add a brand-strict gradient scrim band as the first child of the caption root (`color-mix(var(--ink) ...)`, z-index below `.caption-group`). Scene foreground keeping the upper ~83% clear is enforced by `hyperframes-scene.md` constraint #13 + visual-design briefs (see those two places), not by this script.

### 3b. Differences / Extra Transformations for caption-highlight

highlight (TikTok-style per-word red background sweep) uses an **independent transform branch** from pill. Differences:

1. **No demo `<video>` element** (only dead `#hl-video` CSS) -> do not remove an element, only remove that dead CSS rule.
2. **Different grouping data shape**: its build/timeline loop consumes a **flat global `WORDS` array** + `GROUPS` index ranges `{wordStart,wordEnd,start,end}` (word element id = `wordStart+i`). The transform flattens engine groups into these two structures, and **also** removes demo `TRANSCRIPT` plus the **index-hard-coded `RAW_GROUPS`** (the same blocker as clip-wipe, structurally solved in this new branch).
3. **Parallel classes**: add canonical `.caption-group`/`.caption-word` **alongside** `.hl-group`/`.hl-word` (preserves built-in animation while letting studio/captionOverrides recognize them).
4. **Scrim band**: because it is transparent, tokenize the full-screen first child `.hl-overlay` (z-index 1, below words at z-index 10) into a bottom brand-strict gradient band (`color-mix(var(--ink) ...)`).
5. **Adaptive contrast (critical)**: active words sit on a solid `var(--brand-primary)` fill, and **the primary color lightness is unknown at build time** (deterministic script cannot measure color and does not gamble on `contrast-color()`) - therefore **no single text color** is always safe on it (canvas washes out on light primary colors; ink washes out on dark primary colors). Solution: text fill `var(--canvas)` **+ 8-direction `var(--ink)` stroke** (plus a soft ink shadow). Readability no longer depends on primary-color brightness; it rides on the **guaranteed-contrast `canvas↔ink` pair**: light primary -> ink stroke outlines it, dark primary -> canvas fill pops, any primary color stays clear. Inactive words on the scrim follow the same idea (stroke defines shape).
6. **Color tokenization**: red gradient `#ff1745→#df1238` -> `var(--brand-primary)` (dark end `color-mix(... var(--ink))`) while preserving solid fill; red shadow -> `color-mix`; text shadow -> ink stroke described above; `"Montserrat"` -> `var(--font-display)` (canvas measureText uses the real family name extracted from tokens).
7. **Geometry**: 80px uppercase @ `bottom:140px` reaches ~y845 (above the reserved band) -> shrink to 46px @ `bottom:36px`, so 1-2 lines both land inside the keep-out band (y900-1080).
8. Double rename -> `"captions"` + full-film tail anchor (same as pill steps 7/8).

**self-lint**: common gates + skin-specific gates (pill / highlight each have dedicated assertions) are described in §4.

---

## 4. Node Structure Self-Check (replaces old browser self-lint)

Before writing, `captions.mjs html` asserts the produced artifact (`check-compositions.mjs` does not scan captions.html, so this is the only structure gate). Any failure exits 1.

**Common gates**: `data-composition-id="captions"` exists, literal `window.__timelines["captions"]` exists, `.caption-group`/`.caption-word` exist, placeholder string "Every great video starts" is gone, demo video is gone, no Google Fonts link, **no `window.getComputedStyle(`/`requestAnimationFrame(`/`matchMedia(`**, `DURATION === total_duration_s`, brand-strict (after removing `<style data-brand-tokens>`, zero raw hex/rgb).

**Skin-specific gates**: pill - no `#avatar-video`, `var DURATION` rewritten; highlight - no `RAW_GROUPS` residue, no `<video>`, full-film tail anchor present.

---

## 5. Failure Modes

| Symptom                                         | Root cause                                                                | Fix                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captions: skipped`                             | No caption_groups / no tokens.css                                         | Normal - do not mount track 12; video still renders                                                                                                |
| `transform "...": expected literal not found`   | Registry skin changed; handle drift                                       | Compare against new skin source and update that skin's descriptor / transform strings in the script                                                |
| `self-lint: brand-strict violation`             | Color/font not tokenized (common when adding skins)                       | Add tokenization mappings for that skin; skins that compute colors in JS with parseInt(hex) (neon/emoji) cannot be mechanically tokenized - see §2 |
| `--skin "..." not yet supported`                | Points to an unreviewed skin                                              | Use the supported set, or write a descriptor + transform for that skin according to §2/§3                                                          |
| `npx hyperframes add ... failed`                | Offline / no registry                                                     | Pass `--skin-file <downloaded skin>`                                                                                                               |
| Captions break after 8 seconds                  | (Regression) DURATION was not rewritten                                   | Self-check already asserts `DURATION === total`; confirm transform step 4 matched                                                                  |
| Captions cross scene cuts / two groups onscreen | (Regression) used the skin's built-in makeGroups instead of engine groups | Confirm transform step 5 matched (inject engine GROUPS)                                                                                            |

---

## 6. Acceptance

Render a 60-90s captioned video and verify: 1. captions remain correct after 8s (DURATION/full-film tail anchor); 2. per-word highlight works and does not overlap across scenes (engine groups); 3. readable on both dark/light themes (pill built-in contrast / highlight scrim band); 4. scene foreground stays in the upper ~83%, backgrounds remain full-bleed (keep-out); 5. studio recognizes `.caption-group`; 6. node self-check has zero failures; 7. `--no-emit` skin selection can be reviewed (neutral -> pill, direct -> highlight); 8. `--skin caption-highlight` can be forced and renders.
