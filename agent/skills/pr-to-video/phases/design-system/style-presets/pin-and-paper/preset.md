```preset-meta
{
  "name": "pin-and-paper",
  "label": "Pin & Paper",
  "fingerprint": {
    "surface": "yellow-paper-with-grain",
    "shadow": "hard-offset-ink-zero-blur",
    "border": "hairline-ink",
    "voice": "field-notebook-handwritten",
    "motion": "quiet-considered",
    "density": "populated-card-grid"
  },
  "match_signals": [
    { "kind": "hairline_border", "weight": 0.3 },
    { "kind": "shadow_zero_blur", "weight": 0.25 },
    { "kind": "low_saturation", "weight": 0.1 }
  ],
  "best_for": ["qualitative research", "founder reflections", "longform brand stories", "hand-crafted decks", "literary brands"],
  "avoid_for": ["digital-native polished", "rigorously data-driven", "corporate fintech", "high-energy launches"],
  "chromeFonts": {
    "googleFontsHref": "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Caveat:wght@500;600;700&family=DM+Mono:wght@400;500&display=swap",
    "display": "Space Grotesk",
    "body": "Space Grotesk",
    "script": "Caveat",
    "mono": "DM Mono"
  },
  "palette": {
    "primary": { "value": "#1F3A8A", "constraint": "deep desaturated ink — reads near-black on paper; carries every text fill, border, divider, pin illustration, and hard offset shadow" },
    "accent": { "value": "#C2342B", "constraint": "single vivid warm — used in at most two spots (the rotated rubber stamp + the negative pill); never as body text, card fill, or chip" },
    "secondary": { "value": "#C9A66B", "constraint": "muted earthy third tone (kraft / olive / orange from the source palette); structurally optional, used only when a scene needs a rare third tone" },
    "canvas": { "value": "#EFE56A", "lock": "anchor", "constraint": "warm saturated legal-pad yellow — the page ground; brand DNA tints it via color-mix() in §B, never replaces it, so the paper register survives every brand palette" },
    "surface": { "value": "#F8F1D6", "lock": "anchor", "constraint": "off-white cream — the pinned-card fill; brand DNA tints via color-mix() in §B, never replaces" },
    "ink": { "alias": "primary" }
  }
}
```

> `chromeFonts` makes the doc chrome render in the preset's native fonts; brand fonts still apply to §6 components.

## §A Director's intent

Field notebook pinned to a corkboard, not a polished deck. Every surface is **yellow legal-pad paper** with a non-optional fractal-noise grain — without the texture the system collapses into flat cartoon-yellow. Cards are **cream paper pinned to the page** with a 1.5px hairline ink border, 4px micro-radius, and a hard ink-blue offset shadow (5–8px, zero blur). The shadow is the only depth language.

Three editorial voices, each in its own face: **Space Grotesk 700** carries every printed headline (negative letter-spacing, mixed case); **Caveat** carries every handwritten moment — marginal notes, step numerals, "me" voice annotations; **DM Mono uppercase** carries every archival tag — top-chrome lockup, footer meta, date strips. Switching a voice's face collapses the register.

**Brand DNA drives the chrome color, preset drives the structure.** `--brand-primary` maps to the ink-blue role (text, borders, dividers, pin illustrations, hard offset shadow). `--brand-accent` maps to the cinnabar-red stamp role (used in exactly two places: the rotated rubber stamp and the negative pill). The yellow paper base is a **technical signature anchor** — without it the layered radial gradients, grain overlay, and cream-on-yellow card contrast all fail; declared once in §B as `--anchor-paper-yellow` / `--anchor-cream` so brand DNA can tint via `color-mix()` without losing the paper reading.

Motion is **quiet and considered** — short fades, no overshoot, no bounce. The hand-pinned aesthetic doesn't want kinetic theatrics; the camera holds and the eye reads. Ambient pin rotations drift on `sine.inOut` like paper settling.

**Density philosophy: populated, not sparse.** Pin & Paper reads as authoritative when 3–6 cards are pinned across the page, each carrying a heading + body + marginal note. A scene with one centered headline and otherwise empty space reads as broken.

## §B Decoration tokens (merge into design.html `:root`)

Pin & Paper declares **structural** tokens here (hairline border, hard offset shadow, micro-radius, pin/paper anchors). The brand-aware contract: ink-blue surfaces flow from `var(--brand-primary)`; the cinnabar-red stamp flows from `var(--brand-accent)`. The two paper-anchor hexes below are §8.2 exceptions — declared because the yellow-paper + cream-card contrast is the preset's structural signature, not a palette choice; brand DNA tints these anchors via `color-mix()` so the warm-paper register survives every brand palette.

