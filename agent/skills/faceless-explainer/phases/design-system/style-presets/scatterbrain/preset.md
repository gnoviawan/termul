```preset-meta
{
  "name": "scatterbrain",
  "label": "Scatterbrain",
  "fingerprint": {
    "shadow": "soft-blur-paper-lift",
    "border": "none-on-stickies",
    "motion": "hand-placed-tilt",
    "density": "casually-clustered",
    "contrast": "warm-pastel-on-paper",
    "palette-mode": "brand-tinted-with-anchors"
  },
  "match_signals": [
    { "kind": "bouncy_easing", "weight": 0.25 },
    { "kind": "low_saturation", "weight": 0.15 },
    { "kind": "minimal_decoration", "weight": 0.05 }
  ],
  "best_for": ["creative agencies", "education", "indie tools", "workshop products", "warm friendly brands", "workshop / brainstorm decks"],
  "avoid_for": ["cold corporate", "formal enterprise", "regulated industries", "high-polish premium"],
  "chromeFonts": {
    "googleFontsHref": "https://fonts.googleapis.com/css2?family=Shrikhand&family=Zilla+Slab:wght@300;400;500;600;700&family=Caveat:wght@400;500;600;700&display=swap",
    "display": "Shrikhand",
    "body": "Zilla Slab",
    "script": "Caveat",
    "mono": "Caveat"
  },
  "palette": {
    "primary": { "value": "#FFE066", "constraint": "butter yellow — the lead sticky hue; tints the butter + mint post-its via color-mix(), the doodle stroke, and the warm-bg gradient" },
    "secondary": { "value": "#A5D8FF", "constraint": "sky blue — the system's 'secondary' sticky; tints the sky + lavender post-its and the cool half of bg gradients" },
    "accent": { "value": "#FFC9C9", "constraint": "rose pink — the 'warm accent' sticky; tints the blush + peach post-its and warm-accent gradients" },
    "canvas": { "value": "#F7F5F0", "lock": "anchor", "constraint": "warm cream paper — the textured ground (mirrors --paper-cream in §B); pure white kills the tactile paper register, so never replace" },
    "surface": { "value": "#FAF8F3", "constraint": "lighter warm cream — the 'second surface' (polaroid / clean inner frames), a touch brighter than the paper canvas" },
    "ink": { "value": "#2D2A26", "constraint": "warm near-black (mirrors --ink-warm) — every headline, body line, border, and doodle; pure black reads cold on warm pastels" }
  }
}
```

> `chromeFonts` makes the doc chrome render in the preset's native fonts; brand fonts still apply to §6 components. Scatterbrain has no machine-mono moment — the `mono` slot points at Caveat per §D's three-slot contract.

## §A Director's intent

Designer's whiteboard at 11am. Sticky notes pinned to cork, masking tape across the corner, marker doodles in the margins. Shrikhand display reads as chunky marker-pen lettering; Zilla Slab body sits like a printed handout; Caveat is the moment something got jotted down.

Depth is **soft blurred drop-shadow** (`2px 3px 15px shadow, 0 1px 3px shadow-deep`) on every post-it — the rare preset that embraces blur because the visual depends on paper lifting off cork. Every sticky carries a small rotation (±1° to ±15°) and a thumbtack pin via `::before`; hero stickies add a translucent tape strip via `::after`.

**Brand DNA tints the stickies; preset anchors keep the register playful.** Three site colors (`--brand-primary` / `--brand-secondary` / `--brand-accent`) mix with named pastel anchors (`--anchor-butter` / `--anchor-sky` / `--anchor-blush` / `--anchor-mint`) so dark or oversaturated brands still produce sticky-note pastels instead of muddy fills. Cream paper (`--paper-cream`) and warm ink (`--ink-warm`) are technical prerequisites — pure white kills the tactile register; pure black on warm pastels reads cold.

**Color role contract**: post-its cycle through the four anchor-mixed pastels (butter, sky, blush, mint) for categorical variety; brand DNA flows in as gradient deepening, pin colors, and feature-icon accents. Ink-warm carries every headline, every body line, every border, every doodle — colored text on pastel stickies kills legibility.

