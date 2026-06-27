```preset-meta
{
  "name": "claude",
  "label": "Claude",
  "fingerprint": {
    "surface": "warm-cream-editorial",
    "shadow": "hairline-elevation-no-blur",
    "border": "hairline-ink",
    "voice": "serif-that-thinks",
    "accent": "scarce-coral-voltage",
    "motion": "quiet-considered"
  },
  "match_signals": [
    { "kind": "hairline_border", "weight": 0.3 },
    { "kind": "serif_display", "weight": 0.25 },
    { "kind": "low_saturation", "weight": 0.15 }
  ],
  "best_for": ["editorial explainers", "research narratives", "considered product stories", "long-form concept pieces", "developer-facing walkthroughs"],
  "avoid_for": ["high-energy hype promos", "neon / maximalist decks", "playful children's content", "dense real-time dashboards"],
  "chromeFonts": {
    "googleFontsHref": "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,500;1,9..144,400&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap",
    "display": "Fraunces",
    "body": "Inter",
    "script": "Fraunces",
    "mono": "JetBrains Mono"
  },
  "palette": {
    "primary": { "value": "#141413", "constraint": "warm near-black ink — the dominant fill and the floor everything stands on: every Fraunces headline, every Inter body word, every hairline border and 1px elevation shadow; never pure #000" },
    "accent": { "value": "#CC785C", "constraint": "terracotta coral — the scarce 'voltage'; reserved for the one primary CTA, the single full-bleed callout band, the inline link, and the ✱ spike mark; never body text, never a card fill" },
    "secondary": { "value": "#ECE3D4", "constraint": "deepest warm-paper tone (the pressed / strong tile) — claude is a warm cream→tile→coral family with no vibrant second hue, so secondary is the darkest paper step, not a fourth color; the navy product-chrome surface is a §B structural anchor (--cl-navy), declared there rather than as a brand slot" },
    "canvas": { "value": "#FAF9F5", "lock": "anchor", "constraint": "warm cream — the brand floor; NEVER pure white, never cool; the warm ground every scene stands on, tinted by brand DNA via color-mix() in §B but never replaced" },
    "surface": { "value": "#EFE9DE", "lock": "anchor", "constraint": "warm tile — one half-step darker than the cream floor; where feature cards live and content gathers; the demarcation is half a step, never a hard contrast" },
    "ink": { "alias": "primary" }
  }
}
```

> `chromeFonts` makes the doc chrome render in the preset's native fonts; brand fonts still apply to §6 components.

## §A Director's intent

An editorial brand book come to life: warm cream paper, a serif that thinks, and a single coral that earns its place. The thesis is three colors held with discipline — **cream is the floor, ink is the voice, coral is the voltage** — and a fourth (navy) only where the product shows itself. The whole system reads as considered, literary, unhurried: it reasons in paragraphs, not slogans.

Every surface is **warm cream** (`var(--canvas)`), never pure white and never cool gray. Content gathers on a **tile** surface half a step darker (`var(--cl-tile)`) — the demarcation is a half-step, never a hard contrast. Elevation is a **1px hairline** ink border at low alpha, optionally a single soft 1px shadow; there are no heavy drop shadows, no glows, no gradients on content. The restraint is the material.

Three editorial voices, each in its own face: **Fraunces** carries every display moment — covers, headlines, pull-quotes, big stat numerals — set at large optical sizes with tight negative tracking; its **italic** is the expressive register (pull-quotes, emphasis). **Inter** carries body, leads, card titles, buttons, and every piece of UI chrome. **JetBrains Mono** carries the indexical layer — kickers, technical labels, the code window, status strips. Switching a voice's face collapses the register: a sans headline or a serif label reads as a different brand.

