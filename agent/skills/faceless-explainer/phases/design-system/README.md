# Style Preset Standard - Using Block Frame as the Reference

`block-frame/` is the **reference implementation (reference preset)**. This README defines what a style preset must contain, what each part outputs, and how to **add / refactor / convert another style** into the standard format.

> The fastest way to start a new preset: `cp -r block-frame <new-name>`, then rewrite section by section according to §2, follow the rules in §4, and verify with §6.

---

## 1. Directory Shape

```
<preset-name>/                 # directory name = preset internal name (lowercase kebab-case)
├── preset.md                  # preset-meta + §A/§B/§D/§T/§E/§G/§H/§I
├── components/                # >=1 <id>.md file, each one paste-ready block
│   ├── hero.md
│   ├── feature-card.md
│   └── ...
└── caption-skin.html          # required - preset-provided caption skin (see §3.5)
```

The build script (`phases/design-system/scripts/build-design.mjs`) reads by directory; there are **no extra convention files** such as `studio`. Every preset has the same directory shape (`preset.md` + `components/` + `caption-skin.html`); only `block-frame/` additionally carries this `README.md` (= the standard itself, both reference implementation and documentation).

### 1.1 Existing Presets (reference set for comparison)

Before creating a new one, scan them first: **(a) avoid duplicate names / duplicate positioning; (b) choose the preset whose visual language is closest to your target as the `cp -r` starting template** (§5), which is usually faster than starting from block-frame. `name` = directory name = `preset-meta.name`; fingerprints come from each preset's `preset-meta.fingerprint` (used for preset selection / inference matching; see §2.0).

| `name` (directory name) | label             | One-sentence style fingerprint                                                                                       |
| ----------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `block-frame`           | Block Frame       | hard black shadow · 4px solid ink border · saturated pastel cycle (**reference implementation**)                     |
| `neo-brutalism`         | Neo-Brutalism     | hard shadow · thick solid border · hit-and-hold motion · high-density high contrast                                  |
| `creative-mode`         | Creative Mode     | warm cream paper · thick ink square border · color-to-ink hard shadow · editorial magazine voice                     |
| `retro-zine`            | Retro Zine        | paper-on-paper offset panels · 3px ink border · soft paper shuffle · warm paper over forest green                    |
| `peoples-platform`      | People's Platform | triple overprint shadow · cream inset frame · stamp impact · manifesto voice                                         |
| `pin-and-paper`         | Pin & Paper       | yellow paper texture · hard ink shadow with zero blur · fine ink border · handwritten field-note voice               |
| `daisy-days`            | Daisy Days        | hard charcoal shadow · chunky charcoal radius · rounded display type · picture-book pastels · pop in and settle      |
| `playful`               | Playful           | double-stroked offset frame · asymmetric organic blob · back-overshoot hand placement · doodle                       |
| `scatterbrain`          | Scatterbrain      | softly blurred lifted paper · borderless sticky notes · hand-placed micro-tilt · warm pastel paper stack             |
| `8-bit-orbit`           | 8-Bit Orbit       | pixel-stacked offsets · pixel-snap flicker · dark neon · closed palette                                              |
| `sakura-chroma`         | Sakura Chroma     | hard zero-blur shadow · 1.5px ink border · refined paper snap · cassette-package editorial voice                     |
| `stencil-tablet`        | Stencil & Tablet  | fully flat no shadow · rounded stone tablets · refined stamps · earthy saturation · stencil display face             |
| `editorial`             | Editorial / Swiss | no shadow or hairline · hairline border · restrained slide-in · low-density Swiss style                              |
| `editorial-forest`      | Editorial Forest  | literary quarterly · serif 500 with opsz · mono uppercase wide tracking · flat paper no shadow                       |
| `emerald-editorial`     | Emerald Editorial | strict rectangles · no shadow · 4px solid ink line · double-line playbill · extreme Bodoni scale                     |
| `soft-editorial`        | Soft Editorial    | soft radius · no shadow · 1px warm ink dashed line · translucent white + pastel cards · small-format quarterly voice |
| `capsule`               | Capsule           | universal capsule shapes · soft low-opacity offset · Didone serif + Grotesk · floating capsule wallpaper             |
| `liquid-glass`          | Liquid Glass      | inner highlight · translucent hairline edge · rise-and-settle motion · high-contrast aurora base                     |