```css
/* §8.2 exception: paper-anchor tokens. The yellow legal-pad surface and the
   cream card fill are the structural signature — without them the layered
   radial gradients, grain overlay, and cream-on-yellow card contrast all
   fail. Brand DNA tints these via color-mix() so the paper register survives
   every brand palette (dark / muted / pastel). Declared once here, never
   scattered into component CSS. */
--anchor-paper-yellow: #efe56a; /* saturated cadmium yellow — the page */
--anchor-cream: #f8f1d6; /* off-white ivory — the cards */

/* Paper surfaces — brand-tinted from the anchor so they shift with the site
   without losing the warm-paper reading. */
--surface-paper: color-mix(in srgb, var(--brand-primary) 6%, var(--anchor-paper-yellow));
--surface-paper-2: color-mix(
  in srgb,
  var(--brand-primary) 4%,
  color-mix(in srgb, var(--anchor-paper-yellow) 70%, white)
);
--surface-paper-3: color-mix(
  in srgb,
  var(--brand-primary) 8%,
  color-mix(in srgb, var(--anchor-paper-yellow) 85%, black 8%)
);
--surface-cream: color-mix(in srgb, var(--brand-primary) 4%, var(--anchor-cream));

/* The signature hard offset shadow — solid ink, zero blur. Three sizes for
   compact / standard / hero cards. Color flows from brand-primary. */
--shadow-pin-compact: 4px 5px 0 0 var(--brand-primary);
--shadow-pin-standard: 5px 6px 0 0 var(--brand-primary);
--shadow-pin-hero: 8px 9px 0 0 var(--brand-primary);

/* Hairline + dashed borders */
--border-hairline: 1.5px solid var(--brand-primary);
--border-dashed: 1.5px dashed color-mix(in srgb, var(--brand-primary) 45%, transparent);
--border-stamp: 3px solid var(--brand-accent);

/* Micro-radius — the printed-corner signal. Larger values collapse into UI. */
--radius-card: 4px;
--radius-pill: 999px;

/* Edge / card padding */
--pad-edge: 64px;
--pad-top: 110px;
--pad-bottom: 90px;
--card-pad: 28px;
--card-pad-lg: 36px 28px 28px;

/* Grid gaps */
--gap-card-sm: 22px;
--gap-card-md: 28px;
--gap-card-lg: 32px;

/* Off-axis tilts — the pinned-askew signal. Used on alternate cards, pins,
   scribbles, stamp. Never apply more than one tilt to a single element. */
--tilt-pin: -10deg;
--tilt-pin-alt: 14deg;
--tilt-card-askew: 0.9deg;
--tilt-scribble: -2deg;
--tilt-stamp: -4deg;

/* Paper-grain overlay — fractal noise data-URI, multiply blend. Non-optional
   on every scene. The blend mode flips to screen on ink-blue surfaces. */
--paper-grain: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.4' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.45  0 0 0 0 0.2  0 0 0 .25 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
```

## §D Font pairing fallback (if brand fonts not on Google Fonts)

Pin & Paper depends on the three-voice editorial pairing (printed display / handwritten / archival). Fallbacks below are only used if the brand-derived face fails to load.

- **display**: `'Space Grotesk'` · `'Inter Tight'` · `'Manrope'` wght 700
- **body**: `'Space Grotesk'` · `'Inter'` · `'IBM Plex Sans'` wght 400
- **mono**: `'DM Mono'` · `'JetBrains Mono'` · `'IBM Plex Mono'` wght 500

The handwritten layer (Caveat) is non-substitutable — if Caveat fails to load it falls through to `cursive`, which varies by OS. Component CSS forces Caveat directly; brand DNA does not override it.

## §T Type-role atlas (Phase 4b reads this to size text correctly)

The atlas is the **sole authoring source** for non-component text. If a scene needs a `number-hero` numeral that isn't covered by §6 components, the worker reads role `number-hero` here and writes inline CSS from these values. Do NOT invent ad-hoc sizes — the three-voice editorial rhythm (print headline / handwritten scribble / mono archival tag) collapses if sizes drift.

