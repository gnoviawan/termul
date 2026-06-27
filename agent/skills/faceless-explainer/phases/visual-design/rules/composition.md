---
name: video-composition
description: "Composition design decisions for HyperFrames videos (1920x1080 landscape by default; also 1080x1920 portrait / 1080x1080 square) — canvas zones, 7 layout templates, density rules, hierarchy logic, depth principles. Specific px / scale / shadow values live in build agent territory."
category: visual-design
---

# Composition for Video - Design-Judgment Layer

Video composition is closer to film and poster design than webpage layout. There is no scrolling and no responsive reflow. Every frame is a fixed canvas; every pixel matters. The default canvas is **1920×1080 (16:9 landscape)**; for **portrait (1080×1920)** and **square (1080×1080)** see "Portrait & Square" below — the principles are identical, the aspect ratio is not.

**Most of this file is plan-layer design judgment** - conceptual canvas zones, 7 composition templates, density rules, hierarchy logic, and depth-layering principles. Concrete px (safe margins 96-150), scale values (1.05 / 0.92), three-layer `box-shadow` recipes, `perspective` 800-1400px, etc. belong to the build agent; plan does not write code.

Composition is one of the highest-value parts of the plan - which layout to choose, how much frame the primary element occupies, and how many depth layers to use **are director decisions**.

## Squint Test

Squint your eyes (or blur the screenshot). Can you still identify:

- the most important element?
- the second most important element?
- clear spatial groups?

If everything has equal weight after blur, hierarchy is broken - redesign before writing the plan. The strongest archive beats all pass this test: one dominant block + one supporting structural element, with everything else demoted.

## Canvas Zones (conceptual)

The canvas (shown here as 1920×1080 landscape) has four zones:

```
+--------------------------------------------------+
|         Optional top chrome                       |
|  +----------------------------------------------+ |
|  |         Safe margin                          | |
|  |  +----------------------------------------+  | |
|  |  |                                        |  | |
|  |  |       Primary content area             |  | |
|  |  |    (center 65-75% of frame)            |  | |
|  |  |                                        |  | |
|  |  +----------------------------------------+  | |
|  |  | Caption band (bottom ~17%, HARD when captions) | | |
|  |  +----------------------------------------+  | |
|  +----------------------------------------------+ |
+--------------------------------------------------+
```

- **Top chrome** - only for workspace mockup scenes; otherwise skip.
- **Safe margin** - key content stays away from edges; hero / editorial scenes need more air.
- **Primary content area** - the center 65-75% of the frame is where the eye naturally rests; body text blocks should **never** press against the edge.
- **Caption band (bottom ~17%, HARD reserved when captions are enabled)** - when this film has captions enabled (`group_spec.captions_enabled`), the bottom ~17% of **canvas height** is a **HARD reserved zone** (landscape 1080h -> bottom 180px, y 900-1080; portrait 1920h -> bottom 320px, y 1600-1920): primary content area and all key visuals **must cap at the caption-band top y**, and vertical centering should anchor at **y ≈ 0.42 × height** (landscape ≈454, portrait ≈806), not the canvas midpoint. BACKGROUND / ambient / surface decoration layers are exempt and may remain full-bleed. When captions are disabled, this zone can be used normally. Plan example: "captions enabled - hero block centered in upper ~83%, stat card bottom edge sits at y≈880 just above the caption band; background mesh stays full-bleed."

Plan writes "hero word centered with generous safe margins"; it does not write `padding: 150px 120px 92px`.

## Portrait & Square (non-16:9 canvases)

The canvas is **1920×1080 (16:9 landscape) by default**, but the dispatch `Canvas:` line may be **1080×1920 (9:16 portrait — reels / shorts / TikTok)** or **1080×1080 (1:1 square — feed)**. The zones, density rules, hierarchy logic, and depth principles above all still apply; what changes is the **aspect ratio**, and a layout designed for a wide frame does not transplant into a tall one. Read the dispatched `Canvas:` and design for that shape from the start — do not plan landscape and "crop".