Motion is **hand-placed tilt**: short overshoot on entry (the sticky "lands" with a tiny bounce), no glide. Doodles drift on `sine.inOut`. Scene transitions are quick cuts with a single tape-rip beat — never crossfade.

**Class prefix:** `sb-` (initialism, 3 chars per §8.6).

**Atmosphere is non-negotiable.** Every scene gets the grain overlay + one of three background variants (cork / paper / warm). A post-it floating on plain white reads as broken — the textured ground IS the system.

## §B Decoration tokens (merge into design.html `:root`)

Scatterbrain declares **structural** tokens here (sticky-note shadow stack, rotation tilts, pin / tape geometry, doodle stroke). Color comes mostly from brand DNA mixed against named pastel anchors so the playful register survives any brand palette.

The cream paper base (`--paper-cream`) and warm ink (`--ink-warm`) are technical exceptions: pure white loses the paper texture, pure black on warm pastels feels cold. The four anchor hues are §8.2 hue-anchor tokens — declared once, mixed against brand vars in every component — so the system stays "sticky-note" regardless of brand DNA.

```css
/* §8.2 technical exception — warm paper + warm ink. Pure white destroys the
   tactile register; pure black reads cold on warm pastels. */
--paper-cream: #f7f5f0;
--paper-cream-deep: #f5f2ec;
--ink-warm: #2d2a26;
--ink-warm-light: #5c5750;

/* §8.2 hue-anchor tokens — declared once so every sticky-fill mix produces a
   consistent pastel register regardless of brand DNA. Without these anchors,
   dark or oversaturated brands would push the stickies into muddy or fluorescent
   territory and the workshop voice breaks. */
--anchor-butter: #ffe066; /* yellow sticky */
--anchor-butter-deep: #ffd43b;
--anchor-sky: #a5d8ff; /* blue sticky */
--anchor-sky-deep: #74c0fc;
--anchor-blush: #ffc9c9; /* pink sticky */
--anchor-blush-deep: #ff9f9f;
--anchor-mint: #b2f2bb; /* green sticky */
--anchor-mint-deep: #8ce99a;
--anchor-peach: #ffcc80; /* orange sticky (flat fill) */
--anchor-lavender: #d0bfff; /* purple sticky (flat fill) */

/* §8.2 tactile-prop anchors — physical objects the brand DNA does not own.
   Thumbtacks are physical-object red / gold / blue / green beads; cork is wood;
   polaroid paper is white. Mixing brand DNA into these would break the
   workshop metaphor (a red thumbtack should look like a red thumbtack). */
--pin-red-light: #ff6b6b;
--pin-red-deep: #c92a2a;
--pin-gold-light: #ffd43b;
--pin-gold-deep: #f59f00;
--pin-green-light: #69db7c;
--pin-green-deep: #2f9e44;
--pin-blue-light: #4dabf7;
--pin-blue-deep: #1864ab;
/* Cork-wood tones for bg-cork tonal gradient */
--cork-light: #e8ddd0;
--cork-mid: #d4c5b0;
--cork-deep: #c9b8a0;
/* Polaroid photo paper + placeholder photo tones */
--photo-paper: #fff;
--photo-placeholder-1: #e9ecef;
--photo-placeholder-2: #dee2e6;
--photo-placeholder-3: #ced4da;
/* Background-texture tones — cork glow ellipses + paper graph-grid line.
   Declared as tokens so bg-cork / bg-paper reference them instead of bare rgba. */
--cork-glow-warm: rgba(210, 170, 120, 0.3);
--cork-glow-deep: rgba(190, 150, 100, 0.2);
--paper-grid-line: rgba(200, 190, 175, 0.08);

/* Sticky surface mixes — 70% brand-tinted anchor + 30% brand-primary lifts the
   anchor toward the brand without overwhelming it. Components reference these
   tokens by name so the cluster recolors cleanly across brands. */
--sticky-butter: color-mix(in srgb, var(--brand-primary) 18%, var(--anchor-butter));
--sticky-butter-deep: color-mix(in srgb, var(--brand-primary) 18%, var(--anchor-butter-deep));
--sticky-sky: color-mix(in srgb, var(--brand-secondary) 18%, var(--anchor-sky));
--sticky-sky-deep: color-mix(in srgb, var(--brand-secondary) 18%, var(--anchor-sky-deep));
--sticky-blush: color-mix(in srgb, var(--brand-accent) 18%, var(--anchor-blush));
--sticky-blush-deep: color-mix(in srgb, var(--brand-accent) 18%, var(--anchor-blush-deep));
--sticky-mint: color-mix(in srgb, var(--brand-primary) 14%, var(--anchor-mint));
--sticky-mint-deep: color-mix(in srgb, var(--brand-primary) 14%, var(--anchor-mint-deep));

/* Shadow stack — signature soft paper-lift. The 15px-blur outer + 3px-blur inner
   makes the sticky hover off cork. This is the rare preset that uses blur. */
--shadow-paper: rgba(45, 42, 38, 0.15);
--shadow-paper-deep: rgba(45, 42, 38, 0.25);
--shadow-sticky: 2px 3px 15px var(--shadow-paper), 0 1px 3px var(--shadow-paper-deep);
--shadow-pin: 0 2px 4px var(--shadow-paper-deep), inset -2px -2px 4px rgba(0, 0, 0, 0.2);

/* §8.2 tactile-prop anchors — translucent masking-tape strip (a physical prop
   the brand DNA does not own, like the thumbtacks above). Declared once so the
   hero / post-it / photo-frame tape ::after references read as tokens, never
   bare rgba. */
--tape-fill: rgba(255, 255, 255, 0.4);
--tape-edge: rgba(255, 255, 255, 0.3);
--tape-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);

/* Dashed-ink hairlines — warm ink at low alpha for sticky dividers / dashed
   rules. Tokenized so components and §I chrome share one value (no bare rgba). */
--ink-hairline: rgba(45, 42, 38, 0.2);
--ink-hairline-soft: rgba(45, 42, 38, 0.1);

/* Tilt presets — apply via transform on the sticky element. Hero / statement:
   small (±1-3°). Accent / floating / closing: larger (±5-15°). */
--tilt-quiet-l: -1.5deg;
--tilt-quiet-r: 1.5deg;
--tilt-loud-l: -8deg;
--tilt-loud-r: 8deg;
--tilt-wild-l: -14deg;
--tilt-wild-r: 14deg;

/* Geometry — pin, tape, feature-icon, doodle stroke */
--pin-size: 16px;
--pin-top: -12px;
--tape-w: 80px;
--tape-h: 25px;
--tape-top: -15px;
--tape-rot: -2deg;
--feature-icon-size: 60px;
--feature-icon-border: 3px solid var(--ink-warm);
--doodle-stroke: 3px;
--doodle-opacity: 0.15;

/* Spacing — clamp the post-it padding scale */
--gap-slide: 3rem;
--pad-postit-lg: 3rem 4rem;
--pad-postit-md: 2.5rem;
--pad-postit-sm: 1.5rem;
--pad-postit-statement: 3.5rem 4rem;
--gap-cluster: 2.5rem;
```

