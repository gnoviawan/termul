---
description: "HyperFrames HTML composition contract. Use for composition structure, data attributes, clips, tracks, sub-compositions, variables, media playback, deterministic render rules, and validation of minimal renderable projects."
---
# HyperFrames Core

HyperFrames renders video from HTML. A composition is an HTML file whose DOM declares timing with `data-*` attributes, whose animation runtime is seekable, and whose media playback is owned by the framework.

This skill is the **technical contract**. Other concerns live in sibling skills:

- `hyperframes-animation` — atomic motion rules + scene blueprints + per-runtime adapters (GSAP, Lottie, Three, Anime.js, CSS, WAAPI, TypeGPU)
- `hyperframes-creative` — palettes, typography, narration, beat planning, audio-reactive
- `hyperframes-media` — TTS, Whisper transcribe, background removal, captions
- `hyperframes-registry` — install blocks and components (`hyperframes add`)
- `hyperframes-cli` — dev loop commands (lint / validate / preview / render)

For **Tailwind v4 projects** (`hyperframes init --tailwind`), see `references/tailwind.md` — the browser-runtime contract is distinct from Studio's Tailwind v3 setup.

## Routing

| Want to…                                                                                   | Read                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------ |
| See a minimal renderable composition                                                       | `references/minimal-composition.md`  |
| Decide between monolithic single-file and modular sub-comp architecture                    | `references/composition-patterns.md` |
| Structure a modular `index.html` (orchestrator + slots + root audio)                       | `references/composition-patterns.md` |
| Pick a sub-comp archetype (content / driver-only / multi-scene merge / audio-reactive)     | `references/composition-patterns.md` |
| Look up a `data-*` attribute (root, clip, sub-comp host, legacy aliases)                   | `references/data-attributes.md`      |
| Use `class="clip"` correctly                                                               | `references/data-attributes.md`      |
| Pick a `data-track-index`; same-track overlap; track-index vs CSS `z-index`                | `references/tracks-and-clips.md`     |
| Time a clip relative to another (`data-start="intro + 2"`, crossfade overlap, chains)      | `references/tracks-and-clips.md`     |
| Wire a sub-composition (host attributes, `<template>` wrapper, per-instance variables)     | `references/sub-compositions.md`     |
| Animate inside a sub-composition (`gsap.fromTo` over `gsap.from`, seek-back behavior)      | `references/sub-compositions.md`     |
| Declare variables (types, extra options, defaults, `--strict-variables` in CI)             | `references/variables-and-media.md`  |
| Place `<video>` / `<audio>`, set volume, trim with `data-media-start`                      | `references/variables-and-media.md`  |
| Build a seekable timeline (paused, sync construction, `gsap.set` later-scene trap)         | `references/determinism-rules.md`    |
| Avoid non-deterministic state (clocks, `Math.random`, `repeat: -1`, finite repeat formula) | `references/determinism-rules.md`    |
| Know what can / cannot be animated (visual-property allowlist; not `display`/`visibility`) | `references/determinism-rules.md`    |
| Fit text and prevent overflow (`fitTextFontSize` signature, `<br>` rule, layout contract)  | `references/determinism-rules.md`    |
| Author full-frame motion with shared backgrounds                                           | `references/full-screen-motion.md`   |
| Work in a Tailwind v4 project (`init --tailwind`)                                          | `references/tailwind.md`             |

For animation runtime specifics (GSAP API, Lottie, Three.js, etc.) go to `hyperframes-animation` → `adapters/<runtime>.md`.

## Composition Structure

Two root forms; they are **not** interchangeable.

- **Standalone** (the top-level `index.html`) — root `<div data-composition-id="…">` sits directly in `<body>`. **No `<template>` wrapper.** Wrapping a standalone root in `<template>` hides all content from the browser and breaks rendering.
- **Sub-composition** (a file loaded via `data-composition-src`) — root `<div data-composition-id="…">` **must** be wrapped in `<template>`. Without the wrapper the runtime cannot extract and mount it.

> ⚠ Sub-composition transport rule: the runtime **only clones `<template>` contents** into the live DOM. Everything outside the template — including `<head>` and any `<style>`/`<script>`/`<link>` that lives in `<head>` — is discarded. Put `<style>` and `<script>` blocks **inside** `<template>`, not in `<head>`.
>
> ⚠ Host-id rule: in the host file, `data-composition-id` on the slot must **exactly equal** the inner template's `data-composition-id` **and** the `window.__timelines["<id>"]` key. Do not add `-mount` / `-slot` / `-host` suffixes.

See `references/sub-compositions.md` for the file shape, host wiring, pitfall examples, and the pre-render verification checklist.

### Root must be sized (silent layout bug)

The standalone root must establish an explicitly **sized box**, and every ancestor between it and a `height: 100%` element must have a resolved height. If the root or an intermediate wrapper has no height, a flex/`height:100%` content container collapses to ~0 and content piles into the **top-left corner** (often clipping the first glyph at x=0). `lint`, `validate`, and `inspect` do **not** catch this — `inspect` substitutes the authored `data-width`/`data-height` for a collapsed root and reports "0 layout issues."

