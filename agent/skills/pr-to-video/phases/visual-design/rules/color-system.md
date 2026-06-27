---
name: video-color-system
description: "Color design decisions for HyperFrames videos — palette roles, 60-30-10 allocation logic, cross-scene consistency, dangerous combos. Hex values and contrast math live in build agent territory."
category: visual-design
---

# Video Color System - Design-Judgment Layer

Plan-layer only — roles, 60-30-10 logic, cross-scene consistency, dangerous combinations. Hex values and contrast math are build-agent territory (`chunks/tokens.css`).

## Palette Source

**Hex values come from `tokens.css` in `## Design chunks`**. Plan references by **role** only; do not copy concrete hex values.

> **Preset rules take priority over this file's generic rules.** Preset name is in `## Design chunks` `index.json.preset`; its color discipline is in `composition-hints.md` (§H surface contract / accent budget) - for example, editorial explicitly says "accent <= 5% frame area, primary is not a background fill, canvas is the hero." If a generic rule (such as "use dual-radial swell background") conflicts with the preset's §H color discipline, **the preset wins**. Plan gets preset name from `index.json.preset` and its rules from `composition-hints.md` to constrain palette use for this film (**do not read design.html**; chunks have replaced it).

### Pain / Serious Scenes

If a scene's `emotionalBeat` needs an intentional palette shift:

- If `chunks/tokens.css` / `composition-hints.md` **has** a `[data-theme="dark"]` block or dark surface -> use it (invert canvas / ink), without introducing an external palette.
- If there is **no** dark theme block (common in bright presets like editorial) -> **do not invent dark colors**. Instead use: desaturated accent + lower contrast (use `--paper-warm` instead of `--canvas` to darken the scene by one step) + tighter whitespace + stillness to carry the serious mood.

### When `--ink` / `--canvas` Are Pure Black / Pure White

For some presets (editorial / Swiss / brutalist / newspaper styles), `--ink: #000` / `--canvas: #fff` is a **style choice**, not a defect - "black ink on white paper" is core to those aesthetics.

- **`--ink: #000`** - OK in these presets; preserve as ink.
- **`--canvas: #fff`** - pure white blooms at video viewing distance; **prefer the preset-provided `--paper-warm`** (the editorial preset explicitly notes "fallback if canvas is pure white"). If no fallback token exists, the build agent synthesizes one step of warm white.
- Other presets (saas / material, etc.) should follow the generic off-black/off-white rules if pure black/white appears.

Decision path: read preset name first -> if editorial / brutalist family, accept pure black as ink + prefer `--paper-warm` as canvas; otherwise follow generic off-black/off-white guidance.

## Role Mapping

Each token plays a role in 60-30-10:

| Role                            | Typical token names (brand-dependent)                                                                | Visual weight                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Neutral background (canvas)** | `--canvas` / `--paper` / lightest neutral                                                            | **60%** - dominant, does not compete with content |
| **Neutral surface**             | `--paper-2` / `--surface` / second-lightest neutral; **if absent, layer with hairline rule instead** | **~20%** - panels, cards, boundaries              |
| **Foreground text (ink)**       | `--ink` / `--ink-soft` / off-black or off-white                                                      | **~10%**                                          |
| **Primary accent**              | `--brand-primary` / `--brand-accent`                                                                 | **~10%** - **only on the current focal element**  |
| **Secondary accent**            | `--brand-secondary` (if present)                                                                     | **~5%** - bound to a different semantic role      |
| **Restrained third color**      | neutral or paper tone                                                                                | **<2%** - occasional                              |
| **Semantic colors**             | success/error/warning derived from brand hue                                                         | use sparingly                                     |

> **When `chunks/tokens.css` lacks a `--surface` tier** - this preset layers with hairline rules rather than a surface color - plan should explicitly say "30% uses hairline + repeated canvas," instead of inventing a fake middle color.

## 60-30-10 Is **Visual Weight**, Not Pixel Count

- 60% canvas - dominant, not attention-grabbing
- 30% surface + text - panels, borders, supporting copy
- 10% accent - used only on the **current focal element**

**Top mistake:** applying brand color everywhere because it is "the brand identifier." Accent works because it is **rare**. In the strongest archive example (codex-plugin), each accent is bound to a **semantic role**: cyan = HyperFrames moment, lime = render, amber = Codex - three accents, each appearing only in its own beat, never overlapping.

Even more restrained: vercel-intro uses one brand red + one RGB aberration moment, then immediately returns to clean black-ground white text. **One color, one effect, maximal restraint.**

## Tinted Neutrals

Pure gray has no personality. Neutrals should shift subtly toward the brand hue:

- warm brands (red / orange / yellow) -> gray with a subtle warm cast
- cool brands (blue / purple / green / cyan) -> gray with a subtle cool cast

The cast should be nearly invisible, but it creates subconscious cohesion. This is usually already encoded in `chunks/tokens.css` `--canvas` / `--paper-2` tokens; plan only references roles and does not calculate OKLCH.

## Four-Layer Palette Structure

A complete video palette has four layers (skip layers you do not need; **do not** add extras):