## §D Font pairing fallback (if brand fonts not on Google Fonts)

Scatterbrain forces its display / body / script regardless of site DNA — the workshop voice depends on Shrikhand's chunky decorative shapes, Zilla Slab's warm slabs, and Caveat's casual cursive. Fallbacks below are only used if the primary face fails to load.

- **display**: `'Shrikhand'` · `'Fraunces'` · `'Lobster'` wght 400
- **body**: `'Zilla Slab'` · `'Roboto Slab'` · `'Bitter'` wght 400
- **mono**: `'Caveat'` · `'Patrick Hand'` · `'Kalam'` wght 500

(The "mono" slot is reused for the script face — Scatterbrain has no monospace need, but `resolveFont()` reads three roles. The fallback chain stays on hand-script.)

## §T Type-role atlas (Phase 4b reads this to size text correctly)

The atlas is the **sole authoring source** for non-component text. If a scene needs a `stat-value` numeral that isn't covered by §6 components, the worker reads role `stat-value` here and writes inline CSS from these values. Do NOT invent ad-hoc sizes — Scatterbrain's identity collapses if Shrikhand drops out of headline roles or if body copy slips into Shrikhand.

```type-roles
[
  {
    "id": "display-hero",
    "family": "display",
    "purpose": "cover / closing oversized headline — Shrikhand on a hero sticky",
    "px_min": 40, "px_max": 72, "weight": 400, "leading": "1.1", "tracking": "0.02em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-display-hero\">Design together.</div>"
  },
  {
    "id": "statement",
    "family": "display",
    "purpose": "centered manifesto / pulled-quote statement",
    "px_min": 32, "px_max": 56, "weight": 400, "leading": "1.1", "tracking": "0.02em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-statement\">Pin it. Share it. Ship it.</div>"
  },
  {
    "id": "headline",
    "family": "display",
    "purpose": "primary slide / section headline inside a post-it",
    "px_min": 28, "px_max": 48, "weight": 400, "leading": "1.1", "tracking": "0.02em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-headline\">Section title</div>"
  },
  {
    "id": "title",
    "family": "display",
    "purpose": "sub-region or feature-card title",
    "px_min": 24, "px_max": 32, "weight": 400, "leading": "1.1", "tracking": "0.02em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-title\">Feature title</div>"
  },
  {
    "id": "stat-value",
    "family": "display",
    "purpose": "numeric stat value inside a stat-row (Shrikhand)",
    "px_min": 28, "px_max": 44, "weight": 400, "leading": "1.1", "tracking": "0.02em", "case": "upper",
    "sample_html": "<div class=\"t-trole-stat-value\">128K USERS</div>"
  },
  {
    "id": "list-item",
    "family": "body",
    "purpose": "bullet / check-marked list row inside a sticky",
    "px_min": 24, "px_max": 26, "weight": 400, "leading": "1.6", "tracking": "0", "case": "sentence",
    "sample_html": "<ul class=\"t-trole-list-item\"><li>One sticky per idea.</li><li>Pin it. Tape it.</li><li>Step back. Look.</li></ul>"
  },
  {
    "id": "handwritten",
    "family": "script",
    "purpose": "casual side quip / decorative annotation (Caveat 400)",
    "px_min": 24, "px_max": 30, "weight": 400, "leading": "1.4", "tracking": "0", "case": "sentence",
    "sample_html": "<div class=\"t-trole-handwritten\">jot it down before you forget :)</div>"
  },
  {
    "id": "handwritten-lg",
    "family": "script",
    "purpose": "larger handwritten subtitle / hero quip (Caveat 600)",
    "px_min": 24, "px_max": 32, "weight": 600, "leading": "1.3", "tracking": "0", "case": "sentence",
    "sample_html": "<div class=\"t-trole-handwritten-lg\">like a whiteboard, but online</div>"
  },
  {
    "id": "label-script",
    "family": "script",
    "purpose": "tracked-caps eyebrow above a card headline (Caveat uppercase, 0.15em)",
    "px_min": 24, "px_max": 26, "weight": 400, "leading": "1.2", "tracking": "0.15em", "case": "upper",
    "sample_html": "<div class=\"t-trole-label-script\">The brief — chapter one</div>"
  },
  {
    "id": "feature-icon-glyph",
    "family": "display",
    "purpose": "single-character glyph inside a 60px round ink-bordered feature icon",
    "px_min": 24, "px_max": 30, "weight": 400, "leading": "1", "tracking": "0", "case": "upper",
    "sample_html": "<div><span class=\"t-trole-feature-icon-glyph\">A</span></div>"
  },
  {
    "id": "versus-mark",
    "family": "display",
    "purpose": "compare-circle connector text (cream on ink, Shrikhand)",
    "px_min": 24, "px_max": 28, "weight": 400, "leading": "1", "tracking": "0.02em", "case": "lower",
    "sample_html": "<div><span class=\"t-trole-versus-mark\">vs</span></div>"
  }
]
```