- **Stack vertically, not side-by-side.** Portrait has little horizontal room: split-screen / triptych / asymmetric 60-40 become **top/bottom stacks**, vertical step lists, and stacked bands. A wide marquee strip becomes a centered stack. Square tolerates side-by-side only for two compact items.
- **Vertical center moves with the canvas.** Anchor a centered hero around **y ≈ 0.42 × canvas height** (portrait ≈ 806, square ≈ 454), not a fixed 540. The caption band is still the bottom ~17% of **height** (portrait → y1600–1920; square → y900–1080) and is HARD-reserved when captions are enabled.
- **Type runs larger, fewer words per line.** A narrow frame wraps long headlines badly — prefer short kinetic lines, bigger type, and more vertical rhythm. Treat the tall axis as the primary reading flow.
- **Templates that travel well to portrait:** Centered (hero/climax), Layered Depth, Full-Width Strip (now a stacked band), vertical Rule-of-Thirds. **Avoid** wide Split Screen and Triptych in portrait; reach for stacked equivalents.
- **Density still rules.** Primary visual ≥ 40% of canvas, ≥ 3 depth layers — but measured against the tall frame; an empty top or bottom third reads as placeholder just like dead center does on landscape.

## 7 Composition Templates

Use at least 3 different templates in a single video (5 scenes -> 3+ templates, 9 scenes -> 4+ templates). **Do not default every scene to centered.** The strongest archive plans never use the same layout class twice in a row.

### 1. Centered (hero / climax)

One dominant element centered with generous breathing room. Use for: brand reveal, key metric, CTA, climax beat.

### 2. Rule of Thirds

Visual anchor placed on thirds intersections. Remaining space carries supporting elements or negative space. Use for: concept showcase, diagram with annotation.

### 3. Split Screen (comparison / dual focus)

Left and right halves carry separate elements. Use for: before/after, feature comparison, problem/solution, palette-switch moments.

### 4. Layered Depth (immersive)

Foreground / midground / background use different scale + opacity to create depth. Use for: opening hooks, atmosphere-heavy scenes, workbench beats.

### 5. Asymmetric (editorial)

Primary content is pushed to one side (60/40 or 70/30). Intentional imbalance -> visual tension + sophistication. Use for: feature focus, dense text information, editorial proof beats.

### 6. Triptych (three-panel)

Three equal-width zones, often used to show three capabilities / three feature beats simultaneously.

### 7. Full-Width Strip

One horizontal band (ticker, logo chain, marquee). Usually only 20% of canvas height.

## Frame Density - Avoid Empty Frames

Common failure: small elements floating in the center of 1920x1080 with empty space around them. Every scene must feel **intentionally filled**, not sparse.

**Density rules:**

- **Primary visual element occupies at least 40% of the canvas** - in faceless mode the primary visual is typography / an invented graphic / a diagram / a data-viz, not a screenshot. Hero / kinetic-type block 50-75% height × 60-80% width; centered diagram or chart 30-60% width × 50-70% height.
- **Every scene has at least 3 visual layers** - background (gradient / particles / grid), midground (main content), foreground (emphasis / decoration).
- **Opening and closing** are especially prone to emptiness - black background + lonely line of text feels placeholder-like. Add environmental layers: dual-radial swell, floating particles, brand-color ambient texture, low-opacity scanlines.
- **Text/graphics scenes are full, not empty** - a well-composed scene built from kinetic type + shapes + gradients + icon fields + brand-derived geometry, or from a diagram / chart / data-viz, **fills the frame on its own**. Faceless invented visuals are the medium, so a typographic or graphic scene is intentionally filled, not a placeholder; emptiness comes from one floating line over dead space, not from the absence of a screenshot.

**Fullness test:** could this frame work as a poster or social graphic? If it looks like a sparse PPT slide -> add visual layers.

**Poster-pause test:** if you freeze the video at any moment, can the frame stand as an independent graphic design?

## Negative Space as Design Tool

Whitespace is not waste; it directs attention.

- **Tight grouping** (icon + label, image + caption) - small spacing.
- **Generous separation** (unrelated groups) - large spacing.
- **Asymmetric outer margins** feel more designed than equal padding everywhere.
- **Hero words often keep large side whitespace** - it lets one word carry the weight of "this is everything."

### Spacing Failure Modes

- Every element is equidistant from every other element -> no grouping, no hierarchy.
- Elements unintentionally touch or overlap.
- Text sits tight against container edge.
- Captions collide with bottom visuals.
- The same padding appears everywhere because it was the framework default.

## In-Frame Visual Hierarchy

Visual weight order (strong -> weak):

1. **Large primary visual** (kinetic-type block, diagram, chart, hero graphic)
2. **Motion** (moving beats static)
3. **High contrast** (bright text on dark ground, saturated color on neutral ground)
4. **Type scale** (display > heading > body)
5. **Position** (center and upper third are golden zones)