**Brand DNA drives the chrome color, preset drives the structure.** `--brand-primary` maps to the ink role (every word, every border, every 1px shadow). `--brand-accent` maps to the coral voltage — rationed to at most ONE moment per scene (the CTA, OR the inline link, OR the full-bleed band). `--brand-secondary` maps to the warm-paper secondary slot: the pressed / strong tile tone shown in Brand DNA. The navy product-chrome surface (`--cl-navy`) where code and dark cards live is a structural anchor, not a brand slot. The cream + tile grounds are **technical-signature anchors** — without the warm paper the system reads as just another cool SaaS deck — declared in §B so brand DNA tints via `color-mix()` without losing the warm-paper reading.

Motion is **quiet and considered** — short fades, no overshoot, no bounce. The brand reads first and answers second; the camera holds and the eye reads. Scene transitions are cross-dissolves; coral underlines may draw on; numbers count up; the code window types on line by line.

**Density philosophy: editorial, not packed.** Claude reads as authoritative with ONE clear focal per scene and generous cream around it — a hero line and a single artifact, a stat and its caption, a quote and its attribution. A scene crammed edge-to-edge breaks the considered voice; a scene with a single centered line and acres of cream is exactly right.

**Class prefix:** `cl-` across all components.

## §B Decoration tokens (merge into design.html `:root`)

Claude declares **structural** tokens here (warm tile surface, navy product-chrome family, ink scale, hairlines, hairline elevation, radii, spacing). The brand-aware contract: ink surfaces flow from `var(--brand-primary)`; the coral voltage flows from `var(--brand-accent)`; the warm-paper secondary role flows through the tile family. The navy chrome is declared as a fixed product-surface anchor. The cream + tile grounds are §8.2 anchor exceptions — declared because the warm-paper register is the preset's structural signature, not a palette choice; brand DNA tints them via `color-mix()`.

```css
/* §8.2 exception: warm-paper anchors. Cream is "never the cool gray every other
   model wears", tile is the half-step content surface — without them the system
   collapses into a generic cool SaaS deck. Brand DNA tints via color-mix() so the
   warm-paper register survives every brand palette. Declared once, never scattered. */
--cl-cream: var(--canvas); /* the 60% floor */
--cl-tile: color-mix(
  in srgb,
  var(--brand-primary) 5%,
  #f3eee4
); /* the 30% card surface, one warm step down */
--cl-tile-strong: color-mix(in srgb, var(--brand-primary) 9%, #ece3d4); /* pressed / active tile */

/* Navy product-chrome family — the dark surface where the product shows itself.
   Structural anchor, not a Brand DNA slot: secondary is the warm paper tone. */
--cl-navy: #181715; /* code window / terminal / dark card ground */
--cl-navy-soft: #1f1e1b; /* code-window body */
--cl-navy-elev: #252320; /* title bars, status strips, elevated dark */

/* Ink scale — warm dark lightened toward the cream floor for body / muted / soft.
   Derived from --ink so it shifts with brand DNA but stays warm. */
--cl-ink-strong: color-mix(in srgb, var(--ink) 92%, var(--canvas));
--cl-ink-body: color-mix(in srgb, var(--ink) 80%, var(--canvas));
--cl-ink-muted: color-mix(in srgb, var(--ink) 58%, var(--canvas));
--cl-ink-soft: color-mix(in srgb, var(--ink) 44%, var(--canvas));

/* Cream inks — text that sits on the navy product chrome */
--cl-on-dark: var(--canvas);
--cl-on-dark-soft: color-mix(in srgb, var(--canvas) 62%, var(--cl-navy));

/* Functional accents — syntax tokens + status + button states. Decoration, NOT
   brand hues (the brand stays the cream/coral/ink trinity). Coral states derive
   from --brand-accent so they track a remixed coral. */
--cl-coral-active: color-mix(in srgb, var(--brand-accent) 78%, var(--ink)); /* pressed coral */
--cl-coral-disabled: color-mix(in srgb, var(--brand-accent) 18%, var(--cl-tile)); /* disabled */
--cl-teal: #5db8a6; /* code strings · "ready" status */
--cl-amber: #e8a55a; /* code numbers · "beta" badge */
--cl-success: #5db872; /* connected status · checkmarks */
--cl-warn: #c64545; /* refused / error status */

/* Hairlines — the only elevation language. Ink at low alpha on cream; cream at
   low alpha on navy. */
--cl-hairline: color-mix(in srgb, var(--ink) 12%, transparent);
--cl-hairline-soft: color-mix(in srgb, var(--ink) 6%, transparent);
--cl-hairline-dark: color-mix(in srgb, var(--cl-on-dark) 14%, transparent);
--cl-border-hairline: 1px solid var(--cl-hairline);

/* Hairline elevation — one soft warm shadow, used rarely. NEVER a heavy drop. */
--cl-shadow-card:
  0 1px 3px color-mix(in srgb, var(--ink) 8%, transparent),
  0 4px 16px color-mix(in srgb, var(--ink) 4%, transparent);

/* Coral focus ring — for inputs / focused fields */
--cl-focus-ring: 0 0 0 3px color-mix(in srgb, var(--brand-accent) 22%, transparent);

/* Optional atmospheric gradient — coral deepening into ink. Used sparingly. */
--brand-gradient: linear-gradient(
  135deg,
  var(--brand-accent),
  color-mix(in srgb, var(--brand-accent) 55%, var(--ink))
);

/* Radii — hierarchical, restrained (editorial, never pill-y except true pills) */
--cl-radius-xs: 4px;
--cl-radius-sm: 6px;
--cl-radius-md: 8px;
--cl-radius-lg: 12px;
--cl-radius-xl: 16px;
--cl-radius-pill: 9999px;

/* Spacing — 4px base */
--cl-s-xs: 8px;
--cl-s-sm: 12px;
--cl-s-md: 16px;
--cl-s-lg: 24px;
--cl-s-xl: 32px;
--cl-s-xxl: 48px;

/* The ✱ spike — the brand mark glyph, always coral */
--cl-spike: "\2731";
```