## §E Motion (GSAP consts — REPLACES site ease)

```js
const EASE = {
  entry: "back.out(1.6)", // sticky "lands" with a tiny bounce — hand-placed feel
  emphasis: "back.out(1.4)", // pin/tape attach beats, doodle reveals
  exit: "power2.in", // sticky lifts off cleanly on exit
  drift: "sine.inOut", // doodle / handwritten quip ambient sway
};
const DUR = {
  snap: 0.18,
  med: 0.5,
  slow: 0.9,
};
// RULE: entry uses back.out — the sticky must land with a small overshoot.
//       Never ease-in-out for primary motion; the sticky reads as floating instead of pinned.
// RULE: tilt is part of the resting state, NOT animated. Set transform: rotate(<tilt>)
//       at scene start; do not tween rotation between values. The whole point is "hand-placed
//       and left alone" — a sticky that wiggles reads as broken.
// RULE: scene transitions are quick cuts (≤ 0.18s) with a tape-rip beat. No crossfade,
//       no slide between scenes — crossfade kills the tactile register.
// RULE: pin attaches AFTER the sticky lands. Stagger pin reveal ~80ms behind the sticky
//       so the eye reads "sticky placed → pin pressed in".
```

### §E.5 Motion choreography

**Allowed primitives**

- Sticky entry: `back.out(1.6)`, ~0.5s, from offset (translateY +24px, opacity 0). Tilt is set at landing, not animated.
- Pin attach: `back.out(1.4)`, ~0.18s, scale 0 → 1, ~80ms after sticky lands.
- Tape attach: same as pin but ~120ms later, with a tiny rotation jiggle (-3° → -2°).
- Handwritten Caveat lines reveal with a brief x-offset (translateX -8px → 0) on `power2.out`.
- Doodle stroke drift: `sine.inOut`, ~3s, ±2° rotation around its center — ambient only.
- Stat numerals: count-up on `power2.out`, ~0.6s, snap to final value.

