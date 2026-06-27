```preset-meta
{
  "name": "block-frame",
  "label": "Block Frame",
  "fingerprint": {
    "shadow": "hard-offset-black",
    "border": "4px-solid-ink",
    "palette": "saturated-pastel-cycle",
    "motion": "tilt-and-snap",
    "decoration": "tilted-puncture"
  },
  "match_signals": [
    { "kind": "shadow_zero_blur", "weight": 0.3 },
    { "kind": "thick_solid_border", "weight": 0.3 },
    { "kind": "high_sat_accent", "weight": 0.15 },
    { "kind": "minimal_decoration", "weight": 0.05 }
  ],
  "best_for": ["indie SaaS launches", "agency credentials", "creative reviews", "brand redesigns", "design-led product talks"],
  "avoid_for": ["regulated disclosures", "formal legal briefs", "institutional restraint", "enterprise compliance"],
  "chromeFonts": {
    "googleFontsHref": "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Space+Grotesk:wght@400;500;600;700&display=swap",
    "display": "Inter",
    "body": "Inter",
    "script": "Inter",
    "mono": "Space Grotesk"
  },
  "palette": {
    "primary": { "value": "#FE90E8", "constraint": "hot pink — the dominant pastel ground and icon-square fill; lead color in the full-bleed slide-ground cycle" },
    "secondary": { "value": "#C0F7FE", "constraint": "sky blue — the 2nd brand hue: the colored 12px close-frame shadow and the stat-deco-dot fill; cool counterpoint cycled as a secondary ground" },
    "accent": { "value": "#F7CB46", "constraint": "golden yellow — the CTA color: default button fill, list-number squares, label-pill fill; the brightest, most attention-pulling pastel" },
    "canvas": { "value": "#FFFDF5", "lock": "anchor", "constraint": "warm off-white — the neutral ground between colored slides; keep warm, never stark white" },
    "surface": { "value": "#FFFFFF", "constraint": "pure white — the default card fill, label-pill and nav-button background" },
    "ink": { "value": "#000000", "constraint": "pure black, no warm bias — every 4px border, every zero-blur offset shadow, every primary text moment; the system's contrast anchor" }
  }
}
```

> `chromeFonts` makes the doc chrome render in the preset's native fonts; brand fonts still apply to §6 components. Block Frame refuses a third face — the `script` slot points at Inter.

## §A Director's intent

Block Frame is maximalist neobrutalism: every region wears a 4px solid ink
border, every elevated card carries an 8px hard offset shadow (zero blur,
solid ink), every corner is square, and the canvas cycles through five
saturated pastels — pink, blue, green, yellow, cream — plus off-white and
ink. Display is heavy uppercase Inter with negative tracking; chrome is
wide-tracked Space Grotesk in caps. Decorative tilts (±2° to ±12°),
star-bursts, stripe blocks, and dot grids puncture the grid intentionally.
Density is the rule, not the exception.