---

## 2. `preset.md` - Top to Bottom

### 2.0 `preset-meta` (fenced JSON, **required** - missing or invalid JSON fails build immediately)

The **first block** in the file must be ` ```preset-meta { ... } ``` `. Block Frame's:

```json
{
  "name": "block-frame",              // internal name, = directory name
  "label": "Block Frame",             // display name
  "fingerprint": {                    // one-sentence style fingerprint (human-readable + preset selection reference)
    "shadow": "hard-offset-black", "border": "4px-solid-ink",
    "palette": "saturated-pastel-cycle", "motion": "tilt-and-snap",
    "decoration": "tilted-puncture"
  },
  "match_signals": [                  // for automatic inference: site capture matching these signals increases this preset's score
    { "kind": "shadow_zero_blur", "weight": 0.3 },
    { "kind": "thick_solid_border", "weight": 0.3 }
  ],
  "best_for": ["indie SaaS launches", "agency credentials", ...],   // suitable use cases
  "avoid_for": ["regulated disclosures", "formal legal briefs", ...], // unsuitable use cases
  "chromeFonts": {                    // "native fonts" for the design.html preview page (not brand DNA)
    "googleFontsHref": "https://fonts.googleapis.com/css2?family=Inter:wght@...&family=Space+Grotesk:wght@...&display=swap",
    "display": "Inter", "body": "Inter", "script": "Inter", "mono": "Space Grotesk"
  }
}
```

- `match_signals` determines automatic matching when `build-design` runs without `--style`; ignored when manually passing `--style <name>`.
- `chromeFonts` makes the design.html document chrome + §T atlas + §6 preview render in the preset's native typography (via `.preset-native-scope`; see §I); **brand fonts still apply to paste-ready §6 component code**.

### 2.1 Each `## §X` Section

Parsed as `## §<letter> <title>`. Block Frame has 8 sections, in this order:

| Section                        | Required?                       | Content                                                                                 | Downstream artifact                                                           |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **§A** Director's intent       | recommended                     | prose: director intent and tone for this style                                          | design.html §1 prose                                                          |
| **§B** Decoration tokens       | **required**                    | `:root { ... }` design tokens                                                           | -> `ROOT` marker -> `chunks/tokens.css`                                       |
| **§D** Font pairing fallback   | recommended                     | one bullet per role: `- **display**: \`'Name1'\` · \`'Name2'\``                         | fallback chain when site fonts cannot resolve (otherwise final hard fallback) |
| **§T** Type-role atlas         | optional (standard includes it) | ` ```type-roles ` JSON, named text roles                                                | -> `chunks/type-roles.md` (worker looks up by id)                             |
| **§E** Motion                  | **required**                    | `const EASE = {...}; const DUR = {...}` GSAP constants                                  | -> `MOTION` marker -> `chunks/easings.js`                                     |
| **§G** Voice transform recipe  | **required**                    | rewrite register for visible DOM text (strip/case/line breaks)                          | -> `VOICE` marker -> `chunks/voice.md`                                        |
| **§H** Scene composition hints | recommended                     | background/material preferences / 60-30-10 color use (style reference, not contract)    | -> `HINTS` -> `chunks/composition-hints.md`                                   |
| **§I** Page-level CSS          | optional (standard includes it) | design.html shell CSS + `.preset-native-scope` + `.t-trole-*` role CSS + decorative CSS | injected into design.html `<style>`                                           |

**Two hard constraints (the parser exits with an error):**

- **Do not write `## §F`** - §F (components) is automatically synthesized from the `components/` directory; writing it causes `✗ declares §F inline`.
- **Do not keep `## §M` (Atomic motifs)** - motif support has been removed from this standard; use §6 components to express signature gestures. New presets should not have §M; when refactoring old presets, delete it (along with `.ds-motif*` CSS in §I).

**`§B` token naming convention** (Block Frame example): brand colors `--brand-primary/secondary/tertiary/accent/costume`, `--ink`, `--canvas`, `--brand-gradient`, decorative colors `--deco-1..4`, fonts `--font-display/body/mono`, and preset-private tokens with a prefix (Block Frame uses `--bf-*`: `--bf-border-bold`, `--bf-shadow`, `--bf-tilt-*`, `--bf-pad-*`, ...).