1. **Primary accent** - 1-2 colors, semantically bound, 10-15% weight
2. **Neutral ladder** - canvas -> surface -> surface-raised, three tiers (light or dark), 60% + 20%
3. **Foreground** - 1-2 off-white or off-ink text colors, 10%
4. **Semantic colors** - success / error / warning, derived from brand hue

**Per-beat palette isolation is also valid** (fadeglow-v4 uses completely different color moods in Beat 2 / 4 / 7) - emotional arc decides; consistency is not mandatory.

## Cross-Scene Consistency

Every scene in a video should feel like it belongs to the same visual system (unless explicitly doing "one universe per scene").

- Background palette is defined once at project level (`:root` / shared `<style>`); do not hard-code hex per scene.
- Scenes may vary in **lightness** (dark -> bright rhythm), while sharing the same **hue family**.
- Accent purpose must stay consistent: if cyan is the HyperFrames moment color in scene 1, it cannot become a background gradient in scene 5.
- Data visualization colors derive from the brand palette; do not pick arbitrary colors.

**Variation within limits is OK:** dark/light alternation for rhythm, desaturated (calm) <-> saturated (emphasis), gradients between neighboring brand hues.

## Never Pure Black / Pure White

Pure `#000` / `#fff` does not exist in nature - contrast is harsh, feels synthetic, and compression destroys detail. Always use off-black / off-white tokens from `chunks/tokens.css` (typical names `--ink` / `--canvas`).

Exception: pure white `text-shadow` / `drop-shadow` halos at emphasis moments (click-ripple peak) are OK - build agent uses low-opacity overlays, not direct text color.

## Dangerous Combinations (Forbidden Patterns)

- **Light gray text on white** - contrast collapses, small screens fail.
- **Gray on colored background** - reads faded / dirty; use a darker tone of the background hue instead.
- **Thin light text on image** - unreliable even with shadow; add overlay + weight, or both.
- **Pure saturated neon on `#000`** - default AI nesting-doll look. Use off-black + accent glow reduced to 0.20-0.35 opacity (build work; plan only needs to say "avoid neon").
- **Purple-to-blue AI gradient** - codex-plugin / hermes explicitly banned this ("no generic purple-blue AI gradients"). Use brand-hued radial swell for depth instead.

## Background: Keep the Pin-and-Paper Native Paper Texture

**FE ships pin-and-paper (paper-grain family): keep the preset's native paper-texture background, consistent across the film; the brand-color mesh default does NOT apply.** The grain _is_ the atmosphere - a mesh / Gaussian-blur blob layer fights the paper aesthetic and is forbidden here.

- **Every scene background = the pin-and-paper paper base** (warm paper texture + optional sparse paper-grain/fiber noise), as declared by the preset §H surface contract.
- **Single background medium** - do not stack mesh, dual-radial swell, scanline, halftone, or architectural grid on top of the paper. Only the preset's own paper-grain/fiber layer belongs there.
- **Cross-film consistency is a hard rule** - background is determined by the preset system, not improvised per scene. The paper base is the same warm paper in scene 1 and the closing scene; there is no per-scene surface drift.

> **Component implementation:** the build agent reads pin-and-paper's §H surface contract from `composition-hints.md` and reuses the preset's declared paper-base component (or synthesizes "warm paper texture + sparse fiber noise" from the functional description). Plan references it by function ("native paper base"), not by hex/opacity.

### Background Unification Rule (no per-scene surface drift)

**Hard rule: scene backgrounds are the pin-and-paper paper base, consistent across every scene, including closing / CTA scenes.** Do not switch a scene to off-black / ink dark ground for drama - that is exactly what causes lightness jumps ("the whole film is warm paper, but the final scene suddenly turns black"). For climax / brand-reveal impact, use **foreground techniques** (hero-word weight + scale, pure-#000 ink contrast peak, accent saturation release on the focal element, wordmark / pin reveal), while the **paper base remains unchanged**.

**Deprecated** (no longer allowed because it creates per-scene light/dark jumps): ~~serious/pain beat -> off-black ground~~. For a serious beat on paper, darken by one step with `--paper-warm` and tighten whitespace (see "Pain / Serious Scenes" above), not by swapping the ground.

Plan writes: "native pin-and-paper paper base (warm paper texture, sparse grain) - consistent across the film, including closing scene." **Do not** write whole-scene off-black / ink ground, and **do not** write `opacity` / `blur()` values (build work).

## Plan Reference Examples

**Standard scene (pin-and-paper native paper base):**

> "Background: native pin-and-paper paper base (warm paper texture, sparse grain) - consistent across the film. Palette 60-30-10: 60% warm paper (canvas) + 30% hairline + chapter-label rule layering (no surface token; layer with hairline if no `--surface` tier) + 10% accent on the hero word and CTA underline. `--ink` is pure #000 as print-like ink; if any surface goes pure white, prefer `--paper-warm`."

**Brand reveal climax (foreground only, base unchanged):**

> "Beat 6 hero reveal: paper base unchanged; hero word steps to its weight/scale peak with pure-#000 ink contrast and an accent saturation release on the focal element only. No ground swap - the warm paper carries through."

Do not write concrete hex / opacity / saturation percentages - those are build work.