```type-roles
[
  {
    "id": "display-cover",
    "family": "display",
    "purpose": "cover hero — Space Grotesk 700 mixed case, ink-blue on yellow paper",
    "px_min": 96, "px_max": 196, "weight": 700, "leading": "1.08", "tracking": "-0.04em", "case": "mixed",
    "sample_html": "<div class=\"t-trole-display-cover\">{BRAND_NAME}</div>"
  },
  {
    "id": "display-section",
    "family": "display",
    "purpose": "section-divider headline on ink-blue surface (paper-yellow text)",
    "px_min": 96, "px_max": 168, "weight": 700, "leading": "1.05", "tracking": "-0.04em", "case": "mixed",
    "sample_html": "<div class=\"t-trole-display-section\">Section title.</div>"
  },
  {
    "id": "number-hero",
    "family": "display",
    "purpose": "hero stat numeral — Space Grotesk 700, ink-blue, paired with Caveat unit suffix",
    "px_min": 96, "px_max": 168, "weight": 700, "leading": "0.85", "tracking": "-0.04em", "case": "mixed",
    "sample_html": "<div class=\"t-trole-number-hero\">63<small>%</small></div>"
  },
  {
    "id": "h1",
    "family": "display",
    "purpose": "closing CTA headline / chart-slide headline",
    "px_min": 84, "px_max": 130, "weight": 700, "leading": "1.05", "tracking": "-0.035em", "case": "mixed",
    "sample_html": "<div class=\"t-trole-h1\">One canvas. Everyone home.</div>"
  },
  {
    "id": "h2",
    "family": "display",
    "purpose": "standard slide headline — Space Grotesk 700 mixed case",
    "px_min": 64, "px_max": 96, "weight": 700, "leading": "1.05", "tracking": "-0.03em", "case": "mixed",
    "sample_html": "<div class=\"t-trole-h2\">Designed together.</div>"
  },
  {
    "id": "card-h3",
    "family": "display",
    "purpose": "pinned-card title — Space Grotesk 700, ink-blue on cream",
    "px_min": 28, "px_max": 38, "weight": 700, "leading": "1.02", "tracking": "-0.02em", "case": "mixed",
    "sample_html": "<div class=\"t-trole-card-h3\">Field report</div>"
  },
  {
    "id": "quote-text",
    "family": "display",
    "purpose": "pull-quote body — Space Grotesk 500 mixed case",
    "px_min": 36, "px_max": 50, "weight": 500, "leading": "1.1", "tracking": "-0.02em", "case": "mixed",
    "sample_html": "<div class=\"t-trole-quote-text\">The work gets simpler as the team gets braver.</div>"
  },
  {
    "id": "scribble-lg",
    "family": "script",
    "purpose": "process step numeral / large hand-script accent — Caveat 700, ink-blue",
    "px_min": 60, "px_max": 70, "weight": 700, "leading": "0.9", "tracking": "0", "case": "sentence",
    "sample_html": "<div class=\"t-trole-scribble-lg\">3</div>"
  },
  {
    "id": "scribble-sm",
    "family": "script",
    "purpose": "marginal note / 'me' voice annotation — Caveat 600, slight rotation",
    "px_min": 32, "px_max": 38, "weight": 600, "leading": "1.05", "tracking": "0", "case": "sentence",
    "sample_html": "<div class=\"t-trole-scribble-sm\">finally — <span class=\"pp-underline\">one canvas</span>, everyone home</div>"
  },
  {
    "id": "label-top",
    "family": "mono",
    "purpose": "top-chrome brand lockup / archival tag — DM Mono 500 uppercase",
    "px_min": 24, "px_max": 26, "weight": 500, "leading": "1.2", "tracking": "0.12em", "case": "upper",
    "sample_html": "<div class=\"t-trole-label-top\">Field report · Vol. 01</div>"
  },
  {
    "id": "label-footer",
    "family": "mono",
    "purpose": "footer chrome — DM Mono 500 uppercase, 65% opacity",
    "px_min": 24, "px_max": 25, "weight": 500, "leading": "1.2", "tracking": "0.14em", "case": "upper",
    "sample_html": "<div class=\"t-trole-label-footer\">Source · Internal study, 2026</div>"
  },
  {
    "id": "stamp-mark",
    "family": "mono",
    "purpose": "cinnabar-red rubber stamp — 3px solid red border, red mono uppercase, rotated -4deg",
    "px_min": 24, "px_max": 26, "weight": 500, "leading": "1", "tracking": "0.18em", "case": "upper",
    "sample_html": "<div><span class=\"t-trole-stamp-mark\">Received</span></div>"
  },
  {
    "id": "pill-yes",
    "family": "script",
    "purpose": "affirmative pill — solid ink fill with Caveat paper-yellow text inside a 999px pill",
    "px_min": 24, "px_max": 28, "weight": 600, "leading": "1", "tracking": "0", "case": "sentence",
    "sample_html": "<div><span class=\"t-trole-pill-yes\">Yes</span></div>"
  },
  {
    "id": "pill-no",
    "family": "mono",
    "purpose": "negative pill — red mono uppercase inside a red-bordered transparent 999px pill",
    "px_min": 24, "px_max": 26, "weight": 500, "leading": "1", "tracking": "0.14em", "case": "upper",
    "sample_html": "<div><span class=\"t-trole-pill-no\">No</span></div>"
  }
]
```