**Forbidden**

- Crossfade, dissolve, blur transitions between scenes.
- Sub-degree rotation tweens on a sticky (a sticky that wiggles reads as broken).
- Glow, neon, hard-offset zero-blur shadows (the wrong preset).
- Border-radius on post-its (every sticky is a rectangle, only icons / pins / versus-circles are round).
- More than 6 post-its visible at once — the playful energy collapses into chaos.
- Uniform tilt direction across adjacent stickies — alternate ± per neighbor.

**Stagger budget**

120-160ms between cluster items (sticky → pin → tape, then next sticky). Total scene-in stagger ≤ 700ms. Doodles always last, after all stickies have landed.

## §G Voice transform recipe

Take the brand's product description / value prop. Transform with:

1. Strip corporate hedges ("solution", "platform", "leverage", "synergy"). Keep concrete nouns + verbs.
2. Hero headlines: 2-5 words, **mixed case** (NOT uppercase — Shrikhand is loud enough; uppercase reads as shouting and kills the workshop register).
3. Eyebrow labels: short categorical words in Caveat, UPPERCASE with 0.15em tracking (`THE BRIEF`, `CHAPTER ONE`, `01 / DISCOVERY`). This is the only place uppercase appears.
4. Body paragraphs: Zilla Slab sentence case, conversational. Write like a designer explaining their notes to a peer, not like marketing copy.
5. Personal quips in Caveat: 2-6 words, lowercase, with personality ("jot it down before you forget", "pin this somewhere safe", "ok :)"). One per scene maximum.
6. Stat values: numeric + UPPERCASE one-word unit (`128K USERS`, `4.8 STARS`). Stat labels in Zilla Slab sentence case.

**Example:**