**`§T` role schema** (each entry): `id` · `family` (display/body/mono/script, resolved at render time to `var(--font-*)`) · `purpose` · `px_min`/`px_max` · `weight` · `leading` · `tracking` · `case` · `sample_html` (uses `.t-trole-<id>` class). Decorative CSS for each role lives in §I as `.t-trole-<id> { ... }`. Block Frame currently has 11 roles: `heading-xl / heading-lg / heading-md / close-title / quote-text / stat-number / card-title / step-num / label-pill / mono-tag / counter`.

> **`sample_html` copy convention:** sample text should be the kind of **short real copy a video would use** (headline / number / eyebrow, etc.). **Do not write self-describing placeholder prose** (for example, `<p>Body sits at 24-28px, weight 400 — never uppercase...</p>` describing the role itself). That kind of self-description reads like debug notes in the design.html §T atlas, not a sample. Either provide a proper sample line, or, if the role is just generic body text without a signature worth demonstrating, do not create that role at all (let §6 components carry body copy; see how capsule leaves almost no generic body role).

---

## 3. `components/` - Paste-Ready Components

- **One `.md` = one component**; filename without `.md` = id, must match `[a-z0-9-]+`.
- At least **1 component** is required (zero components fails build). Alphabetical filename order -> deterministic output.
- File body = **bare HTML + optional `<style>`**, using `{SLOT}` placeholders (e.g. `{HEADLINE}`/`{LEDE}`/`{NUM}`). **Do not** add `<!-- COMPONENT -->` markers yourself (the parser adds them).
- File body contains only bare HTML + `<style>`; **do not write YAML frontmatter**. (Historically, frontmatter fields such as `surface`/`role`/`composes`/`avoids_same_scene`/`slots` were supported for plan-agent surface filtering + mutual-exclusion validation. **That machine has been removed**: the design system is now a pure style reference, components are selected by the Phase 4b worker via visual judgment, no longer filtered by the plan by surface/role, and there are no surface anchors / Components anchors. emit-chunks can still parse old frontmatter, but downstream no longer consumes it; do not write it in new components.)
- CSS references brand tokens with `var(--*)`; classes use a preset prefix (Block Frame uses `.bf-*`). Block Frame currently has 10 components: `hero / feature-card / stat-counter / timeline-step / quote-frame / button / chip / dot-grid-bg / corner-pins / star-burst`.

---

## 3.5 `caption-skin.html` - Caption Skin (**required**, preset-provided)

Every preset **must** include a `caption-skin.html` at its root (next to `preset.md`) = this style's **own lower-third karaoke caption look**. Captions are first-class video content, not an optional attachment. Without it, captions fall back to the generic registry pill and the visual language breaks away from the style. Block Frame includes one as reference.

**Priority / data flow:** if the selected preset has `caption-skin.html`, it is the caption system's **first source** - `emit-chunks` copies it to `chunks/caption-skin.html`, Phase 4a.5 `captions.mjs html` **prefers it** (falling back to registry `caption-pill-karaoke` / `caption-highlight` scoring only when absent); `build-design` also embeds it into design.html as **§C live preview** (looping). **The whole chain makes zero agent judgments** - scripts select, fill words, and self-check automatically.

It is a **"prebaked" skin**: the author writes a complete, brand-tokenized caption sub-composition, and the script only performs **generic fill-in** (the three holes below, each asserted to appear exactly once), with no per-preset code. Therefore **the contract must be followed exactly**:

| Author must provide                                                                                                               | Builder-filled holes (do not rename / duplicate)                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| root `data-composition-id="captions"` + registered `window.__timelines["captions"]`                                               | `var GROUPS = [];` <- engine groups                                                                             |
| canonical hooks `.caption-group` / `.caption-word` (+ states `.is-active` / `.is-spoken`)                                         | `var DURATION = 0;` and root `data-duration="0"` <- real total duration                                         |
| all colors via `var(--*)` / `color-mix` - **zero raw hex** (passes self-lint)                                                     | empty `<style data-brand-tokens></style>` <- inline `tokens.css` (including @font-face)                         |
| no `<video>` / no Google Fonts `<link>` / no placeholder copy / no `window.{getComputedStyle,requestAnimationFrame,matchMedia}()` | optional `var FONT_FAMILY = "";` <- brand display family (only when the skin uses canvas `measureText` for fit) |