Combine **at least two** to build clear hierarchy. An element that is large, moving, and in the upper third is unquestionably the primary focus.

### Layer Hierarchy Across Dimensions

A title that is only larger, while sharing weight/color/spacing with body text, creates weak hierarchy. Stack dimensions:

| Dimension | Strong contrast                                             |
| --------- | ----------------------------------------------------------- |
| Size      | 3:1 ratio or larger                                         |
| Weight    | 800-900 vs 400                                              |
| Color     | high contrast against background                            |
| Motion    | one element moving vs all else static                       |
| Position  | top / left = primary                                        |
| Space     | large surrounding whitespace vs equidistant from everything |

## Cards and Grouping

Spacing + alignment can create natural grouping - **card containers are not required**.

**Use cards when:**

- content is genuinely distinct from surroundings
- in a UI demo scene, the group is independently actionable (command-panel row, feature card)
- you need shadow stacking to communicate "lifted above the canvas"

**Do not use cards when:**

- you only want visual separation -> use whitespace instead
- content belongs to a continuous list or flow

**Never nest cards inside cards** - visually claustrophobic + hierarchy becomes muddy. Wanting nested cards usually means the outer card is unnecessary.

Plan writes "comparison-split: left/right dual cards, three-layer shadow stack"; it does not write `box-shadow: 0 30px 60px rgba(0,0,0,0.45)...` - that is build work.

## Primary Visual Prominence

Faceless explainers have no captured assets (`assetCandidates` is usually `[]`). The LLM-invented primary visual - kinetic typography, abstract / brand-derived graphics, a diagram, or a data-viz - **is** the highest-value visual material. It carries the scene; treat it the way a screenshot-based film would treat a hero screenshot.

- **Feature the primary visual prominently**, not as tiny decoration around empty space.
- When a diagram, chart, or kinetic-type block is the focus, it should **fill at least 40-60% of the frame**.
- The primary visual must be **load-bearing, not purely decorative** - it should encode the scene's idea (the steps of a process, the shape of a number, the thesis of a quote), not just be a generic color block, abstract blob, or floating bokeh dropped in to fill space.
- Pick the register that best explains the script (see guide.md "Faceless visual register") and commit to it; a half-hearted graphic competing with a half-hearted text block reads as filler.

## Creating Depth on a 2D Canvas

Every scene should layer **at least 2-3 depth techniques** to avoid flat poster feel. Concrete values (perspective px, rotate degrees, scale values) are build work:

| Technique               | Effect                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Size difference**     | larger = nearer, smaller = farther                                                                                                        |
| **Blur**                | blurred = background, sharp = foreground                                                                                                  |
| **Opacity gradient**    | low = receding, full = primary                                                                                                            |
| **Overlap**             | foreground partially covers background                                                                                                    |
| **Shadow stacking**     | three-layer shadow = lift + brand feel                                                                                                    |
| **Motion speed**        | faster parallax = closer                                                                                                                  |
| **Counter-scale trick** | camera pushes toward focus -> background appears larger, focal element CSS scale <1 but fills frame after composition (archive signature) |

Plan writes "3 depth layers: background layer + midground main content + foreground emphasis; background counter-scales to make the camera push feel closer"; it does not write `scale: 1.05 / 1.0 / 0.92` - that is build work.

## What Should Not Appear in Promo Videos

- nav bars, footers, cookie banners (interactive webpage elements with no use in video)
- scrollbars, cursor arrows, browser chrome - unless the scene is **intentionally** a workspace mockup
- unclickable buttons
- generic decorative shapes (color blocks, spheres, ribbons) replacing real product assets
- floating bokeh / purple-to-blue AI gradients - "default AI cliché look", explicitly banned in multiple brand briefs

**Rare exception:** intentional interface reconstruction, only when the script literally asks you to depict an interface (e.g. "the dashboard shows…"). This is not a first-class FE convention - faceless explainers invent their visuals, so reach for it sparingly. When the script does call for it, nav bars, command panels, timeline tracks, and buttons provide real context that makes the reconstruction read as a deliberate interface rather than a stray webpage element.

## Plan Reference Example

> "Composition: asymmetric 60/40 - a self-drawing process diagram occupies left 60%, a kinetic-type caption + animated counter occupy right 40%. Generous safe margin; text block capped inside primary content area. 3 depth layers: background swell + midground process diagram + foreground glow on the active node. Density: primary visual ~55% of canvas, ambient layer adds 5% scanline + architectural grid."

Do not write concrete px / scale values / shadow recipes.
