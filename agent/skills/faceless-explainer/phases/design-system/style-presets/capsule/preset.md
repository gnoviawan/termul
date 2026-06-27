```preset-meta
{
  "name": "capsule",
  "label": "Capsule",
  "fingerprint": {
    "geometry": "universal-pill",
    "shadow": "soft-offset-low-opacity",
    "type": "didone-serif-plus-grotesk",
    "decoration": "floating-pill-wallpaper"
  },
  "match_signals": [
    { "kind": "shadow_zero_blur", "weight": 0.3 },
    { "kind": "serif_display", "weight": 0.25 },
    { "kind": "medium_solid_border", "weight": 0.15 }
  ],
  "best_for": ["lifestyle brands", "creator portfolios", "DTC product launches", "beauty", "wellness", "playful tech demos"],
  "avoid_for": ["institutional gravitas", "enterprise security", "edge-and-weight registers", "industrial / hardware"],
  "chromeFonts": {
    "googleFontsHref": "https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..900;1,6..96,400..900&family=Space+Grotesk:wght@300..700&family=Space+Mono:wght@400;500;700&display=swap",
    "display": "Bodoni Moda",
    "body": "Space Grotesk",
    "script": "Bodoni Moda",
    "mono": "Space Mono"
  },
  "palette": {
    "primary": { "value": "#E85D4E", "constraint": "warm coral — the lead 'voice-y' candy; first pill fill in cycles, the most frequent stat numeral and accent-line color; color lives inside pills, never on type" },
    "secondary": { "value": "#F2D160", "constraint": "warm yellow — the source's title-pill / hero-pill default fill and the 'second pop' in card-icon and pill cycles" },
    "accent": { "value": "#8BB4F7", "constraint": "cornflower sky — the cool 'third accent' that sits beside coral+yellow in 3-up grids; the single high-attention pop on chips and stat-bar accents" },
    "canvas": { "value": "#F5F5F0", "lock": "anchor", "constraint": "warm bone — sun-bleached magazine-paper ground; reads as paper, not screen-white; keep warm, never replace with stark white" },
    "surface": { "value": "#FFFFFF", "constraint": "clean white — pill-card / stat-tile fill that lifts off the bone canvas with a low-opacity hard-offset shadow" },
    "ink": { "value": "#1A1A1A", "constraint": "near-black — every Bodoni headline, body line, and the universal 2px pill outline; serifs always render in ink, never a candy color" }
  }
}
```

> `chromeFonts` makes the doc chrome render in the preset's native fonts; brand fonts still apply to §6 components. Capsule refuses a third face — italic emphasis lives inside `<em>` on the Bodoni axis, not a separate script family.

## §A Director's intent

Capsule is a playful editorial system: every text container is a pill (border-radius 9999px for small, 2rem for cards), every shape carries a 2px ink outline, every elevated surface casts a low-opacity hard-offset shadow at 4/6/8/12px. The voice is Memphis-meets-magazine — confident didone serifs (Bodoni-class) for every display moment, geometric grotesque (Space-Grotesk-class) for body and small uppercase tracked text. Color is a candy palette used as flat pill fills; serifs stay ink, color lives inside pills and on stat numerals. Motion is gentle and Material-eased — opacity-led, never bouncy, never elastic.

The class prefix is `cap-` across all components.

**Atmosphere baseline (material):** every scene carries the persistent grain overlay (4% opacity, multiply blend, fixed inset 0, z-index 9999) plus at least one soft candy radial glow (6–15% opacity). A bare cream canvas without atmosphere reads as broken.

## §B Decoration tokens