**Seek-safe iron rule:** state switches must use `gsap.set(el, { className: "caption-word is-active" })` (`set` takes effect during frame-by-frame engine seek); **never** use `tl.call()` callbacks (seek does not trigger them -> caption state is wrong during render). GSAP via CDN `<script>` is fine.

**How to write one:**

1. `cp block-frame/caption-skin.html <your-preset>/caption-skin.html` - it is already a compliant template (three holes + hooks + seek-safe timeline + generic `buildCaptions(GROUPS)` included).
2. **Only change visuals inside `<style>`**: replace `.caption-pill` / `.caption-line` / `.caption-word{,.is-active,.is-spoken}` with tokens from your preset (border / shadow / radius / font / active highlight). **Do not touch** the three holes, `.caption-*` class names, `data-composition-id`, `window.__timelines["captions"]`, or the `gsap.set(className)` pattern.
3. Use only §B `var(--*)` for colors; use `clamp()` + flex-wrap for adaptive type, with the lower edge inside the bottom caption band (roughly y900-1080).

**Verify:** run §8 `build-design` + `emit-chunks` -> scroll design.html to **§C** and inspect live behavior; run `captions.mjs html` for the caption artifact (see `phases/captions/guide.md`), stdout should print `skin: preset-skin (preset-local -> ...)` + `self-lint: OK` (self-check covers every contract item in the table; any mismatch exits 1 loudly).

> The two registry karaoke skins (`caption-pill-karaoke` / `caption-highlight`) still exist, but only as **runtime fallback**. This standard requires every preset to provide its own `caption-skin.html`; missing it means **non-compliant** (caption style will break into a generic SaaS pill). `captions.mjs html` currently does not fail when the skin is missing (it falls back instead of exiting 1), so this rule is **enforced by the standard, not yet by machine**: when creating a new preset, you must add it.

---

## 4. Standard Invariants (House Rules)

1. **All text >= 24px** - every §T role `px_min`, every §I `.t-trole-*` font-size, and **every component font-size** must be at least 24px. Video must be readable at a glance from a distance; `build-design.mjs` itself says "Don't use body text under 24px in video." Headings should be around ~28px or larger to sit above 24px body text (heading > body). Purely decorative non-text values (e.g. 120px quote marks, border/shadow px) are exempt.
2. **No §M motifs** - express signature gestures with components, not motifs.
3. **Self-contained CSS** - component / §T role CSS uses only `var(--*)` tokens, with **zero raw hex/rgb** (all brand colors tokenized).
4. **Class-prefix layering** - `.t-trole-*` = §T roles; `.<prefix>-*` (e.g. `.bf-`) = this preset's components/decorations; `.ds-*` / `.preset-native-scope` are reserved for the design.html shell, do not use them in components.
5. **Section order** follows the §2 table; `§F` is never inline; `preset-meta` is always first.
6. **Own `caption-skin.html`** - every preset must provide a caption skin (§3.5), not an optional add-on. Write it according to the §3.5 contract (three holes + canonical hooks + seek-safe `gsap.set` + zero raw color), so lower-third captions share the same visual language as components. Missing it = non-compliant.

---

## 5. Add a New Preset

```bash
cd phases/design-system/style-presets
cp -r block-frame my-new-style
cd my-new-style
```

