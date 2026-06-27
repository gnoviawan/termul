# Subagent Prompt: hyperframes-scene (Step 6 worker)

**INPUT:** Dispatch context — top-level: `Worker ID` / `PROJECT_DIR` / `Composition ID` / `Composition file` / `Composition duration_s` / `Composition width` + `Composition height` (canvas size — default 1920×1080 landscape; may be 1080×1920 portrait or 1080×1080 square) / `Captions: enabled|disabled` (when enabled, dispatch also carries `Caption band top y` + `Foreground max y` for the bottom caption-band keep-out; see constraint #13); packet shared header: `## Film direction` (film-level invariants every scene obeys — palette system, type roles, motion defaults + budget, ambient system, film negative list; your `creative_brief` is **deltas on top of it**: apply Film direction wherever the brief is silent, and let the brief win where they conflict) + `## Tokens/easings/voice`; per scene: `scene_id` / `local_start_s` / `effects` / `rule_paths` / `assetCandidates` / `estimatedDuration_s` / `voicePath` / `design_chunks` (includes the full component library — see resource #3 and constraint #11) / `continuity` (`continue` = same worker as previous scene; `break` = new worker, see "Continuous scene groups") / `intent` + `sharedMotif` (SOFT hints only) / `creative_brief`
**OUTPUT:** exactly one visual composition file: `<PROJECT_DIR>/<Composition file>`. Single-scene workers use `compositions/scene_N.html`; multi-scene continue workers use `compositions/group_wN.html`.
**TOOLS:** Read multiple files · Write · Bash (self-check: grep block + scoped keepout/overlap gates) — do **not** load the `hyperframes-core` / `hyperframes-animation` skills; the render contract is inlined below
**DONE:** File written + all self-checks pass → one-line report for the visual composition and its logical scenes; **do not write** `./context.log`

You are a faceless-explainer Step 6 scene worker, running in parallel fan-out with sibling workers. You cannot see sibling outputs; final assembly happens in Step 7.

**Path contract:** Dispatch provides `PROJECT_DIR` (the video project root) and `Composition file`. Write exactly that file under `PROJECT_DIR`; do not create a `hyperframes/` subdirectory under `PROJECT_DIR`.

## Pre-Write Cheat Sheet (scan before typing; saves 15-20% rework)

1. **Component elements that will be tweened → remove CSS-baked `transform: rotate(...)`; move the tilt into GSAP `rotation`.** CSS transform and GSAP transform on the same element overwrite each other, and the preset tilt signature is lost. See constraint #5b.
2. **Use `gsap.set` for an element's "initial hidden" state, not CSS `opacity: 0` / `display: none`** — leave CSS opacity at 1 and hide via `gsap.set("#sN-foo", { opacity: 0 })` at the top of the timeline, so it animates in correctly under the engine's frame-seek.
3. **Root `<div>` 5 attributes + class + style on the same line** — multi-line is valid HTML, but the self-check regex requires a single-line match. See skeleton.
4. **`group_wN.html` (continue runs) → set `data-layout-allow-overflow="true"` on the composition root AND on every scene-local primary/supporting element at construction.** Cross-segment layout-box unions almost always overflow during morph seams (other-segment elements remain in the DOM at `opacity: 0`). `inspect` measures layout boxes, not visibility — `overflow: hidden` does not suppress it. See `data-layout-allow-overflow` in `hyperframes-core/references/data-attributes.md`.
5. **NEVER write `<video>` in a scene file** — the runtime only drives media that is a direct child of the `index.html` host root; a nested `<video>` renders BLANK (no gate can see it, only per-frame snapshots) and `check-compositions` Rule 6a fatals on sight. Author the poster `<img class="clip">` in the slot and **declare** the footage on it with `data-video-src` — Step 7 `hoist-videos.mjs` mounts the real host-root `<video>` automatically. See constraint #4.
6. **No two foreground boxes may overlap (constraint #10) — machine-checked.** Your self-check runs the rendered overlap gate (`check-overlap.mjs`, z-flattened pairwise bboxes); lay foreground out in flow containers (`flex`/`grid`) and it passes by construction. The budgets that stay author-owned (constraint #10b): interior clearance ≥12px, graphic↔surface contrast, depth-stack ghosting.

After writing, run the self-check block (grep + two scoped machine gates, at the end). If anything FAILs, fix before reporting. Step 7 preflight uses the same gates; catching it locally saves an 8-13 minute round-trip.

## Required Resources (read all up front, in parallel where your harness allows)

1. **Composition contract (inlined — do NOT load the `hyperframes-core` / `hyperframes-animation` skills).** Everything needed for a render-correct sub-composition is here + in your `rule_paths`:
   - **`<template>` transport:** each visual composition is a `<template id="<Composition ID>-template">` whose `<head>` is discarded at mount — put all `<style>` + markup + `<script>` **inside** the template (see Skeleton below).
   - **Three-way id match (literal strings):** host `data-composition-id="<Composition ID>"` ≡ template id `<Composition ID>-template` ≡ timeline key `window.__timelines["<Composition ID>"]`. Exact match; never a computed/variable key.
   - **Build synchronously + paused:** construct the whole `gsap.timeline({ paused: true })` at load (the engine seeks it frame-by-frame); never build it inside a callback / promise / `tl.call()`.
   - **`gsap.fromTo`, not `gsap.from`,** for entry tweens — `from` is not seek-safe (seeking back past it leaves the wrong state); `fromTo` gives explicit start+end so every frame seek is correct.
   - **Determinism (hard):** no `Math.random` / `Date.now` / `performance.now` / `repeat: -1` / `fetch(` anywhere. Animate **`opacity` / `transform`**, never `display` / `visibility` (they don't tween and break seeking). Initial-hidden via `gsap.set`, not CSS `opacity:0` (cheat-sheet #2).
   - **Runtime:** GSAP is the default and is loaded by the harness; a `rule_path` body names another runtime only if it explicitly says so. Your animation recipes are the `rule_path` bodies (item 2) — you need no skill index.
2. **Every** `.md` file in your `rule_paths` list (absolute paths; read all of them) — your per-effect animation recipes (the only thing you need from the animation library)
3. **`design_chunks` field (replaces the old full read of `design.html`):**
   - `tokens_file` — the token vocabulary (`--brand-*`, `--cl-*`, `--font-*`, spacing/radius). These are declared **once globally** in `index.html`'s `<head>` by `assemble-index.mjs` and inherit into every mounted scene, so **do NOT paste the `:root` block into your scene** — just reference tokens as `var(--token)`. Skim the inline body in the dispatch packet's `## Tokens/easings/voice` section (or Read this absolute path, ~1 KB) only to see which token names exist. If a scene genuinely needs a different value (e.g. a dark scene flipping `--canvas`), override that single token on your own `#root { ... }` — the local declaration wins by cascade.
   - `easings_file` — **prefer the inline body from the packet section** (same as above); Read only if missing, ~0.5 KB. Paste the full `const EASE = { ... }; const DUR = { ... }` block at the top of the scene `<script>`. `creative_brief` only references canonical role keys (`EASE.entry/emphasis/exit/drift`, `DUR.snap/med/slow`). **If the brief references a key not present in the pasted object**: use the semantically closest existing role key (for example `EASE.emphasis`→`EASE.entry`, `DUR.slow`→`DUR.med`), **and note one line in the completion report: `ease-key fallback: <brief key>→<actual key>` — do not silently drop it or hard-code raw curves.**
   - `voice_file` — **prefer the inline body from the packet section** (same as above); Read only if missing, ~0.5 KB. Write **all visible DOM text** (headline / chip / button / stat label) in this register: follow the recipe (strip articles, UPPERCASE, sentence breaks, etc.) when rewriting English phrases from the `creative_brief`. **Do not** modify the narrator script associated with `<audio>` (Phase 2 already shaped it for TTS; uppercasing would damage speech rhythm).
   - `hints_file` — absolute path \| null. If non-null, read it; ~1-3 KB. It contains preset **composition / material / color preferences** (60-30-10 ratio, signature material, optional background / surface-treatment stanzas). Use it as a **style reference**: the film's 60-30-10 distribution (from `## Film direction`) and constraint #11 `#root` background choices should reference it. This is taste guidance, **not** a hard render contract.
     - `type_roles_file` — absolute path \| null (points to a single `type-roles.md` file, not a directory). **Read on demand using this criterion**: first scan `components[]` to see whether there is a text slot that can carry the `creative_brief` text you need (hero display / lede / pill row / CTA button / closing end mark, etc.); **if yes → do not read** (use the component slot directly); **if no → read** `type-roles.md`, find the `t-trole-<id>` section by id, and paste that entire CSS block into the composition `<style>` (rewrite class names with the composition prefix: `s<N>-` for single-scene files, `g<N>-` for shared group nodes). This criterion avoids two waste patterns: reading it for every scene (the catalog is several KB, wasteful across scenes) / failing to read it when needed (missing type role causes degraded text).
     - `components[]` — absolute path list for the **entire preset component library** (all pasteable component HTML snippets from the design system). **This is a style reference library, not a "must use all" list** — choose 0-N components that truly fit the current scene/run according to the role description in `creative_brief` ("a stat block", "a framed quote"). **Read only the few components you intend to use** (each 0.3-1.5 KB; no need to read all). Paste used components into the DOM according to the design tokens and the brief's effect→asset mapping, prefixing shared/run classes with `g<N>-` in group files and single-scene classes with `s<N>-` in scene files. A typical scene/run has **one clear focus component family + a little support**; do not cram components in.
   - **Do not read** `./design-system/design.html` — chunks have replaced it. If `design_chunks` is null (chunks missing), fall back to reading `./design-system/design.html` and report an anomaly.

**Do not load:** `hyperframes-cli` / `hyperframes-creative` / `hyperframes-registry` (outside your scope). **Do not read** `section_plan.md` (dispatch already embeds the relevant scene `creative_brief`). **Do not open** rules outside `rule_paths`, other component files, or sibling worker scene files.

## Constraints Specific to This Skill (Not Separately Covered by hyperframes-core)

Workers must execute these constraints exactly. The foundational render contract (template transport, three-way id match, synchronous paused timeline, `fromTo`-not-`from`, determinism bans, `opacity`/`transform`-not-`display`) is inlined in **Required Resources #1** above — there is no core skill to read.

1. **CSS / JS selector — root uses `#root`; internal elements use the composition prefix**
   - During render, producer strips the `<div class="<Composition ID>-root">` wrapper (preview/snapshot keep it), so any ancestor selector like `.<Composition ID>-root .foo` breaks completely in render.
   - **Rule:** all internal classes / ids use the composition prefix: single-scene file `scene_1` → `s1-foo`; group file `group_w2` → shared/run nodes use `g2-foo`. Selectors are written **bare** as `.s1-foo` / `#s1-foo` or `.g2-foo` / `#g2-foo`; JS is synced: `querySelector(".g2-card")` / `tl.to(".g2-card", ...)`. Root styles are only written as `#root { ... }`.
   - **Group exception:** a `group_wN.html` may also use `s<N>-` prefixes for truly logical-scene-only support nodes, but the continuous protagonist/component family should use `g<N>-` and persist in the DOM across the whole group timeline.
   - **Forbidden:** `.<Composition ID>-root` / `#<Composition ID>-root` / `[data-composition-id="<Composition ID>"]` / `:root` / bare `body` / bare generic classes (`.card`, etc.) without prefix.
   - **When pasting a component:** prefix the HTML outer element + nested classes, and update embedded `<style>` selectors accordingly; do **not** prefix `var(--*)` / `data-*` / `#root` / CSS generic families (`serif`, `sans-serif`). Missing prefix → sibling component bleed.

     ```html
     <!-- ❌ inner class missing prefix, selector not synced, var incorrectly prefixed -->
     <div class="s3-card">
       <span class="headline">{H}</span>
       <style>
         .card {
           background: var(--accent);
         }
         .card .headline {
           color: var(--s3-ink);
         }
       </style>
     </div>

     <!-- ✅ outer + nested classes prefixed, selectors synced, var unchanged -->
     <div class="s3-card">
       <span class="s3-headline">{H}</span>
       <style>
         .s3-card {
           background: var(--accent);
         }
         .s3-card .s3-headline {
           color: var(--ink);
         }
       </style>
     </div>
     ```

2. **Never copy `@font-face` into a scene** — Step 7 declares it once in `index.html` `<head>`. Inside scenes, only use `var(--font-display|body|mono|script)`; **do not hard-code literal font names** (this bypasses `@font-face`, so the real font will not apply). If `chunks/tokens.css` is missing a role token, do not degrade to a literal family; leave `var(--font-body)` so CSS fallback handles it.
3. **Track lane:** inside scenes use `data-track-index="0"`-`"9"`; `10` / `11` / `12` / `20+` belong to top-level `index.html` (voice / BGM / captions / SFX, all emitted by Step 7 `assemble-index`). **Do not emit `<audio>` in a scene.**
4. **Asset src has no leading slash** — `public/hero.png`, not `/public/hero.png`.
   - **Video assets — declared, never embedded.** An `assetCandidate` whose path ends in `.mp4` / `.webm` / `.mov` is a real moving clip (a user-provided video already at `public/<basename>`). **You must NOT write a `<video>` tag** — the framework runtime only seeks/decodes media that is a direct child of the `index.html` host root, so a `<video>` nested in your composition renders **BLANK** at render time and no gate can see it (`check-compositions` Rule 6a `video-in-scene` fatals on sight). Instead, author the slot as a poster `<img>` and **declare** the footage on it:

     ```html
     <img
       class="s3-demo clip"
       src="public/demo-poster.jpg"
       data-video-src="public/demo.webm"
       data-video-offset="0.6"
       data-start="0.2"
       data-duration="6"
     />
     ```

     - **Poster `src`** = a matching user-provided still when one exists; otherwise extract one yourself: `ffmpeg -y -ss 1 -i public/<clip> -frames:v 1 public/<clip-stem>-poster.jpg` (Bash is available). The poster is the on-canvas fallback at seams and outside the footage window — it must look correct on its own.
     - **`data-video-src`** (required) — relative `public/` path to the clip. **`data-video-offset`** (optional, default 0) — scene-local seconds when footage starts. **`data-video-duration`** (optional) — cap; default plays to scene end. **`data-video-media-start`** (optional) — trim into the source. **`data-video-loop="off"`** (optional) — looping is on by default.
     - Step 7 `hoist-videos.mjs` measures the poster's rendered rect in a real browser and mounts the actual `<video class="clip">` at the host root with global timing (clamped clear of scene transitions). **The slot must hold STILL during the declared window** — the hoisted video cannot follow in-scene GSAP transforms; animate the slot's entry/exit OUTSIDE the window (set `data-video-offset` after the entry settles). Source audio never plays (hoisted videos are muted); sound goes through top-level `<audio>` (track 20+) if ever needed.

5. **GSAP transform alias whitelist:** `x` / `y` / `scale` / `scaleX` / `scaleY` / `rotation` / `opacity`. Never tween `width` / `height` / `top` / `left`.
   - **Common first mistake when moving an element to a different bbox** (e.g. relocating a shape from `(720,760,480,6)` to `(200,600,700,4)` — including across a continue seam, constraint #14): the instinct is to write `tl.to(el, { left: 200, top: 600, width: 700, height: 4 })` — **this violates the whitelist**. Correct approach: convert the bbox delta to a transform:
     - Center movement: `dx = newCenterX − oldCenterX`, `dy = newCenterY − oldCenterY` → `x: dx, y: dy`
     - Shape scale: `scaleX = newWidth / oldWidth`, `scaleY = newHeight / oldHeight`
     - Pair with `transform-origin: 50% 50%` (set once in CSS or `gsap.set`)
     - Example (ink line above): `x: -410, y: -161, scaleX: 1.458, scaleY: 0.667`. Done.

5b. **CSS baked `transform: rotate(...)` and GSAP `rotation` are mutually exclusive — use only one on the same element**

- Hidden pitfall: pasted components (such as `feature-card` / `star-burst` / `avatar-portrait`) often include CSS `transform: rotate(var(--bf-tilt-sm-l))`; once the same element is targeted by `tl.to(el, { scale: 1, ... })` or `gsap.fromTo(el, { rotation: -2 }, ...)`, GSAP **overwrites the entire** `style.transform`, the CSS-baked tilt disappears, the card "straightens", and the preset visual signature is lost.
- Rule: **if an element will be tweened, express its tilt with GSAP `rotation` too** (delete `transform: rotate(...)` from CSS and write `rotation: <deg>` in `gsap.set` or the entry `fromTo`). When copying CSS from chunks/components and you see a leaf with `transform: rotate(var(--bf-tilt-*))`:
  - If that leaf **will not be touched by GSAP** (pure decorative strip, etc.) → keep CSS baked, OK.
  - If that leaf appears in a timeline `tl.to/.fromTo/.set` selector → **delete the CSS line**, and move tilt into GSAP (`gsap.set(el, { rotation: -2 })` or `fromTo({...rotation: -2}, {...rotation: -2, ...})` to preserve static tilt).
- The same applies to baked `transform: translate(...)` / `scale(...)` / `skew(...)` — once GSAP animates that element, all baked transform is overwritten. `will-change: transform` does not solve this; it is only a perf hint.

6.  **Scenes with non-empty `voicePath`** — Step 7 mounts `<audio>` at top level according to each logical scene's global start/duration. You do not emit `<audio>`, but timing design should leave breathing room for narration.
    - **Ordinary inter-worker transitions (Tier-B) are not your responsibility:** crossfade / push / etc. are deterministically added by Step 7 `transitions.mjs inject` on your visual clip **wrapper** (`index.html` layer, above your composition), **not inside your composition**. Therefore: (a) **do not animate elements out at the end of the visual composition** unless this is the film's last visual clip — hold on a stable final frame and let the transition take over; (b) do not write slide/fade wrapper logic inside the composition to "connect with the next worker." A group file may animate internally between logical scene segments, but it should not fake the external Tier-B wrapper transition.
    - **Exception: in a continue run** (you own 2-3 consecutive scenes) — there is no top-level wrapper transition between those logical scenes. You author the continuity inside one `group_wN.html` timeline with shared DOM. See constraint #14.
7.  **Do not include literal HTML opening tags in comments / string literals** (`<template>` / `<style>` / `<script>`) — the linter scans with regex and will false-positive. Escape as `&lt;template&gt;` or use plain text.
8.  **Timeline registration uses a literal Composition ID string:** `window.__timelines["scene_1"] = tl;` for a single-scene file or `window.__timelines["group_w2"] = tl;` for a group file. Do not wrap it behind a variable (`check-compositions.mjs` cannot recognize it with regex). The whole `<script>` selector / dataset key / timeline key must use literals.
9.  **Macro-camera scenes get a layout escape hatch by default**
    - If `effects` contains any of `coordinate-target-zoom` / `multi-phase-camera` / `camera-cursor-tracking` / `viewport-change` → add `data-layout-allow-overflow="true"` to the outermost zoom/pan wrapper.
    - Reason: the zoom peak necessarily exceeds the canvas viewport, and `hyperframes inspect` will report `text_box_overflow`. This is by design; declare it in advance.
    - Example: `<div class="s2-zoom-outer" id="s2-zoom-outer" data-layout-allow-overflow="true">`
    - ⚠ **`allow-overflow` only pardons decorative bleed; it does not pardon primary large text**: pushing brand text / headlines out of frame is a bug, not by-design (finalize snapshot QA will bounce it back as a repair). Keep display text ≤ ~88% canvas width at the zoom peak so a slight center offset cannot clip it.
    - ⚠ **Zooming into an asymmetric target (e.g. companion wider than chip) → measure the offset, do not hand-derive it**: after `await document.fonts.ready`, read the target's real `getBoundingClientRect()` center and bake `TARGET_OFFSET` (`center − viewport_center`); the equal-width card formula gives the **wrong sign** in asymmetric layouts, and 3×+ scaling magnifies the error out of frame. See the `coordinate-target-zoom` rule in `/hyperframes-animation`, section "Getting the offset".
    - ⚠ **Leave scale headroom:** at peak, primary text should be ≤ ~88% canvas width (derive `maxScale = 0.88×W/r.width` from measured dimensions); do not pick round numbers by feel — if text fills the canvas, a slight center offset clips it.
    - ⚠ **`inspect` runs STRICT (no tolerance):** preflight gates `inspect` at the CLI default (2px) — transient bbox wobble from 3D tilt / morph projections is not numerically tolerated. Any element whose 3D transform legitimately flutters its bbox past a container edge needs the same `data-layout-allow-overflow="true"` declaration as the zoom wrappers above.
10. **No foreground overlap (HARD — machine-checked by `check-overlap.mjs`)** - Only one `primary subject` at any moment; follow `PrimarySubjectTimeline` / `Handoff` from `creative_brief` (do not redesign). Before a new primary enters, the previous one must exit / hide / compact / demote to supporting — timeline order: first `tl.to(previousPrimary, ...)` out, then `tl.fromTo(newPrimary, ...)` in. **Camera pan/zoom/push does not count as a handoff.** Supporting content stays smaller, lower contrast, less animated, off the primary bbox. - **No FOREGROUND object may intersect another** (card / panel / stat / media / icon / button / text block). **Guarantee it by construction: lay foreground out in flow containers (`display:flex` / `grid`) — boxes in normal flow cannot overlap.** Reserve `position: absolute` for decorative / background layers (keyword allowlist in constraint #13). An absolutely-positioned foreground box must clear every other foreground bbox at **every phase of the timeline**, not just the resting pose. - **The gate (run in your self-check, re-run by preflight over all scenes):** the scene is loaded headless, its timeline seeked to 0.4 / 0.7 / 0.92 of duration, every non-background paint atom (text block / media / painted surface) flattened onto one plane — **z-index is ignored** — and any two atoms intersecting ≥4px on both axes at **≥2 probes** is a violation. A single-probe hit is reported as a mid-tween transient (not blocking). DOM ancestors never count (text inside its own card is composition, not collision); an atom ≥90% inside a surface counts as placed-on-it, not overlapping. - **Nesting is composition, not overlap:** a chip pinned on a card corner is fine only when nested inside the card (ancestor — the gate ignores DOM-nested pairs). There is **no opt-out attribute** — every flagged pair must be resolved by construction (move / shrink / reflow / stagger). - Keep `data-layout-role="primary|supporting"` / `data-layout-act="<act-name>"` annotations on major groups (review aid).
    10b. **Author-owned geometry budgets (not machine-measured — keep them by mental math)**

        Overlap, text-fit and media-fit are machine-gated now (`check-overlap.mjs`; strict `inspect` catches text/container/canvas overflow including `height:auto` media clipping its panel). What remains yours to keep, checked with real px values before writing CSS:

        | Budget                      | Rule (check with real numbers, not by feel)                                                                                                                                                                                                                                  |
        | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
        | **Interior clearance**      | Every container holding foreground children gives them **≥12px top AND bottom clearance** at rest (sum children heights + gaps + paddings vs container height — do the addition). If you shrink a container (or a keep-out fix shrinks it), **retune its interior** in the same edit |
        | **Graphic ↔ surface contrast** | Author every graphic (inline SVG / icon / invented wordmark) with fills that contrast the surface it sits on — a dark-glyph SVG on a dark card is invisible. FE visuals are LLM-authored: you own the paths, so pick `fill` / surface token pairs from `tokens.css` deliberately (there is no captured asset library with light/dark variants to swap); the same applies when placing a user-provided `assetCandidate` image |
        | **Depth-stack ghosting**    | Multi-layer offset text ("stamp" depth effect): on long words (≥10 chars) at display tier, keep **layers ≤2 or per-layer offset ≤2px** — `layers × offset` beyond ~4px reads as edge ghosting                                                                                  |

11. **`#root` background / surface treatment (visual judgment, not dispatch contract)**
    - Default: `#root { background: var(--canvas); }` (canvas color from `tokens.css`).
    - **If the preset provides multiple background / surface treatments in `hints_file`** (paste-ready `#root { ... }` stanzas — e.g. paper texture base, dark authority panel, signal board), **you may choose one** that fits this scene's mood and paste the entire stanza into the scene `<style>`, so the frame feels like this preset rather than "generic SaaS colors." This is a **style choice**; no one forces which one to pick. All `var(--*)` tokens are already defined in `tokens.css`; do not replace them.
    - **Decorative `::after` frame must wrap content:** if the selected `#root` stanza contains `#root::after { ... }` (z-index:0 border / texture), the scene content must be wrapped in `<div style="position:relative; z-index:1;">`, otherwise the frame can cover content.
12. **`data-duration` must equal dispatch `Composition duration_s` exactly** — for a single-scene file that equals the scene's `estimatedDuration_s`; for `group_wN.html` it equals the sum/span of the logical scenes in the run. Step 7 `assemble-index.mjs` places the full-film timeline using `group_spec`, then checks each visual root `data-duration`; mismatch is **fatal** and blocks all of Step 7 back to you. Do not use an approximate value from `creative_brief`; do not round yourself. This is especially important when `voicePath` is non-empty (global timings for voice / SFX / captions are based on this value).
13. **Bottom caption-band keep-out (HARD constraint — only when dispatch `Captions: enabled`, machine-checked in preflight)**

    The canvas is `<Composition width>×<Composition height>` (from dispatch — landscape 1920×1080 by default, but portrait 1080×1920 or square 1080×1080 when the dispatch says so). When `Captions: enabled`, finalize places a full-film word-by-word karaoke pill in a bottom band. **The dispatch hands you two numbers — use them, never hardcode 900 / 880:**
    - **`Caption band top y`** — the band runs from this y down to the canvas bottom (the bottom ~16.67% of canvas height).
    - **`Foreground max y`** — every FOREGROUND element's target rendered lower edge must be ≤ this (= `Caption band top y` − 20px safety). Foreground = headline / cards / CTA / button / chip / stat / hero text / quote / key logo / any readable content.

    Worked values: landscape 1920×1080 → band y900–1080, `Foreground max y` = 880. Portrait 1080×1920 → band y1600–1920, `Foreground max y` = 1580.

    Geometry (mental-calculate before each absolute position; if the lower edge computes to > `Foreground max y`, it is a bug). Let **H = `<Composition height>`** and **FGmax = `Foreground max y`**:

    | CSS shape                                        | element lower-edge y                   | Legal condition              |
    | ------------------------------------------------ | -------------------------------------- | ---------------------------- |
    | `bottom: <B>px` (no `top` / `height`)            | `H − B`                                | `B ≥ H − FGmax`              |
    | `top: <T>px` + `height: <Hc>px`                  | `T + Hc`                               | `T + Hc ≤ FGmax`             |
    | `top: <T>px` + natural height (estimate)         | `T + content height`                   | `T ≤ FGmax − content height` |
    | `top: <T>px` + `bottom: <B>px` (stretched strip) | `H − B` (bottom determines lower edge) | `B ≥ H − FGmax`              |
    | flex/grid child + `align-self: end`              | Parent container bottom                | Parent lower edge ≤ FGmax    |

    `H − FGmax` is the minimum bottom offset: **200px on landscape, 340px on portrait** — i.e. a chip that sits at `bottom: 200px` on landscape must move to `bottom: 340px` on portrait. A centered hero anchors around **y ≈ 0.42 × H** (landscape ≈ 454, portrait ≈ 806), not the canvas midpoint.

    **BACKGROUND exceptions (exempt, may be full-bleed to the canvas bottom):**
    - `#root` background / surface decoration / `::before` / `::after` frame / ambient mesh / full-bleed invented-graphic / gradient base layer.
    - Decorative leaf class names — preflight automatically skips selectors containing any of these keywords (split by hyphen/underscore): `bg` / `background` / `dot-grid` / `mesh` / `gradient` / `swell` / `ambient` / `texture` / `noise` / `scanline` / `surface` / `overlay` / `halo` / `glow` / `frame` / `pin` / `corner-pin` / `deco` / `star-burst` / `burst` / `ring` / `stripe` / `rect` / `shadow` / `pulse` / `ripple` / `measure` / `probe` / `hidden` / `scrim` / `backdrop` / `veil` / `fog` / `grain`.
    - Macro-camera overflow wrappers from constraint #9 (with `data-layout-allow-overflow="true"`) — zoom peaks naturally exceed the frame.

    **When `Captions: disabled`:** full-canvas, vertical center y = H / 2, content may extend all the way to the canvas bottom. All constraints above are disabled; positioning is free.

    **Preflight machine check** (Step 7 (2) `captions.mjs keepout`) catches three shapes:
    1. `position: absolute` + `bottom: <X>px`, X < 180 and non-decorative
    2. `position: absolute` + `top: <X>px`, X ≥ 900 and non-decorative
    3. `position: absolute` + statically addable `top + height` > 900 and non-decorative

    The static math folds in **CSS `transform: translate*`** (px / % literals) **and `margin-top` / `margin-bottom`** (longhand + px shorthand) — so a negative-margin-centered card is measured at its real bbox, and conversely a negative `margin-bottom` that pushes a chip down IS caught. Each violation generates quasi-Edit strings (`edit_old` / `edit_new`) and writes them to `finalize_brief.json.caption_keepout.violations[]`; the finalize agent directly runs `Edit(file, edit_old, edit_new)` to fix it. **So a contract mistake is not left for snapshot visual inspection; preflight catches it immediately — check values against the table before writing.**

    **Shapes static analysis cannot catch** (GSAP runtime `translateY`, natural flex layout pushing content to y > 900, unresolvable transforms/margins like `calc()`/`var()`) — these are covered by finalize snapshot visual inspection, but **when writing code still position by the rule "element lower edge y ≤ 880"**; do not intentionally hug the edge.

14. **Continuous scene runs (continuity: continue) — one `group_wN.html`, true shared DOM**

    When your dispatch packet contains **2-3 consecutive scenes**, you own one continue run. Write **one** visual composition file, usually `compositions/group_wN.html`, with `data-composition-id="group_wN"` and `window.__timelines["group_wN"]`. Do **not** write separate `scene_N.html` files for the logical scenes in this worker. There is no cross-worker bridge contract, no `data-bridge-id`, no `check-bridge`, and no top-level crossfade inside the run.

    Build a single paused GSAP timeline whose duration is `Composition duration_s`. Treat each logical scene as a labeled segment:
    - `const T = { scene_3: 0, scene_4: <scene_4.local_start_s>, scene_5: <scene_5.local_start_s> };`
    - scene 3 tweens fire around `T.scene_3 + ...`
    - scene 4 tweens fire around `T.scene_4 + ...`
    - add a tiny hold/tween through the boundary when needed, but keep it inside the same timeline.

    Author the continuity with real persistent nodes:
    - **Same component family:** a process-step card, logo lockup, stacked quote, counter, or badge keeps the same `.gN-*` DOM node and gains content/state across the run.
    - **Same diagram/data-viz primitive:** one curve, node graph, counter, stepper, axis, or flow line persists and evolves. Do not destroy/recreate it at the boundary; animate its opacity/transform/path/value state in the shared timeline.
    - **Prebuild states, no runtime mutation:** if content changes, put both old/new labels or state layers in DOM and animate opacity/transform/clipping. Avoid `tl.call()`/`textContent` mutation; frame-seek should work from a static DOM + timeline.
    - **Boundary behavior:** the outgoing logical scene should resolve into the same shared element pose that the incoming logical scene continues from. There is no wrapper transition to hide a mismatch, so the group timeline itself must carry the viewer's eye.
    - **Scene-local support:** non-persistent support nodes may use `s<N>-` and appear only in their segment. The persistent protagonist uses `g<N>-`.

## Scope

Only write `<PROJECT_DIR>/<Composition file>`. **Do not** modify `index.html` / copy assets / run `npx hyperframes lint|validate|inspect|snapshot|render` (at initial authoring time `index.html` does not exist yet, so project gates cannot run — **exception: Repair Mode below runs a scoped `inspect`**) / add or remove effects (if a rule cannot run → STOP and report; do not silently drop it).

Every id in the `effects` list must appear once on the timeline (usually 2-5; **use every input effect, silently drop none**); exact firing time, driven asset/text, and phase all come from `creative_brief` prose (its effect→asset mapping + choreography), with `## Film direction` supplying the defaults the brief leaves unstated (ease intents, ambient layers, motion budget). Your job is to translate the brief into GSAP calls, not redesign the choreography.

**`assetCandidates` is usually `[]` (faceless).** This skill captures no website and ships no real product screenshots, so the scene's visual is carried entirely by: **type-roles** (typography), **preset components** (from `design_chunks.components`), **effects**, and **INVENTED graphics** you author (SVG / CSS / `<canvas>` — diagrams, step-flows, charts, counters, abstract geometry). Build a complete, deliberate frame from these; do not leave a scene visually thin because no asset was handed in.

**Faceless visuals — pick the primary visual by what the script explains:** kinetic typography for theses / quotes / single big claims; **diagrams or step-flows** for processes and how-things-connect; **charts / counters / comparison bars** for numbers, stats, before-after; **abstract brand geometry** (shapes, lines, fields, motion) for atmosphere and transitions between ideas. Let the brief's choreography + effect→asset mapping decide the rhythm; the visual _kind_ follows the sentence. **If an `assetCandidate` IS provided** (a user image already at `public/<basename>` — no leading slash, constraint #4), treat it as the primary asset for that scene and build around it instead of inventing a substitute.

## Flow

1. Parallel Read the required resources (3 items above)
2. Write exactly one `<PROJECT_DIR>/<Composition file>` (skeleton below)
3. Self-check (the `bash grep` block below); fix before reporting if anything fails
4. One-line report

## Skeleton

Example below uses single-scene `scene_1` (for other single scenes, replace `scene_1` / `s1-` with the corresponding number). For a multi-scene worker, use `group_wN` everywhere the example uses `scene_1`, use `gN-` for shared persistent nodes, and set `data-duration` to `Composition duration_s`.

⚠ root `<div>` 5 attributes + class + style must be **written on the same line** — the self-check regex and `check-compositions` Rule 1 both require "id and class in the same tag" as a single-line match. Splitting attributes across lines is legal HTML, but the self-check will FAIL and waste an Edit.

```html
<template id="scene_1-template">
  <div
    id="root"
    class="scene_1-root"
    data-composition-id="scene_1"
    data-width="<Composition width>"
    data-height="<Composition height>"
    data-duration="<Composition duration_s>"
    style="position:relative; width:<Composition width>px; height:<Composition height>px; overflow:hidden;"
  >
    <style>
      /* Root element styles — write #root (not a self data-composition-id selector or .scene_1-root).
         Brand tokens (--brand-*, --cl-*, --font-display/body/mono, spacing/radius) are declared
         ONCE globally in index.html's <head> and inherit here — do NOT redeclare the :root block.
         Reference them with var(--*). Override a single token locally only if this scene needs a
         different value (the local declaration wins by cascade). */
      #root {
        background: var(--canvas);
        font-family: var(--font-body); /* default font; headings use var(--font-display) */
        /* e.g. a dark scene: --canvas: var(--cl-navy); */
      }
      #root *,
      #root *::before,
      #root *::after {
        box-sizing: border-box;
      }

      /* Scene-specific rules — all bare classes.
         The CSS scoper automatically adds scope.
         Class names carry the s1- prefix so sibling scenes do not conflict. */
      .s1-grid {
        /* ... */
      }
      .s1-word {
        /* ... */
      }
    </style>

    <!-- Build DOM according to the creative_brief effect→asset mapping.
         All classes use s1- prefix; ids also use s1- prefix (e.g. id="s1-headline"). -->

    <script>
      // Paste the EASE / DUR const block from easings.js / dispatch inline section
      const EASE = { entry: "power2.out" /* ... */ };
      const DUR = { med: 0.55 /* ... */ };
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      // Write selectors as bare .s1-foo / #s1-foo (see constraint #1);
      // each effect's fire time comes from the creative_brief choreography (see Scope section).
      const headlineEl = document.querySelector("#s1-headline");
      tl.fromTo(
        ".s1-word",
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: DUR.med, ease: EASE.entry },
        0,
      );
      window.__timelines["scene_1"] = tl;
    </script>
  </div>
</template>
```

## Self-Check (run for the visual composition; fix failures before reporting)

Replace placeholders below with real values. For single-scene `scene_1`: `CID=scene_1`, `PREFIX=s1`, `EXPDUR=<estimatedDuration_s>`, `F=compositions/scene_1.html`. For group worker `w2`: `CID=group_w2`, `PREFIX=g2`, `EXPDUR=<Composition duration_s>`, `F=compositions/group_w2.html`.

```bash
PROJECT_DIR="<Dispatch context PROJECT_DIR>"
SKILL_DIR="<Dispatch context SKILL_DIR>"
F="$PROJECT_DIR/<Composition file>"
CID=<Composition ID>; PREFIX=<sN-or-gN>; EXPDUR=<Composition duration_s>
W=<Composition width>; H=<Composition height>   # from dispatch (default 1920 / 1080 landscape)

# File exists
[ -s "$F" ] || echo "FAIL: empty/missing $F"

# Root 5 attributes present at once (most common omissions: data-duration / id=\"root\") — if any are missing, finalize will catch it later and waste a round-trip
for ATTR in 'id="root"' "class=\"${CID}-root\"" "data-composition-id=\"${CID}\"" "data-width=\"${W}\"" "data-height=\"${H}\"" 'data-duration="'; do
  grep -q "$ATTR" "$F" || echo "FAIL: root missing $ATTR — all 5 attributes must be present"
done

# id=\"root\" and class=\"<sid>-root\" must be on the same div (check-compositions Rule 1 requires same tag; splitting into two divs can slip past self-check but gate will fatal)
grep -qE "id=\"root\"[^>]*class=\"${CID}-root\"|class=\"${CID}-root\"[^>]*id=\"root\"" "$F" || \
  echo "FAIL: id=\"root\" and class=\"${CID}-root\" must be on the same div tag"

# data-duration value must equal dispatch Composition duration_s — Step 7 assemble-index.mjs treats mismatch as fatal and blocks the whole phase
grep -q "data-duration=\"${EXPDUR}\"" "$F" || echo "FAIL: root data-duration must equal Composition duration_s=${EXPDUR} (do not use approximations / do not round)"

# Literal HTML opening tags are forbidden in comments (lint regex can treat <template>/<style>/<script> in comments as real tags -> 1-2 minutes of false-positive debugging)
grep -nE '<!--[^>]*<(template|style|script)[> ][^>]*-->' "$F" && \
  echo "FAIL: comment contains literal <template>/<style>/<script> — escape as &lt;...&gt; or rewrite as plain text"

# Must be 0 — bug shapes
# 1) `.<Composition ID>-root` used as an ancestor selector (producer strips this wrapper during render, causing all selectors to miss -> black scene)
grep -nE "\\.${CID}-root[[:space:]]" "$F" && echo "FAIL: do not use .${CID}-root as an ancestor selector — write bare .${PREFIX}-foo instead"
# 2) Do not write a self data-composition-id selector; root styles use #root, internal elements use the composition prefix
grep -nE "\\[[[:space:]]*data-composition-id[[:space:]]*=[[:space:]]*['\"]${CID}['\"][[:space:]]*\\]" "$F" && \
  echo "FAIL: do not write [data-composition-id=\"${CID}\"] selector — use #root for root styles and .${PREFIX}-foo / #${PREFIX}-foo for internal elements"
# 3) Forbid #<Composition ID>-root; root id must only be #root, internal ids use the composition prefix
grep -nE "#${CID}-root\\b|getElementById\\(\"${CID}-root\"\\)" "$F" && echo "FAIL: do not use #${CID}-root"
# 4) Forbidden by core deterministic contract (determinism-rules.md): Date.now / performance.now / unseeded Math.random / fetch(at render time) / repeat:-1.
#    Plus PLV-specific pre-flight constraints (check-compositions Rule 5, not a core contract): CSS transition:/animation: (PLV requires all motion to go through one seekable
#    GSAP timeline — note that hyperframes-animation/adapters/css-animations.md actually supports seekable CSS keyframes, but PLV is stricter), @font-face (must be declared in index.html <head>).
grep -nE '@font-face|transition:|animation:|Date\.now|Math\.random|performance\.now|fetch\(|repeat:\s*-1' "$F" && \
  echo "FAIL: hits above (including embedded <style> pasted from components[]) must be fixed: rewrite CSS transition:/animation: as GSAP tweens (CSS transitions are not controllable during producer frame-by-frame seek); move @font-face to index.html <head>; Date.now/Math.random/performance.now/fetch/repeat:-1 are hard-forbidden by the core deterministic contract."
# 5) Font names must use var(--font-*) tokens — hard-coded literal font names bypass index.html <head> @font-face
#    Allowlist: var(--font-display/body/mono), CSS generic families (serif/sans-serif/monospace/system-ui/ui-monospace/ui-sans-serif/ui-serif),
#         safe fallbacks (Georgia/Times/Helvetica/Arial/Menlo/Monaco/SFMono-Regular/-apple-system/BlinkMacSystemFont)
# ⚠ macOS bash pitfall: `grep -v >/dev/null` returns 0 on empty input (GNU grep returns 1), causing `&& echo FAIL` to always fire.
#    Use an if-block + explicit output line check to avoid pipefail-off false positives.
HARDCODED_FONTS=$(grep -nE "font-family:[[:space:]]*['\"]" "$F" | grep -vE "var\\(--font-(display|body|mono)\\)" || true)
[ -n "$HARDCODED_FONTS" ] && \
  echo "FAIL: hard-coded font names — use var(--font-display/body/mono) so index.html @font-face applies"$'\n'"$HARDCODED_FONTS"
# 6) Asset paths must not have a leading slash — /public/... is fatal under check-compositions Rule 6 (catching it here avoids waiting for gate failure)
grep -nE '["(]/public/' "$F" && echo "FAIL: asset path has leading slash — write public/... (not /public/...)"
# 6a) NO <video> in a scene file — nested video is never seeked/decoded and renders BLANK (check-compositions Rule 6a is fatal).
#     Footage is declared on the poster <img> via data-video-src (constraint #4); hoist-videos.mjs mounts the real host-root <video> in Step 7.
grep -nE '<video\b' "$F" && \
  echo "FAIL: <video> tag(s) above — replace with a poster <img class=\"clip\" src=\"public/<still>\" data-video-src=\"public/<clip>\" ...> declaration"
# 7) Caption-band keep-out (constraint #13) — run the REAL preflight gate, scoped to your composition.
#    ONLY when dispatch says `Captions: enabled` (static, instant). Same math as preflight: a pass here is a pass there.
#    $CID works for both file shapes (a group_wN id matches its visual clip; a scene_N id matches its scene file).
(cd "$PROJECT_DIR" && node "$SKILL_DIR"/scripts/captions.mjs keepout \
  --group-spec ./group_spec.json --hyperframes . --scene "$CID")
# exit 1 → each violation prints the selector + an edit_old → edit_new fix; apply it, re-run until clean.

# 8) Foreground overlap (constraint #10) — run the REAL rendered gate, scoped to your composition (always; ~5-10s).
#    Loads your composition headless, seeks the timeline to 0.4/0.7/0.92 of duration, z-flattens all
#    non-background paint atoms, and reports any two that intersect.
(cd "$PROJECT_DIR" && node "$SKILL_DIR"/scripts/check-overlap.mjs \
  --group-spec ./group_spec.json --hyperframes . --scene "$CID")
# exit 1 → fix by root cause (move a box / flow container / stagger visible windows),
#          re-run until clean. There is no opt-out attribute.
# exit 2 → gate unavailable (deps not ensured). Do NOT npm-install here (parallel siblings would
#          race); note "overlap self-check unavailable" as an anomaly in your report and continue —
#          preflight runs the same gate authoritatively.
# Group files (group_wN.html): the overlap gate probes per-logical-scene files, so a group clip's
# scenes report as "skipped" — constraint #10 stays author-owned there (finalize's contact-sheet
# pass is the visual check); the keepout gate in step 7 DOES scan your group file.

# Must be >= 1 — structural evidence
grep -c "class=\"${CID}-root\"" "$F"                                   # root div still has class, useful while previewing/dev
grep -c "data-composition-id=\"${CID}\"" "$F"                          # host contract
grep -c "#root" "$F"                                                   # root self styles (CSS vars, bg, font)
grep -c "window\\.__timelines\\[\"${CID}\"\\]" "$F"                    # timeline registration

# Composition class / id must carry prefix (rough match: at least one .s<N>-/.g<N>- or #s<N>-/#g<N>- appears)
grep -cE "[.#]${PREFIX}-[a-z]" "$F"

# Strict class-prefix check: list every token in HTML class=\"...\" attributes that is **not** prefixed with the composition prefix
# Legal allowlist: (1) starts with ${PREFIX}-; (2) ${CID}-root (root div class, only for preview/dev)
# In group files, logical-scene-only s<N>- support classes are also allowed; inspect those manually if listed.
# Any hit -> component missing prefix, source of sibling scene bleed
UNPRX=$(grep -oE 'class="[^"]*"' "$F" \
  | sed -E 's/class="([^"]*)"/\1/' \
  | tr ' ' '\n' \
  | grep -vE "^(${PREFIX}-[a-zA-Z0-9_-]+|s[0-9]+-[a-zA-Z0-9_-]+|${CID}-root)$" \
  | grep -E "^[a-z]" \
  | sort -u)
[ -n "$UNPRX" ] && echo "FAIL: classes missing ${PREFIX}- prefix (or scene-local sN- in group files): $(echo $UNPRX | tr '\n' ' ')"

# All assets are under PROJECT_DIR/public/
grep -oE 'public/[A-Za-z0-9._/-]+' "$F" | sort -u | while read p; do
  [ -s "$PROJECT_DIR/$p" ] || echo "MISSING ASSET: $p"
done
```

Any FAIL / MISSING / bug-shape hit → fix before reporting. Step 7 finalize has the same harness, so catching it here saves an 8-13 minute round-trip.

## Repair Mode (TARGETED REPAIR re-dispatch)

When the dispatch contains a `## Repair context` block, you are repairing an **existing** composition file after a Step 7 preflight failure — not authoring from scratch. The repair dispatch carries: the verbatim gate findings for your scene(s) (`inspect` error lines / `overlap` violations with both selectors + rects + overlap geometry / `caption_keepout` violations / a fix list), `npx_prefix` (pinned, cache-warmed — from `finalize_brief.json`), and `Inspect at: <t1,t2,...>` (absolute composition timestamps inside your scene's window).

Rules that differ from authoring mode:

1. **Edit in place; do not rewrite.** Preserve the root contract (all 5 attributes), `data-duration` EXACTLY, `s<N>-` / `g<N>-` prefixes, timeline registration, every dispatched effect, and — in a `group_wN.html` continue run — the persistent shared-element continuity across its logical scenes (constraint #14).
2. **Fix the listed bugs by root cause**, not by suppressing the check — `data-layout-allow-overflow` is legitimate only for genuinely intentional overflow (3D scroll-clip viewports, zoom peaks), never to silence a real clip.
3. **Self-verify before reporting (the contract that makes repair converge in one round).** `index.html` is already assembled at repair time, so you CAN and MUST run the scoped gates yourself:

   ```bash
   # Scoped inspect — only your scene's time window; STRICT, no --tolerance flag (same as the preflight gate)
   (cd "$PROJECT_DIR" && <npx_prefix> inspect --at "<Inspect at>" 2>&1 | tail -30)
   # Rendered overlap gate, scoped to your composition (always — layout edits can introduce new overlap)
   (cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/check-overlap.mjs --group-spec ./group_spec.json --hyperframes . --scene <Composition ID>)
   ```

   - Pass condition: **zero `✗` lines naming your composition's selectors** (`#s<N>-…` / `.s<N>-…` / `#g<N>-…` / `.g<N>-…`) and check-overlap exit 0 for your composition. A `✗` naming another worker's composition is not yours — note it in the report, do not fix it.
   - When dispatch says `Captions: enabled`, also re-run the static keep-out scoped to your composition:

   ```bash
   (cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/captions.mjs keepout --group-spec ./group_spec.json --hyperframes . --scene <Composition ID>)
   ```

   - Still failing after 3 distinct fix attempts on the same finding → STOP and report the finding + what you tried (do not loop).

4. Also re-run the authoring self-check grep block (above) — a repair must not break the structural contract.
5. Report: one line per scene + `scoped inspect ✓ / overlap ✓ / keepout ✓` (or the STOP detail). This self-verification replaces the orchestrator's per-round full preflight — the orchestrator runs preflight once after ALL repair workers return, expecting it green.

## Report Template

One line per visual composition:

```
group_w2: file=compositions/group_w2.html duration=9.37s scenes=[scene_3,scene_4] effects=[...] overlap=✓ keepout=✓
```

`overlap=` / `keepout=` restate the scoped gate results from the self-check (`keepout=skipped` when Captions: disabled; `overlap=unavailable` only on exit 2). Plus anomalies (missing asset, ambiguous rule combination, attempted effect drop). Do not write `context.log`. In Repair Mode, append the self-verify status line (rule #5 above).