## §D Font pairing fallback (if brand fonts not on Google Fonts)

Claude depends on the three-voice editorial pairing (optical serif display / humanist sans body / mono index). Fallbacks below are only used if the brand-derived face fails to load.

- **display**: `'Fraunces'` · `'Tiempos Headline'` · `'Cormorant'` · Garamond · serif — opsz axis preferred
- **body**: `'Inter'` · `'Inter Tight'` · system-ui · `-apple-system` · sans-serif, wght 300–600
- **mono**: `'JetBrains Mono'` · `'IBM Plex Mono'` · `'SFMono-Regular'` · Menlo · ui-monospace

The serif is load-bearing: the entire thesis is "a serif reads like a person thought about it." If Fraunces fails, fall through to another high-contrast optical serif — never to a sans. Component CSS forces these families directly; brand DNA does not override them.

## §T Type-role atlas (Phase 4b reads this to size text correctly)

The atlas is the **sole authoring source** for non-component text. If a scene needs a `number-hero` numeral not covered by a §6 component, the worker reads role `number-hero` here and writes inline CSS from these values. Do NOT invent ad-hoc sizes — the editorial rhythm (Fraunces display / Inter body / mono index) collapses if sizes drift.

```type-roles
[
  {
    "id": "display-cover",
    "family": "display",
    "purpose": "cover hero — Fraunces 400, the brand line, ink on cream",
    "px_min": 96, "px_max": 200, "weight": 400, "leading": "0.98", "tracking": "-0.035em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-display-cover\">Meet your thinking partner.</div>"
  },
  {
    "id": "display-section",
    "family": "display",
    "purpose": "section-divider headline, Fraunces 400 on cream or navy",
    "px_min": 72, "px_max": 150, "weight": 400, "leading": "1.02", "tracking": "-0.028em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-display-section\">A serif that thinks.</div>"
  },
  {
    "id": "display-italic",
    "family": "script",
    "purpose": "expressive register — Fraunces 400 italic, the editorial voice",
    "px_min": 64, "px_max": 132, "weight": 400, "leading": "1.05", "tracking": "-0.018em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-display-italic\">An editorial AI.</div>"
  },
  {
    "id": "h2",
    "family": "display",
    "purpose": "standard slide headline — Fraunces 400 sentence case",
    "px_min": 48, "px_max": 92, "weight": 400, "leading": "1.06", "tracking": "-0.02em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-h2\">Considered work, at the speed of typing.</div>"
  },
  {
    "id": "quote-pull",
    "family": "script",
    "purpose": "pull-quote — Fraunces 400 italic with a sans cite below",
    "px_min": 48, "px_max": 100, "weight": 400, "leading": "1.12", "tracking": "-0.018em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-quote-pull\">Read the whole thing before you say anything.<cite>House style</cite></div>"
  },
  {
    "id": "number-hero",
    "family": "display",
    "purpose": "hero stat numeral — Fraunces 400 figure paired with a mono unit",
    "px_min": 96, "px_max": 180, "weight": 400, "leading": "0.95", "tracking": "-0.03em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-number-hero\">200K<span>tokens of context</span></div>"
  },
  {
    "id": "card-title",
    "family": "body",
    "purpose": "feature / card title — Inter 500, ink on cream or tile",
    "px_min": 28, "px_max": 48, "weight": 500, "leading": "1.25", "tracking": "-0.005em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-card-title\">Connect the tools you already work in.</div>"
  },
  {
    "id": "lead",
    "family": "body",
    "purpose": "lede paragraph — Inter 400 large, set generously",
    "px_min": 28, "px_max": 40, "weight": 400, "leading": "1.5", "tracking": "0", "case": "sentence",
    "sample_html": "<div class=\"t-trole-lead\">A model that reads first and answers second — trained to be helpful, harmless, and honest, in that order.</div>"
  },
  {
    "id": "kicker",
    "family": "mono",
    "purpose": "eyebrow — JetBrains Mono 500 uppercase, ✱ spike prefix, coral mark",
    "px_min": 24, "px_max": 28, "weight": 500, "leading": "1.2", "tracking": "0.16em", "case": "upper",
    "sample_html": "<div class=\"t-trole-kicker\"><span>✱</span> For the considered worker</div>"
  },
  {
    "id": "mono-label",
    "family": "mono",
    "purpose": "technical label / index strip — JetBrains Mono 500",
    "px_min": 24, "px_max": 27, "weight": 500, "leading": "1.45", "tracking": "0.02em", "case": "sentence",
    "sample_html": "<div class=\"t-trole-mono-label\">claude-opus · 200k ctx · vision · tools</div>"
  },
  {
    "id": "tag-upper",
    "family": "body",
    "purpose": "uppercase tracked tag — Inter 500",
    "px_min": 24, "px_max": 27, "weight": 500, "leading": "1.4", "tracking": "0.18em", "case": "upper",
    "sample_html": "<div class=\"t-trole-tag-upper\">Research · Models · Pricing</div>"
  },
  {
    "id": "button",
    "family": "body",
    "purpose": "primary action — Inter 500 cream-on-coral",
    "px_min": 24, "px_max": 28, "weight": 500, "leading": "1", "tracking": "0", "case": "sentence",
    "sample_html": "<div><span class=\"t-trole-button\">Start writing with Claude</span></div>"
  },
  {
    "id": "code",
    "family": "mono",
    "purpose": "code line — JetBrains Mono 400 with coral/teal/amber token spans, on navy",
    "px_min": 24, "px_max": 32, "weight": 400, "leading": "1.6", "tracking": "0", "case": "sentence",
    "sample_html": "<div><span class=\"t-trole-code\"><span class=\"k\">def</span> answer(q): <span class=\"k\">return</span> claude.reason(q, n=<span class=\"n\">3</span>)</span></div>"
  }
]
```

