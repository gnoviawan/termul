---
name: video-typography
description: "Typography design decisions for HyperFrames videos — roles, hierarchy intent, pairing logic. Implementation values (px, letter-spacing em, CJK fallback chains, OpenType CSS) live in build agent territory."
category: visual-design
---

# Video Typography - Design-Judgment Layer

Plan-layer only — roles, hierarchy intent, pairing logic, negative constraints. Concrete values (px, letter-spacing em, CJK fallback) are build-agent territory (`chunks/tokens.css`).

## Font Source

**Font families come from `chunks/tokens.css`**. Name fonts by **use** ("display for hero headline", "mono for eyebrow / metadata"); do not copy concrete font names.

A **second font** used for contrast (serif italic emphasis, mono labels) must be named as a design decision. Homogeneous pairing (two geometric sans faces) is not allowed — tension without hierarchy benefit.

## Type Scale (by role, not px)

Video type is much larger than web type. Plan references by **role**; build agent picks px from these ranges:

| Role               | Use                                   | Relative feel                               |
| ------------------ | ------------------------------------- | ------------------------------------------- |
| **Mega / climax**  | single-word hero, counter peak        | 50%+ of canvas height                       |
| **Hero / display** | main headline, scene core word        | 25-40% of canvas height                     |
| **Display**        | secondary title, section marker       | 10-20% of canvas height                     |
| **Heading**        | paragraph title                       | 5-10% of canvas height                      |
| **Body**           | supporting copy, captions             | minimum readable video scale                |
| **Eyebrow / UI**   | metadata, chapter mark, command panel | ~50-70% of body, often uppercase + tracking |
| **Data / counter** | standalone numeric statement          | huge range, body to mega                    |

Phrase by tier ("hero word uses display tier, eyebrow uses mono uppercase"); do not write "hero 220px".

**Avoid adjacent role sizes too close:** 48/52/56 does not read as hierarchy. Lean toward 2-3x jumps (display 220 → heading 92 → eyebrow 30 = 7.3x). Hierarchy must be legible in <1s.

## Build Hierarchy Across Multiple Dimensions

Size alone is insufficient. Stack at least 2-3 dimensions per scene:

| Dimension     | Strong contrast                   | Decision point                                |
| ------------- | --------------------------------- | --------------------------------------------- |
| **Size**      | 3:1 or larger                     | hero word far larger than surroundings        |
| **Weight**    | 800-900 vs 300-400                | extreme weights in one family beat two fonts  |
| **Color**     | high contrast against background  | see `color-system.md`                         |
| **Spacing**   | tight display + wide eyebrow      | tight = confidence; wide uppercase = metadata |
| **Case**      | eyebrow UPPERCASE + body Sentence | all one case = monotone                       |
| **Style mix** | italic serif inside heavy sans    | word-level emphasis (archive signature)       |

Plan names tiers/tracking by intent; do not write `-0.045em` / `0.08em` (build work).

## Font Pairing Principles

- **One family + multiple weights** is usually enough — cleaner than two competing fonts.
- **Second font only for real contrast:** serif display + sans body, sans hero + mono label.
- **Three-voice system** (strongest archive pattern): display + body + mono, each with clear semantic work (mono = metadata → "real tool feel").
- **Switching font universes scene by scene is valid** when the emotional arc demands it; do not force uniformity.

## Forbidden Patterns

- **Inter / Roboto / Open Sans / Lato / Montserrat regular weight as display** — an AI tell. If using Inter, use 900 + tight tracking, else not as display.
- **Similar-but-not-identical pairing** (two geometric sans, two humanist serifs) — noise without hierarchy.
- **Wide letter-spacing on long body sentences** — hurts readability.
- **Tight tracking on mono code** — loses rhythm.
- **Display at 0 letter-spacing** — a 200px title feels soft and corporate.

## CJK Note

If the narrator script contains Chinese, the plan must say "this scene contains CJK text." Build agent handles fallback chains (render-env config). In mixed CJK + Latin, CJK is denser, so display-tier CJK is usually one tier smaller than Latin.

## Plan Reference Example

> "Hero word: display tier + tight tracking. Eyebrow: mono uppercase wide tracking ('BEAT 02'). Body: supporting copy. Hero vs eyebrow = four-dimensional contrast (size + weight + case + style)."

Do not write concrete px / em / font names.