```css
/* universal pill stroke + radii */
--cap-outline-w: 2px;
--cap-radius-pill: 9999px;
--cap-radius-card: 2rem;
--cap-radius-inner: 1.5rem;

/* hard-offset shadows — ink at low opacity (follows site ink, not literal black) */
--cap-shadow-color: color-mix(in srgb, var(--ink) 8%, transparent);
--cap-shadow-sm: 4px 4px 0 var(--cap-shadow-color);
--cap-shadow-md: 6px 6px 0 var(--cap-shadow-color);
--cap-shadow-lg: 8px 8px 0 var(--cap-shadow-color);
--cap-shadow-xl: 12px 12px 0 var(--cap-shadow-color);

/* spacing */
--cap-pad-card: 2.5rem 2rem;
--cap-pad-pill-lg: 1.5rem 3.5rem;
--cap-pad-pill-md: 1rem 2.5rem;
--cap-pad-pill-sm: 0.4rem 1.2rem;
--cap-pad-pill-xs: 0.35rem 1rem;
--cap-gap-lg: 3rem;
--cap-gap-md: 2rem;
--cap-gap-sm: 1.5rem;
--cap-gap-xs: 0.75rem;

/* small accents */
--cap-accent-line-w: 60px;
--cap-accent-line-h: 4px;
--cap-step-size: 56px;
--cap-icon-size: 60px;
--cap-orbit-size: 160px;

/* tracking values for the small-text identity signal */
--cap-track-tight: -0.02em;
--cap-track-loose: 0.1em;
--cap-track-pill: 0.12em;
```

## §D Font pairing fallback

- **display**: `'Bodoni Moda'` · `'Playfair Display'` · `'Fraunces'` wght 700
- **body**: `'Space Grotesk'` · `'Inter'` · `'DM Sans'` wght 400
- **mono**: `'Space Mono'` · `'JetBrains Mono'` wght 500

## §T Type-role atlas (Phase 4b reads this to size text correctly)

Sole authoring source for non-component text; do NOT invent ad-hoc sizes — Capsule's identity collapses if Bodoni drops below weight 700 at display scale or if small Space Grotesk text loses its uppercase + tracked treatment.

```type-roles
[
  {
    "id": "display",
    "family": "display",
    "purpose": "cover / opening display headline — Bodoni 800, ink on cream (never candy color)",
    "px_min": 48, "px_max": 112, "weight": 800, "leading": "0.9", "tracking": "-0.02em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-display\">Where vision meets execution</div>"
  },
  {
    "id": "closing-display",
    "family": "display",
    "purpose": "conclusive declarative headline — slightly smaller than cover display",
    "px_min": 40, "px_max": 80, "weight": 800, "leading": "0.95", "tracking": "-0.03em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-closing-display\">Begin the next chapter</div>"
  },
  {
    "id": "headline",
    "family": "display",
    "purpose": "primary slide headline on split or two-column layouts (Bodoni 700)",
    "px_min": 32, "px_max": 56, "weight": 700, "leading": "1.05", "tracking": "-0.02em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-headline\">A pill for every story</div>"
  },
  {
    "id": "section-headline",
    "family": "display",
    "purpose": "section-opening or centered headline above cards / charts",
    "px_min": 29, "px_max": 48, "weight": 700, "leading": "1.05", "tracking": "-0.01em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-section-headline\">What we ship this season</div>"
  },
  {
    "id": "quote-display",
    "family": "display",
    "purpose": "pull-quote body (Bodoni 600; inline emphasis via quote-highlight pill, not bold)",
    "px_min": 26, "px_max": 48, "weight": 600, "leading": "1.35", "tracking": "-0.01em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-quote-display\">The pill is the page. The serif is the voice.</div>"
  },
  {
    "id": "card-headline",
    "family": "display",
    "purpose": "card or pillar-block title (Bodoni 700) — sits just above card body so the serif title reads first",
    "px_min": 24, "px_max": 28, "weight": 700, "leading": "1.1", "tracking": "0", "case": "sentence",
    "sample_html": "<div class=\"t-trole-card-headline\">Studio essentials</div>"
  },
  {
    "id": "stat-number",
    "family": "display",
    "purpose": "large numerical stat figure — colored in a brand role, never ink",
    "px_min": 32, "px_max": 48, "weight": 800, "leading": "1", "tracking": "-0.03em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-stat-number\">340%</div>"
  },
  {
    "id": "pill-text-md",
    "family": "body",
    "purpose": "text inside title / closing pills and pill-shaped callouts — uppercase Space Grotesk 600, 0.12em tracking",
    "px_min": 24, "px_max": 24, "weight": 600, "leading": "1", "tracking": "0.12em", "case": "upper",
    "sample_html": "<div><span class=\"t-trole-pill-text-md\">Now available</span></div>"
  },
  {
    "id": "label",
    "family": "body",
    "purpose": "header tag pills, eyebrows, attribution lines — uppercase tracked Space Grotesk 500 (the small-text identity signal)",
    "px_min": 24, "px_max": 24, "weight": 500, "leading": "1", "tracking": "0.1em", "case": "upper",
    "sample_html": "<div class=\"t-trole-label\">Section · 03</div>"
  }
]
```