## §E Motion (GSAP consts — REPLACES site ease)

```js
const EASE = {
  entry: "power2.out", // soft arrival, no overshoot — a paragraph settling onto the page
  emphasis: "power3.out", // a touch more authority on a coral-reveal / number-count beat
  exit: "power2.in", // calm departure, no acceleration spike
  drift: "sine.inOut", // the rare ambient drift (a glyph, a underline shimmer)
};
const DUR = {
  snap: 0.18,
  med: 0.5,
  slow: 0.9,
};
// RULE: never back.out / elastic / bounce — the editorial register is quiet and
//       considered. Overshoot breaks the "reads first" voice.
// RULE: scene transitions are cross-dissolves (DUR.med). NEVER slide, wipe, or
//       zoom between scenes — they read as digital chrome and break the page feel.
// RULE: coral is the only thing that may "draw on" — an inline-link underline or a
//       CTA edge reveals left→right (clip-path) at DUR.med. Everything else fades.
// RULE: numbers count up (Fraunces figure tween at DUR.slow, EASE.emphasis); the
//       mono unit fades in at the end of the count.
// RULE: the code window types on line by line at DUR.snap per line; the terminal
//       output appends one line at a time. Never animate individual glyphs elsewhere.
```

### §E.5 Motion choreography

**Allowed primitives**