## §E Motion (GSAP consts — REPLACES site ease)

```js
const EASE = {
  entry: "power2.out", // soft arrival, no overshoot — paper settling onto the page
  emphasis: "power3.out", // a touch more authority on pin-reveal / stamp-slam beats
  exit: "power2.in", // calm departure, no acceleration spike
  drift: "sine.inOut", // ambient pin / scribble tilt drift
};
const DUR = {
  snap: 0.18,
  med: 0.5,
  slow: 0.95,
};
// RULE: never back.out / elastic / bounce — the field-notebook register is
//       quiet and considered. Overshoot breaks the "paper settling" feel.
// RULE: pin illustrations and stamps may rotate within ±2° on entry — never
//       counter-rotate to 0°. The off-axis tilt is the system's identity.
// RULE: scene transitions are short cross-dissolves (DUR.med). NEVER slide,
//       wipe, or zoom — they read as digital chrome and break the paper aesthetic.
// RULE: scribble entries should write-on (clip-path reveal left→right) at
//       DUR.med with EASE.entry. Don't fade — fade is for printed type.
```

### §E.5 Motion choreography

**Allowed primitives**

- Soft fade-in + 8–12px y-drift on cards (DUR.med, EASE.entry).
- Pin-rotate-in: pin illustration arrives from −20° / +25° tilt and settles to its rest tilt at DUR.med, EASE.entry.
- Stamp-slam: stamp scales 1.08 → 1 with rotation locked at −4° (DUR.snap, EASE.emphasis) — single percussive beat.
- Scribble write-on: clip-path inset(0 100% 0 0) → inset(0 0 0 0) at DUR.med, EASE.entry.
- Stat-counter numeric tween at DUR.slow with EASE.emphasis. Caveat `<small>` suffix fades in at the end of the count.
- Ambient pin drift: rotation oscillation ±1.5° on a 4–6s sine.inOut loop. Subtle, not theatrical.

**Forbidden**

- Slide-in / wipe / zoom-between-scenes (reads as digital chrome).
- Bounce / overshoot / elastic on any primary motion.
- Sub-pixel positions — keep transforms on integer pixel offsets.
- Rotating a pin or scribble back to 0° on rest. The off-axis tilt is the identity.
- Counter-rotating the rubber stamp away from −4°.
- Particle systems / sparkles / glow filters — paper doesn't emit light.

**Stagger budget**

200–280ms between elements. Total scene-in stagger ≤ 700ms. The eye should have time to read each card's pin → heading → body → margin-note rhythm before the next one arrives.

## §G Voice transform recipe (apply to brand's voice from §1 DNA)

Take the brand's product description / value prop. Transform with:

1. Hero headlines: 2–5 words, mixed case (NOT uppercase), Space Grotesk 700 with negative letter-spacing. Period optional — the cover behaves like a book title.
2. Top-chrome lockups, dates, source attributions: DM Mono UPPERCASE with 0.12–0.18em tracking. Terse, indexical — pretend it's a catalog-card tag.
3. Stamps: UPPERCASE DM Mono, 1–2 words ("CONFIDENTIAL", "RECEIVED", "DRAFT 04"). Always rotated −4°.
4. Marginal notes (Caveat scribble): sentence case, 4–10 words, conversational. This is the "me" voice — write as if annotating someone else's document. Use `<span class="pp-underline">word</span>` for hand-drawn underline emphasis.
5. Step numerals: Caveat hand-script (1, 2, 3 — not "Step 1"). The script numeral is the system's ordering voice; never substitute a numeric font.
6. Card bodies: Space Grotesk sentence case, terse, full sentences. Never set body in Caveat — the script is for marginal notes, never paragraphs.

**Example:**

- IN: `Figma helps teams design products collaboratively in real time`
- OUT: hero=`Designed together.` / chip=`FIELD REPORT 04` / stamp=`RECEIVED` / margin-note=`finally — one canvas, everyone home`