## §E Motion (GSAP consts — REPLACES site ease)

```js
// RULE: Capsule motion is opacity-led, never bouncy. Pill geometry is friendly enough that overshoot reads as childish.
// RULE: never use back/elastic/bounce on entry — Material standard out + drift sine.inOut is the entire motion vocabulary.
// RULE: decorative floating pills only drift (sine.inOut), never enter with translate. They fade.
// RULE: stat numerals count up with power2.out, never with steps() — Bodoni serifs do not look right at staircase intermediates.
const EASE = {
  entry: "power2.out", // Material standard out (matches template's cubic-bezier(0.4, 0, 0.2, 1))
  emphasis: "expo.out", // for stat numeral count-ups + chart bar fills
  exit: "power2.in", // fade-out exits, mirrors entry curve
  drift: "sine.inOut", // ambient float on decorative pills
};

const DUR = {
  snap: 0.18, // pill-pop, chip emphasis, mini-pill stagger
  med: 0.5, // headline reveal, card entry, opacity fade (template uses 0.6s)
  slow: 1.0, // chart-bar fill sweep, stat numeral count, orbit assembly
};
```

### §E.5 Motion choreography

- Allowed primitives: opacity fade, vertical translate ≤ 24px on entry, scale 0.96 → 1.0 on emphasis pills, width tween on bar fills, count-up on numerals, slow rotation drift (±2deg) on decorative pills.
- Forbidden gestures: back/elastic/bounce overshoots, horizontal sliding entrances, blur transitions, rotation entries above 8deg.
- Scene transitions default to 0.6s cross-fade (matches the template's `cubic-bezier(0.4, 0, 0.2, 1)` slide-to-slide).
- Stagger budget: 0.06s between sibling pills, 0.12s between cards in a grid, 0.18s between timeline steps. Keep total reveal under 1.2s per scene.
- Type-in-motion: headlines fade + translateY(16px → 0). Never word-by-word reveal — Bodoni is meant to be read as a single fashioned line, not assembled.
- The grain overlay never animates. It is a flat persistent layer at opacity 0.04, multiply blend, fixed inset 0, z-index 9999.

## §G Voice transform recipe

1. Keep articles and connectives (the / a / of / and) — Capsule is editorial, not telegraphic.
2. Sentence case for Bodoni display elements (headlines, stats, card titles, quote bodies). True title case only for proper nouns inside a headline.
3. UPPERCASE + 0.08em tracking for every Space-Grotesk small-text element (chips, labels, pill text, subtitles, attribution). This is the small-text identity signal — never break it.
4. Inside Bodoni quote bodies, wrap any phrase that wants emphasis in a `quote-highlight` pill (a candy-filled inline pill). Never bold; never italicize except via the Bodoni italic axis inside `<em>`.
5. Strip the period from any chip / pill / subtitle / label. Keep the period on Bodoni quote bodies and paragraph copy.
6. Decorative floating pills carry a single uppercase word (5–9 chars). Pick atmospheric verbs and nouns ("VISION", "CREATE", "BEGIN", "NEXT"), not content-specific phrases.

**Example:**

- IN: `Higgsfield helps creative teams ship visual stories faster than ever before.`
- OUT (headline, Bodoni sentence case): `Where vision meets execution.`
- OUT (chip, Space Grotesk uppercase tracked): `CREATIVE STUDIO`
- OUT (decorative floating pill): `VISION`

## §I Page-level CSS

```css
/* ── Preset-native typography vars (loaded via preset-meta.chromeFonts.googleFontsHref).
 * These let the doc chrome render in Bodoni Moda / Space Grotesk / Space Mono
 * regardless of which brand DNA the preset is applied to. The §6 component preview
 * and §T type-role atlas also read these via .preset-native-scope.
 *
 * Capsule has no script face — the script slot points at Bodoni Moda because
 * italic emphasis rides the Bodoni opsz/italic axis inside <em>, not a third
 * family. Fallback chains end in a serif / sans / mono that still carries the
 * editorial-pill register. Falling all the way to generic should never happen
 * in practice. */
:root {
  --f-disp-native: "Bodoni Moda", "Playfair Display", "Fraunces", "Didot", "Georgia", serif;
  --f-body-native:
    "Space Grotesk", "Inter", "DM Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --f-script-native: "Bodoni Moda", "Playfair Display", "Fraunces", "Didot", "Georgia", serif;
  --f-mono-native:
    "Space Mono", "JetBrains Mono", "IBM Plex Mono", "Menlo", ui-monospace, monospace;
}

/* .preset-native-scope: re-bind font tokens to preset-native families for §6 previews + §T atlas. */
.preset-native-scope {
  --font-display: var(--f-disp-native);
  --font-body: var(--f-body-native);
  --font-script: var(--f-script-native);
  --font-mono: var(--f-mono-native);
}

/* design.html preview — make the doc itself read as Capsule */
body {
  background: var(--canvas);
}
.ds-section h2,
.ds-section h3 {
  font-family: var(--f-disp-native);
  letter-spacing: -0.01em;
}
.ds-section h2::before {
  content: "";
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 9999px;
  border: 2px solid var(--ink, #1a1a1a);
  background: var(--brand-primary, #e85d4e);
  margin-right: 0.6rem;
  vertical-align: middle;
}
.ds-code,
pre.ds-code {
  border-radius: 1.25rem;
  border: 2px solid var(--ink, #1a1a1a);
  box-shadow: 6px 6px 0 color-mix(in srgb, var(--ink) 8%, transparent);
  background: var(--canvas);
}

/* ── §T Type-role atlas. Container = 2rem-radius pill-card; rows by 2px ink hairlines. */
.ds-trole-box {
  display: flex;
  flex-direction: column;
  border: 2px solid var(--ink);
  border-radius: 2rem;
  background: #fff;
  box-shadow: 8px 8px 0 color-mix(in srgb, var(--ink) 8%, transparent);
  overflow: hidden;
  margin-top: 24px;
}
.ds-trole-row {
  padding: 28px 32px;
  border-bottom: 2px solid color-mix(in srgb, var(--ink) 12%, transparent);
}
.ds-trole-row:last-child {
  border-bottom: 0;
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

/* ── Type-role samples. var(--font-*) resolves to brand DNA; decoration is preset-native. */
.t-trole-display {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(48px, 8vw, 112px);
  line-height: 0.9;
  letter-spacing: -0.02em;
  color: var(--ink);
  max-width: 22ch;
}
.t-trole-closing-display {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(40px, 6vw, 80px);
  line-height: 0.95;
  letter-spacing: -0.03em;
  color: var(--ink);
  max-width: 22ch;
}
.t-trole-headline {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(32px, 4vw, 56px);
  line-height: 1.05;
  letter-spacing: -0.02em;
  color: var(--ink);
  max-width: 24ch;
}
.t-trole-section-headline {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(29px, 3.5vw, 48px);
  line-height: 1.05;
  letter-spacing: -0.01em;
  color: var(--ink);
  max-width: 26ch;
}
.t-trole-quote-display {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(26px, 3.5vw, 48px);
  line-height: 1.35;
  letter-spacing: -0.01em;
  color: var(--ink);
  max-width: 28ch;
}
.t-trole-card-headline {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(24px, 1.8vw, 28px);
  line-height: 1.1;
  color: var(--ink);
}
.t-trole-stat-number {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(32px, 3.5vw, 48px);
  line-height: 1;
  letter-spacing: -0.03em;
  color: var(--brand-primary);
}
.t-trole-pill-text-md {
  display: inline-block;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 24px;
  line-height: 1;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--brand-primary);
  border: 2px solid var(--ink);
  border-radius: 9999px;
  padding: 1rem 2.5rem;
  box-shadow: 6px 6px 0 color-mix(in srgb, var(--ink) 8%, transparent);
}
.t-trole-label {
  font-family: var(--font-body);
  font-weight: 500;
  font-size: 24px;
  line-height: 1;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink);
}
```