- Soft fade-in + 8–14px y-drift on cards and text blocks (DUR.med, EASE.entry).
- Coral draw-on: an inline-link underline or CTA edge reveals via clip-path inset(0 100% 0 0) → inset(0 0 0 0) at DUR.med, EASE.entry.
- Number count-up: Fraunces figure tweens at DUR.slow with EASE.emphasis; the mono unit fades in at the end.
- Code type-on: line-by-line clip reveal, DUR.snap per line; terminal output lines append in sequence with EASE.entry.
- Hairline draw-on: a 1px rule extends left→right at DUR.med to introduce a section.
- The ✱ spike fades + scales 0.92 → 1 on a single emphasis beat (DUR.snap). Never spins.

**Forbidden**

- Slide-in / wipe / zoom between scenes (reads as digital chrome).
- Bounce / overshoot / elastic on any primary motion.
- Glyph-by-glyph reveals on Fraunces display — the serif is meant to be read as one set line, not assembled.
- Heavy drop-shadow grows, glow pulses, or gradient sweeps — the system has no light to emit.
- More than one coral motion per scene — the voltage is rationed in time as well as in space.

**Stagger budget**

180–260ms between elements. Total scene-in stagger ≤ 700ms. The eye should have time to read the kicker → headline → lede rhythm before the next block arrives.

## §G Voice transform recipe (apply to the script's text)

Take the scene's idea. Transform with:

1. Display headlines: Fraunces, sentence case (NOT title case, NOT uppercase), 3–8 words. The period is optional — the line behaves like a book chapter title. Reach for the **italic** when the line is a stance or a definition ("An editorial AI.").
2. Kickers / eyebrows: JetBrains Mono UPPERCASE, 0.16em tracking, prefixed with the coral ✱ spike. Terse and indexical — a catalog tag, 2–5 words.
3. Coral is rationed: at most ONE coral moment per scene — the primary CTA, OR a single inline link inside a sentence, OR the full-bleed callout. Never two. Coral never sets a headline or a body run.
4. Numbers: a Fraunces figure with a JetBrains Mono unit suffix ("200K tokens", "$20 / month"). The figure is display; the unit is mono — never set the unit in the serif.
5. Body & leads: Inter, sentence case, full sentences with their qualifiers kept. The voice "reads first" — no hype, no exclamation, no telegraphed fragments. A lead may run a sentence longer than a slogan would.
6. Pull-quotes: Fraunces italic, with a small Inter uppercase cite below. The quote is the only place a long line is allowed to breathe across the scene.
7. Code & labels: JetBrains Mono. Keywords in coral, strings in teal, numbers in amber — the same palette outside the code window, so the chrome is not a foreign language.

**Example:**

- IN: `Our AI assistant connects to your tools and helps your team work faster.`
- OUT: kicker=`✱ FOR THE CONSIDERED TEAM` / headline=`The work, in the tools you already use.` / lead=`A model that reads the thread, the doc, and the repo before it answers — so the answer sounds like someone who read them.` / cta=`Start a project`

## §I Page-level CSS (overrides design.html's neutral chrome — makes the doc itself read as Claude)