```html
<body style="margin: 0">
  <div
    id="root"
    data-composition-id="main"
    data-width="1920"
    data-height="1080"
    data-duration="5"
    style="position: relative; width: 1920px; height: 1080px; overflow: hidden"
  >
    <!-- Center robustly: position:absolute + inset:0 fills the sized root regardless of
         intermediate wrappers; or use a flex container ONLY if its parent chain is sized. -->
    <section
      class="clip"
      data-start="0"
      data-duration="5"
      data-track-index="1"
      style="position: absolute; inset: 0; display: grid; place-items: center; padding: 120px 160px; box-sizing: border-box"
    >
      <h1>Title</h1>
    </section>
  </div>
</body>
```

Keep the `padding` (≥80px) on the centering container — it is the title-safe margin that stops large type touching the frame edge. See `references/minimal-composition.md`.

## Timeline Contract (GSAP default)

Every composition registers exactly one GSAP timeline.

- Create with `gsap.timeline({ paused: true })` — the player owns playback.
- Register at `window.__timelines["<composition-id>"]`; the key **must exactly match** the root's `data-composition-id`. Dot syntax (`window.__timelines.<id> = tl`) is equivalent when the id is a valid identifier; use brackets if the id contains `-`.
- Build the timeline **synchronously** during page load — not inside `async`, `setTimeout`, `Promise`, or event handlers. The renderer samples after page load completes; any deferred timeline construction misses the sample.
- Render duration comes from `data-duration` on the root, **not** from GSAP timeline length. Do not pad the timeline with empty tweens to set duration.
- For sub-compositions, do **not** manually nest sub-timelines into the host (`master.add(sub)`); the framework drives them independently.

For non-GSAP runtimes (Lottie / Three / WAAPI / CSS / Anime.js / TypeGPU), the equivalent contract lives in `hyperframes-animation/adapters/<runtime>.md`. See `references/determinism-rules.md` for the cross-runtime Animation Runtime Contract.

## Non-Negotiable Rules

These break the renderer — or produce **silent visual bugs that `lint`/`validate`/`inspect` do NOT catch** (rules 3, 7-8). (Synchronous timeline construction is covered above in **Timeline Contract**.)

1. No `Math.random()` / `Date.now()` / `performance.now()` driving visuals — use a seeded PRNG.
2. No `repeat: -1`. Use `repeat: Math.max(0, Math.floor(duration / cycleDuration) - 1)` — **`floor`, not `ceil`** (`ceil` overshoots `data-duration` and trips the `gsap_repeat_ceil_overshoot` lint; `max(0, …)` avoids a negative repeat = infinite).
3. `<video>`/`<audio>` must be a **direct child of the host root** (`index.html`) — never inside a sub-comp `<template>`, never inside a wrapper `<div>`; otherwise it is never decoded and renders blank/black (silent). The framework owns playback: no `video.play()` / `audio.play()` / `currentTime = …`. A sub-comp **cannot** drive host elements (selector or `querySelector`), so animate host media from the **main timeline** at global time. See `references/variables-and-media.md`.
4. No `gsap.set()` on clip elements from later scenes (they are not in the DOM yet). Use `tl.set(selector, vars, time)` at or after the clip's `data-start`.
5. No animating `display` / `visibility`. Animate `opacity` / transforms; the clip lifecycle handles show/hide.
6. No `<br>` in body text. Let text wrap via `max-width`.
7. Transformed elements must be block-level + sized. `transform`/`scaleX`/`scaleY` is a **no-op on an inline `<span>`**, and scaling an auto-width (0px) element shows nothing → invisible bars/fills. Give them `display: block`/`inline-block`/flex-item **and** a real `width`/`height` (e.g. `width: 100%` inside a sized parent).
8. Absolutely-positioned decoratives (badges, pills, tags) that **pulse or overshoot** (`yoyo` scale, `back.out`) need clearance at their **peak** size and must not straddle an `overflow: hidden` edge — else they overlap a neighbor or get clipped. Position for the largest frame, not the resting one.

## Editing Existing Compositions

- Read the actual files before editing.
- Preserve unrelated timing, tracks, IDs, variables, and media paths.
- Match existing composition IDs and timeline registry keys.
- When adding a clip, choose a non-overlapping `data-track-index` or intentionally adjust surrounding timing.
- When adding a sub-composition, verify its internal `data-composition-id` before wiring the host.

## Validation

Use `hyperframes-cli` for command details.

- [ ] `npx hyperframes lint` passes (0 errors)
- [ ] `npx hyperframes validate` passes (0 console errors)
- [ ] `npx hyperframes inspect` passes, or overflow is intentionally marked
- [ ] Projects with sub-compositions: `npx hyperframes snapshot --at <midpoints>` and eyeball each frame