1. Edit `preset.md` `preset-meta`: `name`/`label`/`fingerprint`/`match_signals`/`best_for`/`avoid_for`/`chromeFonts` (replace with the new style's native fonts + Google Fonts href).
2. Rewrite sections §A->§I: change §B tokens (color/type/geometry), §D fallback fonts, §T role scale (**px_min >=24**), §E EASE/DUR, §G voice recipe, §H composition/color hints, §I shell + `.t-trole-*` + decorative CSS.
3. Rewrite `components/*.md` (replace `.bf-` prefix with yours; **all font-size values >=24**).
4. Change `caption-skin.html` `<style>` visuals to the new style (§3.5 contract: only change visuals; do not touch the three holes / `.caption-*` hooks / `data-composition-id` / `window.__timelines["captions"]` / `gsap.set` pattern). `cp -r block-frame` already brought it over; you only need to change visuals.
5. Regenerate + verify according to §6.

## 6. Refactor an External Style / Old Preset into This Standard

> Use this to align a non-compliant style (copied from elsewhere, or a handwritten draft) to the standard. Check each item (use block-frame for comparison):

- [ ] Delete the entire `## §M` section + `.ds-motif*` CSS blocks in §I (motifs are deprecated).
- [ ] §T: raise every role `px_min` to >=24; also raise the corresponding §I `.t-trole-<id>` font-size to >=24; delete pure small-text content roles (e.g. 15px card-body / 18px subtitle). Signature small-text-like treatments can remain in components if they are essential.
- [ ] `components/*.md`: scan every `<style>` font-size; all values must be >=24 (heading > body).
- [ ] Ensure there is >=1 component; `§F` is not inline; `preset-meta` is valid.
- [ ] Tokenize raw hex -> tokens.
- [ ] Add `caption-skin.html` (§3.5, required): after `cp block-frame/caption-skin.html`, change `<style>` visuals to this style and tokenize to zero raw color; `captions.mjs html` should print `self-lint: OK`.
- [ ] Generate + verify according to §6.

## 7. Convert "Another Style" (website / Figma / brand guidelines) into a Preset

1. **Extract DNA:** primary/neutral/accent colors -> §B tokens; font families -> `chromeFonts` + §D; radius/border/shadow/spacing -> §B private tokens (`--xx-*`).
2. **Set type scale** -> §T roles (**all >=24**), including hero/title/body/eyebrow/numbers/counters.
3. **Signature gestures -> components:** turn the style's instantly recognizable elements (cards, quote frame, stat, timeline, decoration) into separate `components/<id>.md` files.
4. **Fill** §A intent, §E motion language, §G voice, §H composition/color hints.
5. **Caption look -> `caption-skin.html`** (§3.5, required): build this style's lower-third caption look according to the contract (`cp` block-frame and change visuals).
6. Apply §4 invariants and verify according to §6.

---

## 8. Generate & Verify Loop

```bash
# Run from project root (<ds-dir> is a video project's design-system directory,
# <cap> is the hyperframes capture directory)
node phases/design-system/scripts/build-design.mjs <ds-dir> --capture <cap> --style <preset-name>
node phases/design-system/scripts/emit-chunks.mjs   <ds-dir>
```

- `build-design` -> `<ds-dir>/design.html` + `inference.json`; `--no-emit` only computes inference scores, without rendering.
- `emit-chunks` -> `<ds-dir>/chunks/` (tokens.css / easings.js / voice.md / composition-hints.md / type-roles.md / components/\*.html / index.json; when the preset has `caption-skin.html`, it also copies `chunks/caption-skin.html` and records `index.json.caption_skin_file`; see §3.5). **If design.html lacks ROOT/MOTION/VOICE markers, it exits 1** (meaning §B/§E/§G must produce output).

**"No small text" verification** (must run after edits): list every font-size below 24px (**empty output = pass**). Covers `px` / `rem` (×16) / `vw` (×19.2 @1920), and only reads each declaration's **first size token** (= clamp lower bound or raw value), avoiding false positives on the middle `vw` term in clamp:

```bash
grep -rhoE "font-size:[^;]+" <ds-dir>/chunks/components/*.html <ds-dir>/chunks/type-roles.md \
  | awk 'match($0,/[0-9.]+(px|rem|vw)/){t=substr($0,RSTART,RLENGTH);n=t+0;p=n;
         if(t~/rem$/)p=n*16; if(t~/vw$/)p=n*19.2;
         if(p<24)print "  WARN "t" approx "p"px  <- "$0}'
```

> **Do not scan only `px`** — `rem` / `vw` values will be missed; the normalized version above covers all three.

> This grep is a **hard final check**: only empty output passes — any <24px value must be raised or deleted.

**`caption-skin.html` verification** (§4 rule 6, required): every preset should provide one. Run:

```bash
node <SKILL_DIR>/scripts/captions.mjs html \
  --hyperframes <ds-dir> --groups <caption_groups.json> \
  --tokens <ds-dir>/chunks/tokens.css --out <ds-dir>/compositions/captions.html
```

stdout should print `skin: preset-skin (preset-local -> ...)` + `self-lint: OK`.

> When a skin is missing, the builder falls back to registry instead of exiting 1, so the "must provide `caption-skin.html`" rule is **enforced by this standard, not yet by machine**. When creating a new preset, be sure to add it; seeing `skin: preset-skin (preset-local ...)` + `self-lint: OK` from `captions.mjs html` means it is in place.