Brand-aware color contract: `--brand-primary` is the dominant pastel
ground, `--brand-secondary` is the colored-shadow accent (replaces the
template's signature yellow shadow on the close-frame), `--brand-accent`
is the CTA fill. Class prefix is `bf-` (block-frame initials).

## §B Decoration tokens

```css
/* Border ladder — 4px primary, 3px secondary, 2px atomic chrome */
--bf-border-bold: 4px solid var(--ink);
--bf-border-mid: 3px solid var(--ink);
--bf-border-thin: 2px solid var(--ink);

/* Hard offset shadow stack — solid ink, zero blur, bottom-right */
--bf-shadow: 8px 8px 0 var(--ink);
--bf-shadow-sm: 4px 4px 0 var(--ink);
--bf-shadow-hover: 6px 6px 0 var(--ink);

/* Inverted close-surface depth — only colored shadow in the system,
   aliased to brand-secondary so it follows the site palette instead
   of the template's locked yellow. */
--bf-shadow-close: 12px 12px 0 var(--brand-secondary);
--bf-shadow-close-btn: 6px 6px 0 var(--canvas);

/* Tilt vocabulary — stat cards alternate small, decorations tilt loud */
--bf-tilt-sm-l: -2deg;
--bf-tilt-sm-r: 2deg;
--bf-tilt-md-l: -8deg;
--bf-tilt-md-r: 8deg;
--bf-tilt-loud: 12deg;

/* Spacing — template's px scale, kept px for structural fidelity */
--bf-pad-card: 36px;
--bf-pad-card-sm: 28px;
--bf-pad-card-xs: 22px;
--bf-pad-card-lg: 60px;
--bf-gap-lg: 48px;
--bf-gap-md: 32px;
--bf-gap-sm: 24px;
--bf-gap-xs: 16px;

/* Decorative dot-grid pattern unit */
--bf-dot-size: 24px;
--bf-dot-radius: 1.2px;
```

## §D Font pairing fallback

- **display**: `'Inter'` · `'Archivo Black'` · `'Space Grotesk'` wght 900
- **body**: `'Inter'` · `'IBM Plex Sans'` wght 500
- **mono**: `'Space Grotesk'` · `'JetBrains Mono'` · `'IBM Plex Mono'` wght 600

## §T Type-role atlas (Phase 4b reads this to size text correctly)

Sole authoring source for non-component text; do NOT invent ad-hoc sizes — Block Frame's identity depends on the heavy-uppercase + negative-tracking + sentence-body + wide-tracked-label ladder.

```type-roles
[
  {
    "id": "heading-xl",
    "family": "display",
    "purpose": "hero / cover headline — uppercase Inter 900 with negative tracking",
    "px_min": 48, "px_max": 96, "weight": 900, "leading": "0.95", "tracking": "-0.03em", "case": "upper",
    "sample_html": "<div class=\"t-trole-heading-xl\">Neo-Brutalism Style</div>"
  },
  {
    "id": "heading-lg",
    "family": "display",
    "purpose": "primary section headline (Inter 800, uppercase, -0.02em)",
    "px_min": 32, "px_max": 64, "weight": 800, "leading": "1", "tracking": "-0.02em", "case": "upper",
    "sample_html": "<div class=\"t-trole-heading-lg\">What we deliver</div>"
  },
  {
    "id": "heading-md",
    "family": "display",
    "purpose": "region or chart title (Inter 700, sentence-case allowed)",
    "px_min": 24, "px_max": 40, "weight": 700, "leading": "1.1", "tracking": "-0.01em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-heading-md\">Quarterly growth metrics</div>"
  },
  {
    "id": "close-title",
    "family": "display",
    "purpose": "closing-statement title on the inverted ink surface (cream / canvas text)",
    "px_min": 40, "px_max": 80, "weight": 900, "leading": "0.95", "tracking": "-0.03em", "case": "upper",
    "sample_html": "<div class=\"t-trole-close-title\">Let's build something bold</div>"
  },
  {
    "id": "quote-text",
    "family": "display",
    "purpose": "uppercase pull-quote body (Inter 900, framed inside a bordered quote-frame)",
    "px_min": 28, "px_max": 52, "weight": 900, "leading": "1.15", "tracking": "-0.02em", "case": "upper",
    "sample_html": "<div class=\"t-trole-quote-text\">Design is how it works, how it feels, how it lasts.</div>"
  },
  {
    "id": "stat-number",
    "family": "display",
    "purpose": "hero / card stat numeral (Inter 900, line-height 1)",
    "px_min": 36, "px_max": 64, "weight": 900, "leading": "1", "tracking": "0", "case": "upper",
    "sample_html": "<div class=\"t-trole-stat-number\">98%</div>"
  },
  {
    "id": "card-title",
    "family": "display",
    "purpose": "feature / intro / team card title — Inter 700 uppercase",
    "px_min": 24, "px_max": 28, "weight": 700, "leading": "1.2", "tracking": "0", "case": "upper",
    "sample_html": "<div class=\"t-trole-card-title\">Modular layouts</div>"
  },
  {
    "id": "step-num",
    "family": "display",
    "purpose": "timeline-step numeral — Inter 900 at 0.6 opacity (mandatory reduction)",
    "px_min": 48, "px_max": 48, "weight": 900, "leading": "1", "tracking": "0", "case": "upper",
    "sample_html": "<div class=\"t-trole-step-num\">01</div>"
  },
  {
    "id": "label-pill",
    "family": "mono",
    "purpose": "universal eyebrow inside a bordered + shadowed pastel pill — Space Grotesk 600, 13px, 0.08em tracked, uppercase",
    "px_min": 24, "px_max": 24, "weight": 600, "leading": "1", "tracking": "0.08em", "case": "upper",
    "sample_html": "<div><span class=\"t-trole-label-pill\">Overview</span></div>"
  },
  {
    "id": "mono-tag",
    "family": "mono",
    "purpose": "mono tag / badge — Space Grotesk 600, 14px, 0.05em tracked, uppercase",
    "px_min": 24, "px_max": 24, "weight": 600, "leading": "1", "tracking": "0.05em", "case": "upper",
    "sample_html": "<div class=\"t-trole-mono-tag\">12+ years</div>"
  },
  {
    "id": "counter",
    "family": "mono",
    "purpose": "persistent slide counter — Space Grotesk 700, 14px, 0.1em tracked, uppercase (NN / NN)",
    "px_min": 24, "px_max": 24, "weight": 700, "leading": "1", "tracking": "0.1em", "case": "upper",
    "sample_html": "<div class=\"t-trole-counter\">01 / 10</div>"
  }
]
```

## §E Motion (GSAP consts — REPLACES site ease)

```js
// RULE: motion is snap-and-hit, never slow ease-in-out for primary entrances.
// RULE: cards "punch in" — translate from -8/-8 offset with shadow growing
//       from 0 to var(--bf-shadow). Mirrors the hover lift-up signature.
// RULE: tilts are baked at rest; do NOT tween rotation during entry.
//       Tilt-then-pop reads as wobble; tilt-at-rest reads as deliberate.
// RULE: emphasis on chrome (label-pills, buttons) uses back.out(1.6) to
//       echo the hard-shadow "stamp" feel.
// RULE: never blur shadows during motion — toggle box-shadow values, do
//       not interpolate filter() or use shadow-blur tweens.

const EASE = {
  entry: "expo.out", // cards hit and stick — template uses 0.15s ease but punchier on video scale
  emphasis: "back.out(1.6)", // chrome pops (pills, buttons, stat cards) — echoes the brutalist stamp
  exit: "power2.in", // sharp exits — never linger
  drift: "sine.inOut", // ambient (dot-grid fade-in, tilt micro-sway) only
};

const DUR = {
  snap: 0.16, // chrome hover, label-pill in, button settle — mirrors template's 0.15s
  med: 0.42, // card entry, headline reveal
  slow: 0.9, // hero entry, close-frame reveal — the loudest moments
};
```

### §E.5 Motion choreography

- **Transition defaults:** hard cut between scenes is the spiritual default. If a transition is needed, punch-translate the incoming hero element with DUR.med + EASE.emphasis.
- **Type-in-motion:** display headlines reveal as a single unit (no per-
  character split). Sub-headline reveals at +0.12s with `power2.out` +
  DUR.snap. Label-pills always emphasis-pop, never linear-fade.
- **Stagger budget:** ≤6 elements in a single stagger; beyond that, group
  visually (timeline-step row, stat-grid) and animate the group as one.

## §G Voice transform recipe

1. Strip articles and connectives (the / a / of / and / with / to).
2. Break into 2-4 word noun-verb-noun fragments or single dominant nouns.
3. UPPERCASE all on-screen text that lands in display, chip, or button
   slots — sentence body stays sentence case.
4. Join fragments with `.` + linebreak for stacked impact, or em-dash
   `—` for a single beat of emphasis.
5. End headlines on a noun, not a verb — the brutalist stamp lands on the
   thing, not the action.
6. Brand name appears as the final clause, punctuated standalone.

**Example:**

- IN: `Higgsfield is the AI platform that helps creators generate stunning visuals in seconds`
- OUT: `CREATORS. GENERATE. STUNNING VISUALS — IN SECONDS. HIGGSFIELD.`

## §I Page-level CSS

```css
/* ── Preset-native typography vars (loaded via preset-meta.chromeFonts.googleFontsHref).
 * These let the doc chrome render in Inter + Space Grotesk regardless of
 * brand DNA. The §6 component preview and §T type-role atlas also read
 * these via .preset-native-scope.
 *
 * Block Frame has no script face — the script slot points at Inter because the
 * preset refuses a third face. The fallback chain ends in a heavy grotesque
 * (Archivo Black / system-ui) that still carries the "neobrutalist mass"
 * register. Mono slot is Space Grotesk (treated as quasi-mono via wide
 * tracking + uppercase) with JetBrains Mono / IBM Plex Mono as deeper falls. */
:root {
  --f-disp-native:
    "Inter", "Archivo Black", "Helvetica Neue", -apple-system, BlinkMacSystemFont, system-ui,
    sans-serif;
  --f-body-native:
    "Inter", "IBM Plex Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --f-script-native:
    "Inter", "Archivo Black", "Helvetica Neue", -apple-system, BlinkMacSystemFont, system-ui,
    sans-serif;
  --f-mono-native:
    "Space Grotesk", "JetBrains Mono", "IBM Plex Mono", "Menlo", ui-monospace, monospace;
}

/* .preset-native-scope: re-bind font tokens to preset-native families for §6 previews + §T atlas. */
.preset-native-scope {
  --font-display: var(--f-disp-native);
  --font-body: var(--f-body-native);
  --font-script: var(--f-script-native);
  --font-mono: var(--f-mono-native);
}

/* design.html chrome — borrows the preset's visual register */
body {
  background: var(--canvas, #fffdf5);
  font-family: "Inter", sans-serif;
  color: var(--ink, #000);
}

h1,
h2,
h3 {
  font-family: "Inter", sans-serif;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: -0.02em;
}

h2 {
  border-bottom: var(--bf-border-bold, 4px solid #000);
  padding-bottom: 0.4em;
  margin-top: 1.4em;
}

code,
pre {
  font-family: "Space Grotesk", monospace;
  background: color-mix(in srgb, var(--brand-primary, #fe90e8) 12%, transparent);
  border: var(--bf-border-mid, 3px solid #000);
  padding: 0.1em 0.4em;
}

pre {
  padding: 1em;
  box-shadow: var(--bf-shadow-sm, 4px 4px 0 #000);
}

/* ── §T Type-role atlas. Container = bordered + shadowed canvas card. */
.ds-trole-box {
  display: flex;
  flex-direction: column;
  border: var(--bf-border-bold, 4px solid var(--ink));
  border-radius: 0;
  background: var(--canvas, #fffdf5);
  box-shadow: var(--bf-shadow, 8px 8px 0 var(--ink));
  overflow: hidden;
  margin-top: 24px;
}
.ds-trole-row {
  padding: 28px 32px;
  border-bottom: var(--bf-border-thin, 2px solid var(--ink));
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
.t-trole-heading-xl {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: clamp(48px, 6vw, 96px);
  line-height: 0.95;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  color: var(--ink);
}
.t-trole-heading-lg {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(32px, 4vw, 64px);
  line-height: 1;
  letter-spacing: -0.02em;
  text-transform: uppercase;
  color: var(--ink);
}
.t-trole-heading-md {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(24px, 2.5vw, 40px);
  line-height: 1.1;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.t-trole-close-title {
  display: inline-block;
  font-family: var(--font-display);
  font-weight: 900;
  font-size: clamp(40px, 5vw, 80px);
  line-height: 0.95;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  color: var(--canvas, #fffdf5);
  background: var(--ink);
  border: 4px solid var(--canvas, #fffdf5);
  box-shadow: 12px 12px 0 var(--brand-secondary, var(--brand-primary));
  padding: 24px 32px;
  max-width: 22ch;
}
.t-trole-quote-text {
  display: inline-block;
  font-family: var(--font-display);
  font-weight: 900;
  font-size: clamp(28px, 3.5vw, 52px);
  line-height: 1.15;
  letter-spacing: -0.02em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--canvas, #fffdf5);
  border: 4px solid var(--ink);
  box-shadow: 8px 8px 0 var(--ink);
  padding: 24px 32px;
  max-width: 28ch;
}
.t-trole-stat-number {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: clamp(36px, 4vw, 64px);
  line-height: 1;
  color: var(--ink);
}
.t-trole-card-title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 28px;
  line-height: 1.2;
  text-transform: uppercase;
  color: var(--ink);
}
.t-trole-step-num {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: 48px;
  line-height: 1;
  color: var(--ink);
  opacity: 0.6;
}
.t-trole-label-pill {
  display: inline-block;
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 24px;
  line-height: 1;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--brand-primary);
  border: 3px solid var(--ink);
  box-shadow: 4px 4px 0 var(--ink);
  padding: 6px 16px;
}
.t-trole-mono-tag {
  display: inline-block;
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 24px;
  line-height: 1;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--brand-accent, var(--brand-primary));
  border: 3px solid var(--ink);
  padding: 10px 20px;
}
.t-trole-counter {
  display: inline-block;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 24px;
  line-height: 1;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--canvas, #fffdf5);
  border: 3px solid var(--ink);
  box-shadow: 4px 4px 0 var(--ink);
  padding: 10px 18px;
}
```

</content>
</invoke>