```css
/* ── Preset-native typography vars (loaded via preset-meta.chromeFonts.googleFontsHref).
 * These let the doc chrome render in Fraunces + Inter + JetBrains Mono regardless of
 * which brand DNA the preset is applied to. The §6 component preview and §T type-role
 * atlas also read these via .preset-native-scope.
 *
 * Fallback chains end in a face that still carries the preset's vibe — a high-contrast
 * optical serif for display (never a sans), a humanist sans for body, a plex/menlo mono
 * for the index layer. */
:root {
  --f-disp-native: "Fraunces", "Tiempos Headline", "Cormorant", Garamond, "Times New Roman", serif;
  --f-body-native: "Inter", "Inter Tight", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --f-script-native: "Fraunces", "Tiempos Headline", "Cormorant", Garamond, serif;
  --f-mono-native:
    "JetBrains Mono", "IBM Plex Mono", "SFMono-Regular", Menlo, ui-monospace, monospace;
}

/* .preset-native-scope: re-bind brand DNA font tokens to preset-native families.
 * Wraps §6 component previews and §T type-role samples so var(--font-*) resolves to
 * Fraunces / Inter / JetBrains Mono regardless of the brand DNA tokens emitted in
 * :root. The paste-ready component source is untouched — it forces these families
 * directly. */
.preset-native-scope {
  --font-display: var(--f-disp-native);
  --font-body: var(--f-body-native);
  --font-script: var(--f-script-native);
  --font-mono: var(--f-mono-native);
}

body {
  background: var(--canvas);
  position: relative;
  color: var(--brand-primary);
  font-family:
    "Inter",
    -apple-system,
    BlinkMacSystemFont,
    system-ui,
    sans-serif;
}
.title-card {
  background: var(--canvas);
  border-bottom: var(--cl-border-hairline);
  padding: 96px 0 80px;
}
.title-display {
  font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
  font-weight: 400;
  letter-spacing: -0.035em;
  color: var(--brand-primary);
}
.brand-name {
  color: var(--brand-primary);
  font-weight: 500;
}
.style-name {
  font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
  font-weight: 400;
  font-style: italic;
  color: var(--brand-accent);
  display: inline-block;
}
.ds-section {
  border-top: var(--cl-border-hairline);
  padding: 80px 0;
}
h2 {
  font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
  font-weight: 400;
  letter-spacing: -0.025em;
  color: var(--brand-primary);
}
.eyebrow {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--cl-ink-muted);
  font-weight: 500;
}
.type-card,
.voice-pair,
.comp-card {
  background: var(--cl-tile) !important;
  border: var(--cl-border-hairline) !important;
  border-radius: var(--cl-radius-lg) !important;
  box-shadow: none !important;
}
/* dna-swatch keeps its inline brand-color background — only restyle border/radius */
.dna-swatch {
  border: var(--cl-border-hairline) !important;
  border-radius: var(--cl-radius-lg) !important;
  box-shadow: none !important;
}
.comp-head {
  background: var(--cl-tile-strong) !important;
  color: var(--cl-ink-muted) !important;
  border-bottom: var(--cl-border-hairline) !important;
  font-family: "JetBrains Mono", ui-monospace, monospace !important;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.ds-code {
  background: var(--cl-navy) !important;
  border: 1px solid var(--cl-hairline-dark) !important;
  border-radius: var(--cl-radius-md) !important;
  color: var(--cl-on-dark) !important;
  font-family: "JetBrains Mono", ui-monospace, monospace !important;
}

/* ── §T Type-role atlas. Container = a single tile card with the hairline border.
 * Each row is a single-column entry, padded only — no inner grid, no eyebrow column.
 * Each .t-trole-* class encodes the role's family / size / weight / leading / tracking
 * / case / decoration. Family selectors use var(--font-*) tokens so the atlas renders
 * in the preset-native fonts via .preset-native-scope; decoration (color) stays on
 * claude tokens. */
.ds-trole-box {
  display: flex;
  flex-direction: column;
  border: var(--cl-border-hairline);
  border-radius: var(--cl-radius-lg);
  background: var(--cl-tile);
  box-shadow: none;
  overflow: hidden;
  margin-top: 24px;
}
.ds-trole-row {
  padding: 28px 32px;
  border-bottom: var(--cl-border-hairline);
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

/* ── Type-role samples. Each .t-trole-* mirrors a §T entry but uses
 * var(--font-display/body/script/mono); decoration (color) is claude-native via
 * tokens — zero raw hex. */
.t-trole-display-cover {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(64px, 10vw, 200px);
  line-height: 0.98;
  letter-spacing: -0.035em;
  color: var(--brand-primary);
}
.t-trole-display-section {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(56px, 8vw, 150px);
  line-height: 1.02;
  letter-spacing: -0.028em;
  color: var(--brand-primary);
}
.t-trole-display-italic {
  font-family: var(--font-script);
  font-weight: 400;
  font-style: italic;
  font-size: clamp(48px, 7vw, 132px);
  line-height: 1.05;
  letter-spacing: -0.018em;
  color: var(--cl-ink-strong);
}
.t-trole-h2 {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(40px, 5vw, 92px);
  line-height: 1.06;
  letter-spacing: -0.02em;
  color: var(--brand-primary);
}
.t-trole-quote-pull {
  font-family: var(--font-script);
  font-weight: 400;
  font-style: italic;
  font-size: clamp(40px, 5vw, 100px);
  line-height: 1.12;
  letter-spacing: -0.018em;
  color: var(--cl-ink-strong);
  max-width: 22ch;
}
.t-trole-quote-pull cite {
  display: block;
  margin-top: 18px;
  font-style: normal;
  font-family: var(--font-body);
  font-weight: 500;
  font-size: 24px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--cl-ink-muted);
}
.t-trole-number-hero {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(80px, 9vw, 180px);
  line-height: 0.95;
  letter-spacing: -0.03em;
  color: var(--brand-primary);
}
.t-trole-number-hero span {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: 0.18em;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--cl-ink-muted);
  margin-left: 0.12em;
}
.t-trole-card-title {
  font-family: var(--font-body);
  font-weight: 500;
  font-size: clamp(28px, 2.6vw, 48px);
  line-height: 1.25;
  letter-spacing: -0.005em;
  color: var(--brand-primary);
}
.t-trole-lead {
  font-family: var(--font-body);
  font-weight: 400;
  font-size: clamp(28px, 2.4vw, 40px);
  line-height: 1.5;
  color: var(--cl-ink-body);
  max-width: 32ch;
}
.t-trole-kicker {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: clamp(24px, 1.5vw, 28px);
  line-height: 1.2;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--cl-ink-muted);
}
.t-trole-kicker span {
  color: var(--brand-accent);
  margin-right: 0.4em;
}
.t-trole-mono-label {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: clamp(24px, 1.4vw, 27px);
  line-height: 1.45;
  letter-spacing: 0.02em;
  color: var(--cl-ink-strong);
}
.t-trole-tag-upper {
  font-family: var(--font-body);
  font-weight: 500;
  font-size: clamp(24px, 1.4vw, 27px);
  line-height: 1.4;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--cl-ink-strong);
}
.t-trole-button {
  display: inline-block;
  font-family: var(--font-body);
  font-weight: 500;
  font-size: clamp(24px, 1.6vw, 28px);
  line-height: 1;
  color: var(--cl-on-dark);
  background: var(--brand-accent);
  padding: 18px 32px;
  border-radius: var(--cl-radius-md);
}
.t-trole-code {
  font-family: var(--font-mono);
  font-weight: 400;
  font-size: clamp(24px, 2vw, 32px);
  line-height: 1.6;
  color: var(--cl-on-dark);
  background: var(--cl-navy);
  padding: 14px 20px;
  border-radius: var(--cl-radius-sm);
  display: inline-block;
}
.t-trole-code .k {
  color: var(--brand-accent);
}
.t-trole-code .n {
  color: var(--cl-amber);
}
```