## §I Page-level CSS (overrides design.html's neutral chrome — makes the doc itself read as pin-and-paper)

```css
/* ── Preset-native typography vars (loaded via preset-meta.chromeFonts.googleFontsHref).
 * These let the doc chrome render in Space Grotesk + Caveat + DM Mono regardless
 * of which brand DNA the preset is applied to. The §6 component preview and §T
 * type-role atlas also read these via .preset-native-scope.
 *
 * Fallback chains end in a face that still carries the preset's vibe (Inter /
 * Manrope for the printed display + body; system cursives for the script;
 * IBM Plex Mono / Menlo for the archival mono). Caveat in particular is
 * non-substitutable — its absence falls through to `cursive` which varies
 * widely by OS, so the chain stays short and intentional. */
:root {
  --f-disp-native:
    "Space Grotesk", "Inter Tight", "Manrope", -apple-system, BlinkMacSystemFont, system-ui,
    sans-serif;
  --f-body-native:
    "Space Grotesk", "Inter", "IBM Plex Sans", -apple-system, BlinkMacSystemFont, system-ui,
    sans-serif;
  --f-script-native: "Caveat", "Kalam", "Shadows Into Light", "Brush Script MT", cursive;
  --f-mono-native:
    "DM Mono", "JetBrains Mono", "IBM Plex Mono", "Space Mono", "Menlo", ui-monospace, monospace;
}

/* .preset-native-scope: re-bind brand DNA font tokens to preset-native families.
 * Wraps §6 component previews and §T type-role samples so
 * var(--font-*) resolves to Space Grotesk / Caveat / DM Mono regardless of the
 * brand DNA tokens emitted in :root. The paste-ready component source is
 * untouched — Phase 4b still grep + paste original `var(--font-display)`
 * tokens, which resolve to brand DNA at scene-render time. */
.preset-native-scope {
  --font-display: var(--f-disp-native);
  --font-body: var(--f-body-native);
  --font-script: var(--f-script-native);
  --font-mono: var(--f-mono-native);
}

body {
  background: var(--surface-paper);
  position: relative;
  color: var(--brand-primary);
  font-family: "Space Grotesk", "Inter", sans-serif;
}
body::before {
  /* Paper grain on design.html itself */
  content: "";
  position: fixed;
  inset: 0;
  background-image: var(--paper-grain);
  opacity: 0.35;
  mix-blend-mode: multiply;
  pointer-events: none;
  z-index: 9999;
}
.title-card {
  background: var(--surface-paper);
  border-bottom: var(--border-hairline);
  padding: 96px 0 80px;
}
.title-display {
  font-family: "Space Grotesk", sans-serif;
  font-weight: 700;
  letter-spacing: -0.04em;
  color: var(--brand-primary);
}
.brand-name {
  color: var(--brand-primary);
  font-weight: 700;
}
.style-name {
  font-family: "Caveat", cursive;
  font-weight: 700;
  color: var(--brand-primary);
  transform: rotate(-2deg);
  display: inline-block;
}
.ds-section {
  border-top: var(--border-dashed);
  padding: 80px 0;
}
h2 {
  font-family: "Space Grotesk", sans-serif;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--brand-primary);
}
.eyebrow {
  font-family: "DM Mono", monospace;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--brand-primary);
  opacity: 0.7;
  font-weight: 500;
}
.type-card,
.voice-pair,
.comp-card {
  background: var(--surface-cream) !important;
  border: var(--border-hairline) !important;
  border-radius: var(--radius-card) !important;
  box-shadow: var(--shadow-pin-standard) !important;
}
/* dna-swatch keeps its inline brand-color background — only restyle border/shadow */
.dna-swatch {
  border: var(--border-hairline) !important;
  border-radius: var(--radius-card) !important;
  box-shadow: var(--shadow-pin-standard) !important;
}
.comp-head {
  background: var(--surface-paper-2) !important;
  color: var(--brand-primary) !important;
  border-bottom: var(--border-hairline) !important;
  font-family: "DM Mono", monospace !important;
  text-transform: uppercase;
  letter-spacing: 0.14em;
}
.ds-code {
  background: var(--surface-cream) !important;
  border: var(--border-hairline) !important;
  border-radius: var(--radius-card) !important;
  color: var(--brand-primary) !important;
  font-family: "DM Mono", monospace !important;
}

/* ── §T Type-role atlas. Container = a single cream pinned-card with the
 * universal hard ink offset shadow. Each row is a single-column entry padded
 * only — no inner grid, no eyebrow column. Each .t-trole-* class encodes the
 * role's family / size / weight / leading / tracking / case / decoration.
 * Family selectors use var(--font-*) tokens so the atlas renders in BRAND DNA
 * fonts; only the recipe is preset-declared. Decoration (color, border,
 * shadow, rotation, stamp, pill) stays hard-coded to pin-and-paper tokens
 * (var(--brand-primary), var(--brand-accent), var(--surface-paper) etc.). */
.ds-trole-box {
  display: flex;
  flex-direction: column;
  border: var(--border-hairline);
  border-radius: var(--radius-card);
  background: var(--surface-cream);
  box-shadow: var(--shadow-pin-standard);
  overflow: hidden;
  margin-top: 24px;
}
.ds-trole-row {
  padding: 28px 32px;
  border-bottom: var(--border-dashed);
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

/* ── Type-role samples. Each .t-trole-* class mirrors a pin-and-paper type-scale
 * entry but uses var(--font-display/body/script/mono) so the actual typeface
 * comes from brand DNA. Decoration (color, border, shadow, rotation, stamp,
 * pill) is preset-native. */
.t-trole-display-cover {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(64px, 10vw, 196px);
  line-height: 1.08;
  letter-spacing: -0.04em;
  color: var(--brand-primary);
}
.t-trole-display-section {
  display: inline-block;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(64px, 9vw, 168px);
  line-height: 1.05;
  letter-spacing: -0.04em;
  background: var(--brand-primary);
  color: var(--surface-paper);
  padding: 24px 32px;
  max-width: 16ch;
}
.t-trole-number-hero {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(80px, 9vw, 168px);
  line-height: 0.85;
  letter-spacing: -0.04em;
  color: var(--brand-primary);
}
.t-trole-number-hero small {
  font-family: var(--font-script);
  font-weight: 700;
  font-size: 0.36em;
  line-height: 1;
  letter-spacing: 0;
  margin-left: 0.12em;
}
.t-trole-h1 {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(64px, 7vw, 130px);
  line-height: 1.05;
  letter-spacing: -0.035em;
  color: var(--brand-primary);
}
.t-trole-h2 {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(48px, 5vw, 96px);
  line-height: 1.05;
  letter-spacing: -0.03em;
  color: var(--brand-primary);
}
.t-trole-card-h3 {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(24px, 2.4vw, 38px);
  line-height: 1.02;
  letter-spacing: -0.02em;
  color: var(--brand-primary);
}
.t-trole-quote-text {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: clamp(28px, 3.5vw, 50px);
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--brand-primary);
  max-width: 22ch;
}
.t-trole-scribble-lg {
  font-family: var(--font-script);
  font-weight: 700;
  font-size: clamp(48px, 5.5vw, 70px);
  line-height: 0.9;
  color: var(--brand-primary);
}
.t-trole-scribble-sm {
  display: inline-block;
  font-family: var(--font-script);
  font-weight: 600;
  font-size: clamp(32px, 2.8vw, 38px);
  line-height: 1.05;
  color: var(--brand-primary);
  transform: rotate(-2deg);
}
.t-trole-scribble-sm .pp-underline {
  border-bottom: 2px solid var(--brand-primary);
  padding-bottom: 1px;
}
.t-trole-label-top {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: clamp(24px, 1.4vw, 26px);
  line-height: 1.2;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--brand-primary);
}
.t-trole-label-footer {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: clamp(24px, 1.3vw, 25px);
  line-height: 1.2;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--brand-primary);
  opacity: 0.65;
}
.t-trole-stamp-mark {
  display: inline-block;
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: clamp(24px, 1.4vw, 26px);
  line-height: 1;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--brand-accent);
  background: transparent;
  border: 3px solid var(--brand-accent);
  padding: 6px 16px;
  transform: rotate(-4deg);
}
.t-trole-pill-yes {
  display: inline-block;
  font-family: var(--font-script);
  font-weight: 600;
  font-size: clamp(24px, 2vw, 28px);
  line-height: 1;
  color: var(--surface-paper);
  background: var(--brand-primary);
  border: 1.5px solid var(--brand-primary);
  border-radius: 999px;
  padding: 4px 14px;
}
.t-trole-pill-no {
  display: inline-block;
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: clamp(24px, 1.4vw, 26px);
  line-height: 1;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--brand-accent);
  background: transparent;
  border: 1.5px solid var(--brand-accent);
  border-radius: 999px;
  padding: 4px 14px;
}
```