- IN: `Figma helps teams design products collaboratively in real time`
- OUT: hero=`Design together.` / eyebrow=`THE TEAM SPACE` / body=`Every cursor, every comment, every revision — visible to the whole crew.` / quip=`like a whiteboard, but online :)`

## §I Page-level CSS (overrides design.html's neutral chrome — makes the doc itself read as scatterbrain)

```css
/* ── Preset-native typography vars (loaded via preset-meta.chromeFonts.googleFontsHref).
 * These let the doc chrome render in Shrikhand / Zilla Slab / Caveat regardless
 * of brand DNA. The §6 component preview and §T type-role atlas
 * also read these via .preset-native-scope.
 *
 * Scatterbrain has no machine-mono moment — the mono slot falls back to Caveat
 * (the system's hand-script) per §D's three-slot contract. Fallback chains end
 * in a face that still carries the preset's vibe (Fraunces / Lobster display;
 * Roboto Slab / Bitter body; Patrick Hand / Kalam script). Falling all the way
 * to generic should never happen in practice. */
:root {
  --f-disp-native: "Shrikhand", "Fraunces", "Lobster", "Georgia", "Times New Roman", serif;
  --f-body-native: "Zilla Slab", "Roboto Slab", "Bitter", "Georgia", "Times New Roman", serif;
  --f-script-native: "Caveat", "Patrick Hand", "Kalam", "Brush Script MT", "Comic Sans MS", cursive;
  --f-mono-native: "Caveat", "Patrick Hand", "Kalam", "Brush Script MT", "Comic Sans MS", cursive;
}

/* .preset-native-scope: re-bind brand DNA font tokens to preset-native families.
 * Wraps §6 component previews and §T type-role atlas so
 * var(--font-*) resolves to Shrikhand / Zilla Slab / Caveat regardless of the
 * brand DNA tokens emitted in :root. The paste-ready component source is
 * untouched — Phase 4b still grep + paste original var(--font-display) tokens,
 * which resolve to brand DNA at scene-render time. */
.preset-native-scope {
  --font-display: var(--f-disp-native);
  --font-body: var(--f-body-native);
  --font-script: var(--f-script-native);
  --font-mono: var(--f-mono-native);
}

body {
  background: var(--paper-cream);
  position: relative;
}
body::before {
  /* Paper grain on design.html itself */
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
  opacity: 0.04;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat: repeat;
  background-size: 200px 200px;
}
.title-card {
  background: var(--paper-cream-deep);
  border-bottom: none;
  padding: 96px 0 80px;
}
.title-display {
  font-family: "Shrikhand", cursive;
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--ink-warm);
}
.brand-name {
  color: var(--brand-primary);
  font-weight: 400;
}
.style-name {
  color: var(--brand-secondary);
  font-weight: 400;
}
.ds-section {
  border-top: 1px dashed var(--ink-hairline);
  padding: 80px 0;
}
h2 {
  font-family: "Shrikhand", cursive;
  color: var(--ink-warm);
  letter-spacing: 0.02em;
}
.eyebrow {
  font-family: "Caveat", cursive;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--ink-warm-light);
  font-weight: 500;
}
.type-card,
.voice-pair,
.comp-card {
  background: var(--sticky-butter) !important;
  border: none !important;
  border-radius: 0 !important;
  box-shadow: var(--shadow-sticky) !important;
  transform: rotate(-0.5deg);
}
.type-card:nth-child(even),
.voice-pair:nth-child(even),
.comp-card:nth-child(even) {
  background: var(--sticky-sky) !important;
  transform: rotate(0.8deg);
}
/* dna-swatch keeps inline brand-color background — only sticky-tilt + shadow */
.dna-swatch {
  border: none !important;
  border-radius: 0 !important;
  box-shadow: var(--shadow-sticky) !important;
  transform: rotate(-0.5deg);
}
.dna-swatch:nth-child(even) {
  transform: rotate(0.8deg);
}
.comp-head {
  background: transparent !important;
  color: var(--ink-warm) !important;
  border-bottom: 1px dashed var(--ink-hairline) !important;
  font-family: "Shrikhand", cursive;
}
.ds-code {
  background: var(--photo-paper) !important;
  border: none !important;
  border-radius: 0 !important;
  box-shadow: var(--shadow-sticky);
  color: var(--ink-warm) !important;
  font-family: "Caveat", "Courier New", monospace;
}

/* ── §T Type-role atlas. Container = cream sticky-card. Each .t-trole-* class
 * encodes the role's family / size / weight / leading / tracking / case /
 * decoration. Family selectors use var(--font-*) tokens so the atlas renders
 * in BRAND DNA fonts; only the recipe is preset-declared. Decoration (color,
 * shadow, rotation, feature-icon round border, versus-circle fill) is
 * preset-native and stays declared with hard-coded scatterbrain tokens
 * (var(--ink-warm), var(--paper-cream), etc). */
.ds-trole-box {
  display: flex;
  flex-direction: column;
  border: none;
  border-radius: 0;
  background: var(--paper-cream-deep);
  box-shadow: var(--shadow-sticky);
  overflow: hidden;
  margin-top: 24px;
}
.ds-trole-row {
  padding: 28px 32px;
}
.ds-trole-row:not(:last-child) {
  border-bottom: 1px dashed var(--ink-hairline);
}
.ds-trole-sample {
  min-width: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 960px) {
  .ds-trole-row {
    padding: 24px;
  }
}

/* ── Type-role samples. Each .t-trole-* class mirrors a scatterbrain type-scale
 * entry but uses var(--font-display/body/script) so the actual typeface comes
 * from brand DNA. Color stays preset-native (ink-warm on pastel-ish surfaces). */
.t-trole-display-hero {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(40px, 5vw, 72px);
  line-height: 1.1;
  letter-spacing: 0.02em;
  color: var(--ink-warm);
}
.t-trole-statement {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(32px, 4vw, 56px);
  line-height: 1.1;
  letter-spacing: 0.02em;
  color: var(--ink-warm);
}
.t-trole-headline {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(28px, 3.5vw, 48px);
  line-height: 1.1;
  letter-spacing: 0.02em;
  color: var(--ink-warm);
}
.t-trole-title {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(24px, 2.5vw, 32px);
  line-height: 1.1;
  letter-spacing: 0.02em;
  color: var(--ink-warm);
}
.t-trole-stat-value {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(28px, 3vw, 44px);
  line-height: 1.1;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--ink-warm);
}
.t-trole-list-item {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.t-trole-list-item li {
  font-family: var(--font-body);
  font-weight: 400;
  font-size: clamp(24px, 1.4vw, 26px);
  line-height: 1.6;
  color: var(--ink-warm);
  padding-left: 1.3em;
  position: relative;
}
.t-trole-list-item li::before {
  content: "•";
  position: absolute;
  left: 0;
  color: var(--ink-warm);
  font-weight: 700;
}
.t-trole-handwritten {
  font-family: var(--font-script);
  font-weight: 400;
  font-size: clamp(24px, 2vw, 30px);
  line-height: 1.4;
  color: var(--ink-warm);
}
.t-trole-handwritten-lg {
  font-family: var(--font-script);
  font-weight: 600;
  font-size: clamp(24px, 2.5vw, 32px);
  line-height: 1.3;
  color: var(--ink-warm);
}
.t-trole-label-script {
  display: inline-block;
  font-family: var(--font-script);
  font-weight: 400;
  font-size: clamp(24px, 1.4vw, 26px);
  line-height: 1.2;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--ink-warm-light);
}
.t-trole-feature-icon-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  border: 3px solid var(--ink-warm);
  border-radius: 50%;
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(24px, 2vw, 30px);
  line-height: 1;
  color: var(--ink-warm);
  background: transparent;
}
.t-trole-versus-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(24px, 1.6vw, 28px);
  line-height: 1;
  letter-spacing: 0.02em;
  background: var(--ink-warm);
  color: var(--paper-cream);
  box-shadow: 0 2px 8px var(--shadow-paper-deep);
}
```
