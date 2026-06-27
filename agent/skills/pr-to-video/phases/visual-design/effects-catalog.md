Reference these effects in `section_plan.md` by **name** (wrapped in backticks).

The actual source of truth for `validate-section.mjs` is `hyperframes-animation/rules/`. This is the curated planner subset — **do not cite** the two skipped rules listed at the end (missing frontmatter).

## SVG & Icons

| Effect                | Description                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `svg-icon-enrichment` | Animate internal SVG elements (rotating needles, opening leaves, pulsing dots, dashed-line flow), making icons feel alive without replacing them. |
| `svg-path-draw`       | Use stroke-dasharray and stroke-dashoffset to progressively draw SVG paths.                                                                       |

## Camera & Viewport

| Effect                   | Description                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `camera-cursor-tracking` | Two-stage virtual camera that locks the viewport onto a moving focus point, with configurable initial position.                                |
| `coordinate-target-zoom` | Zoom into an off-center element by combining scale with counter-translation, so the target ends centered in the viewport.                      |
| `multi-phase-camera`     | Sequential camera zoom with 2-3 distinct phases (pull back / focus / push in) plus continuous micro-drift for organic cinematic feel.          |
| `viewport-change`        | Virtual camera: transform a wrapper around all scene content to simulate zoom / pan / focus lock. Camera moves right -> world translates left. |

## Interaction & Click

| Effect                   | Description                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cursor-click-ripple`    | Animate a mouse cursor moving to a target, with scale-down press feedback and an outward ripple ring on click.                                                                             |
| `physics-press-reaction` | Cursor + element press together through subtractive spring force: the cursor lands on the element, both compress, then release. Different from press-release-spring (which has no cursor). |
| `press-release-spring`   | Tactile button press: linear compression, spring-based recovery, and layered feedback (shadow compression + release burst + background glow).                                              |

## Text & Typography

| Effect                     | Description                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `3d-text-depth-layers`     | Stack multiple offset text layers to create a 3D shadow / extrusion effect on large type - more impactful than CSS text-shadow because each layer is a full DOM element.             |
| `asr-keyword-glow`         | Keywords glow and scale when "spoken" - attack/sustain/release envelopes sync to each word timestamp. Even without real audio, hard-coded timing creates a narrator-emphasis effect. |
| `context-sensitive-cursor` | Cursor color and style change with the currently typed text segment - accent color on highlighted segments, dimmed on placeholders, etc.                                             |
| `counting-dynamic-scale`   | During count animation, font size grows with the count value, giving numbers increasing visual weight.                                                                               |
| `discrete-text-sequence`   | Replace whole text states at frame thresholds for nonlinear typing effects - typos, bulk add, pauses, backspace, simulated thinking.                                                 |
| `hacker-flip-3d`           | Character-level 3D rotation plus random glyph substitution for a decrypted-reveal effect.                                                                                            |
| `vertical-spring-ticker`   | Slot-machine-style vertical scrolling inside a masked container using additive spring physics - each spring contributes one scroll "step."                                           |

## Layout & 3D

| Effect                     | Description                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `3d-page-scroll`           | Render an entire webpage as a tilted 3D card, then scroll it to reveal a specific region.                                                       |
| `ai-tracking-box`          | Animated bounding box with L-shaped corners follows an oscillating path, simulating AI object detection / tracking.                             |
| `avatar-cloud-network`     | Avatars distributed on an elliptical ring, connected to a central hub with SVG dashed lines - staggered social-proof "community" reveal.        |
| `center-outward-expansion` | Elements start clustered at screen center, then expand outward to final positions driven by a shared progress value.                            |
| `orbit-3d-entry`           | Elements flip in from 3D space, then settle into continuous elliptical orbits around a focal point.                                             |
| `split-tilt-cards`         | Two cards placed side by side with opposite Y-axis rotations, creating a symmetrical 3D split-screen layout for comparisons or paired features. |

## Transition & Motion

| Effect                       | Description                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `card-morph-anchor`          | Container morphs size and border radius across shots, acting as a visual transition anchor.                                                            |
| `dynamic-content-sequencing` | Automatically computes timeline start/end times from content length + per-item duration; longer content receives more time without hard-coded numbers. |
| `reactive-displacement`      | Physical collision: incoming element's spring drives outgoing element displacement - one source of truth creates causal motion.                        |
| `scale-swap-transition`      | Coordinated shrink-out + spring-in between two elements, creating a morph-like transition without SVG path interpolation.                              |
| `sine-wave-loop`             | Continuous breathing / idle ambient motion using trigonometry - keeps elements alive after entry. Pairs well with almost any entry rule.               |

## Skipped (frontmatter problems)

- css-marker-patterns.md: missing frontmatter (name + description)
- gsap-effects.md: missing frontmatter (name + description)
