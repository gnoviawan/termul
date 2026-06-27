# Visual Design (Phase 3)

## Flow Overview

1. **All inputs are already inlined in dispatch** (`## Effects catalog` / `## SFX library` / `## Design rules` [full text of 4 rules] / `## Design chunks` [`index.json` + actually present hints/voice/tokens/easings] / `## Narrator scripts` / `## Audio meta`) - **use them directly; do not Read from disk**
2. Write `## Film Direction` once (the film-level invariants — §4.1), then for each scene: choose effects from `## Effects catalog` (timeline layering order; count rules in §2), decide Continuity, write anchor block + **lean delta prose** (≤150 words; §4.2); in prose, describe desired visual components by **role** ("a stat block", "a framed quote"), while the worker chooses concrete components from the `## Design chunks` library
3. Run validator until exit 0

---

## 1. Inputs

### `narrator_scripts.json`

- Scene-level: `sceneNumber`, `sceneName`, `narrativeIntent.{type, narrativeRole, keyMessage, persuasion, emotionalBeat}`, `transition.{continuity, intent, sharedMotif?, description}` (`continuity` copies directly to `**Continuity:**`; `intent` translates to `**Transition:**` registry type using the "Transition: translation" table only for `break` scenes; when `intent: morph` on a `continue` scene, `sharedMotif` is a prose hint for the carried element, not an anchor), `assetCandidates[]` (each has `path` + `description`), `estimatedDuration` (strip trailing `"s"` -> float)
- Top-level: `narrativeArchetype` + `emotionalArc`, which influence whole-film pacing

### `## Design chunks` - Brand Input (inlined; do not read `design.html`)

Chunks are split by Phase 1b `emit-chunks.mjs` and **already inlined in the dispatch `## Design chunks` block**: full `index.json` + actually present `composition-hints.md` / `voice.md` / `tokens.css` / `easings.js` (chunks absent from the preset have `*_file=null` and do not appear in the block).

**Whenever this guide says "find X in `## Design chunks`", do not read from disk.** Plan does not touch `design.html` or component HTML bodies.

> **`## Design chunks` is the brand's style reference library** — palette (tokens), motion curves (easings), DOM text register (voice), and paste-ready components. Authority lives in `## Effects catalog` and `## Design rules`; chunks make the result **look like this brand**. Plan describes structures by **role / purpose / intent** in prose; Phase 4b worker chooses concrete components by visual judgment.

Plan uses chunks in these ways:

1. Inspect `chunks/index.json` (~1-2 KB) -> get `preset` name + component library list (`components[]`, each `{id, file}`). **Only use this to know what components exist in the preset**, so prose can refer to them by role ("use a stat-stamp-like number block"). No need to map each one, cite ids, or compute surfaces - worker chooses after seeing actual render.
2. Optionally inspect `chunks/composition-hints.md` (only when `index.json.hints_file != null`) -> preset's own **composition / material / color preferences** (background preference, 60-30-10 distribution, signature materials). Fold it into prose as style reference for palette / composition; worker uses it when implementing colors. This is taste guidance, **not** a hard "violation = render failure" contract.
3. Optionally inspect `chunks/tokens.css` (~1-2 KB) -> available role tokens in `:root` (`--canvas` / `--ink` / `--brand-*` / preset-private aliases like `--paper` / `--blue` / `--cream`) - informs descriptions of 30% middle layer and pain-scene palette.
4. Optionally inspect `chunks/easings.js` (~0.5 KB) -> whether role keys `EASE.entry / emphasis / exit / drift` are present, deciding which ease intents to cite in prose.
5. Optionally inspect `chunks/voice.md` (~0.5 KB, only when `voice_file != null`) -> this preset's DOM text register (strip / case / line breaks / inline `<em>`...). **Worker receives full voice.md through a dedicated channel and applies it by default**, so plan **does not need** to promise it scene by scene; mention it only for a **special application / risk** in that scene (e.g. "hero resolves as one-line UPPERCASE stacked words"). Plan does not write rewritten English copy (that is worker work).

No need to read `chunks/type-roles.md` -> named text role directory (worker lookup table for inline text styling). Plan does not cite role ids; it describes by role name ("hero display", "body lede").

**Do not read:** component HTML bodies (`chunks/components/<id>.html`) - Phase 4b worker owns that. **Do not read** legacy `design.html` (replaced by chunks).

**Plan references by role / purpose / intent, not literal values.** See §3 guidance:

| Name this                                              | Do not copy                                    |
| ------------------------------------------------------ | ---------------------------------------------- |
| **Role** (canvas / surface / accent / ink)             | concrete hex (`#e4ff97`)                       |
| **Purpose** (display / body / mono)                    | concrete font name (`Instrument Serif`)        |
| **Intent** (`EASE.entry` / `DUR.med`)                  | concrete curve (`power3.out`)                  |
| **Component role** ("a stat block" / "a framed quote") | component id / internal HTML / `<style>` block |
| **Voice register** ("UPPERCASE triplet")               | rewritten English copy (worker work)           |

### Do Not Read

- `effects-catalog.md` / `rules/*.md` (already embedded in dispatch as `## Effects catalog` / `## Design rules`)
- `chunks/*` from disk (already embedded in dispatch `## Design chunks`)
- sidecar JSON / fonts directory under `design-system/`
- `design-system/design.html` (old contract; now replaced by `chunks/`)
- `chunks/components/<id>.html` body (plan only names role; component HTML is Phase 4b)

---

## 2. Hard Contracts (machine-checked)

**Whole-file shape (mandatory):** `section_plan.md` contains **only** an optional single-line H1 title + **one `## Film Direction` block** (validator-required; content in §4.1) + a sequence of `## Scene N:` blocks, **nothing else**. Film Direction is a **real channel**, not a preface: `prep.mjs` copies it into `group_spec.film_direction`, and the orchestrator prepends it to every scene worker's shared packet header and to the finalize dispatch. Any **other** content before the first `## Scene` = dead bytes and a validator error. Global invariants reach workers through **two real channels**: 1. the `## Film Direction` header (film-level rules, written once); 2. dedicated channels (`voice_file` / `Captions` flag / `tokens.css` / `easings.js`). Scene prose carries **only scene-specific deltas** on top of those. The "restatement" before writing (§4 Step 0) happens **in your head only**; never write it into the file.

Each scene in `section_plan.md` is one block, in the same order as `narrator_scripts.json`:

```markdown
## Scene <N>: <sceneName>

**Effects:** [`<rule-id>`, `<rule-id>`, ...]
**Duration:** <X.XXs>
**Continuity:** break | continue
**Transition:** <type> [DIRECTION] [<dur>s] <- optional (soft); the Tier-B transition for a `break` scene, see below (omit on a `continue` scene)
**Hierarchy:** <simple | multi-act | action | social-proof | data-proof> <- optional (soft); declares the focal profile that drives the PST/Handoff gate, see below
**SFX:** <- optional (soft); omit entire section when unused; multi-line bullet list below
**PrimarySubjectTimeline:** <only for multi-act / dense multi-subject scenes>
**Handoff:** <only for multi-act / dense multi-subject scenes>

<prose body - first sentence is §4.2 item 1 emotional footnote - see §4>
```

**Order inside the block is mandatory, and PrimarySubjectTimeline / Handoff must appear after all anchors and before prose** (immediately after SFX block). Reason is mechanical: `prep.mjs` defines `creative_brief = all text after the last recognized anchor`, and it recognizes `SFX` but **does not recognize** `PrimarySubjectTimeline` / `Handoff`; therefore those two lines must come after SFX so they enter the worker brief. If placed before SFX, they get sliced away and worker never receives them. Rules: 1. all `**Anchor:**` lines (including SFX bullet block, PST, Handoff) are grouped at the top; 2. only then comes free prose, whose **first sentence** is the emotional footnote (§4.2 item 1, "the dividing line between real plan and generic AI output"); 3. once prose starts, **no more `**Anchor:**` lines** (interleaving = validator fatal). For multi-act scenes, the brief may start with `**PrimarySubjectTimeline:**` followed immediately by emotional footnote; that is expected.

`validate-section.mjs` enforces (hard):

- **Effects:** 2-5 backtick-wrapped rule ids, comma-separated inside brackets; each id must be an existing rule under `hyperframes-animation/rules/` (the validator actually checks this). Normally cite only from dispatch `## Effects catalog`; order is timeline-layering order.
- **Duration:** float seconds (source in §1)
- **Continuity:** `break` or `continue`; **Scene 1 is always `break`**. Copy scriptwriting `transition.continuity` verbatim. `continue` = this scene shares a worker with the previous one (a continuous run of up to 3 scenes); `break` = new worker. No Tier-A / Bridge requirement.
- Required anchors each stand alone on their own line, with no surrounding text; missing any required anchor -> downstream fatal -> rerun Phase 3
- **PrimarySubjectTimeline + Handoff:** required for multi-act scenes or scenes where action/payoff + proof/supporting subject share the frame. Missing either -> validator fatal. **Position:** immediately after SFX block and before prose (machine reason in template note above - they must enter `creative_brief` for worker). The "is this scene risky" trigger is read from the optional `**Hierarchy:**` anchor when present (a schema check), else inferred from the prose — see the **Hierarchy anchor** subsection below
- **Block order:** all `**Anchor:**` lines (including SFX bullets, PrimarySubjectTimeline, Handoff) must precede free prose; any `**Word:**` anchor line after prose begins -> validator fatal (interleaving makes worker brief unpredictable)
- **File-level:** before the first `## Scene` only one H1 title + one `## Film Direction` block are allowed; **missing `## Film Direction` -> validator fatal**; Film Direction > 700 words -> fatal (it is a one-page header, not a second plan); any other preface -> fatal (see whole-file shape above)
- **Per-scene prose length:** target ≤150 words; > 320 words -> validator fatal. Walls of prose are almost always film-level invariants restated per scene — move them into `## Film Direction`
- **Transition** (soft / if present): type must be a Tier-B type in the TRANSITION-REGISTRY vocabulary (`crossfade` / `blur-crossfade` / `push-slide` / `zoom-through` / `squeeze`); direction is only legal for a directional type (`push-slide`); duration `0 < dur <= 2.0s`. It names how a `break` scene is entered; on a `continue` scene it is ignored because the same worker authors one shared-DOM group composition. There is **no** `**Bridge:**` anchor and no Tier-A contract.

**Components (no anchor - worker chooses):** plan no longer pre-cites components with a `**Components:**` anchor. The full component library (`chunks/components/`) is forwarded to worker, and worker chooses by visual judgment. Plan only names desired structures by **role** in prose ("a framed stat block", "a pill row of labels"), not ids or HTML - same role/purpose approach as palette/type.

**Transition anchor (optional / soft - names "how a `break` scene is entered"):**

> This subsection is the authoritative writing guide for transitions (single source of truth). The later "Transition: translation" table only maps `intent -> registry type`; it does not restate machine rules.

- Shape: `**Transition:** <type> [DIRECTION] [<dur>s]`, e.g. `**Transition:** blur-crossfade` / `**Transition:** push-slide LEFT` / `**Transition:** zoom-through 0.3s`
- Types (all Tier-B, injected by the harness onto clip wrappers after assembly; **you never write GSAP**): `crossfade` / `blur-crossfade` / `push-slide` (with LEFT/RIGHT/UP/DOWN) / `zoom-through` / `squeeze`. Full vocabulary + selection guidance in `<SKILL_DIR>/../hyperframes-animation/transitions/TRANSITION-REGISTRY.md`
- **Use only 2-3 Tier-B types across the film** (repetition = professional cohesion; see motion-language.md "transition vocabulary"). Scene 1's Transition is an opening placeholder (no previous scene, ignored) and may be omitted
- **Omitting the line = accept default:** the harness derives a Tier-B default from surface conflict / energy (clashing backgrounds -> `blur-crossfade`, high energy -> `zoom-through`, otherwise `crossfade`). Omit when uncertain; the default is usually good
- A `continue` scene needs **no** Transition anchor (see "Continue runs" below). The worker owns the entire continue run inside one shared-DOM group composition; the harness only handles Tier-B transitions between different visual clips. You only name intent; **never write transition code, touch timing, or touch index.html**

**Continue runs (continuity: continue) — same-worker visual continuity:**

- A `continue` scene shares a worker with the previous scene. `prep.mjs` groups a continuous run of **up to 3 scenes** (cap=3) into one worker and, when the run has 2-3 scenes, that worker writes **one** visual file (`group_wN.html`) with true shared DOM across the logical scenes.
- Use `continue` for 2-3 adjacent scenes that should read as one continuous shot — a process-step card that accumulates details, a logo/card family that progressively gains content, a persistent curve/counter/node graph, a growing diagram, or a camera that keeps moving. Describe the continuity in prose with an explicit carried subject: the same component family or the same diagram/data-viz primitive should persist and evolve inside the run.
- For a continue run, the prose "eye destination" sentence (§4.2 item 6) must state: what persists, what changes at this scene's segment, and what pose/state should be handed to the next logical scene. Do not describe a traditional transition at that internal seam.
- A run is at most 3 scenes; if more than 3 adjacent scenes share a stage, split into runs separated by a `break`. There is **no** Tier-A bridge, no `data-bridge-id`, no `**Bridge:**` anchor, and no wrapper transition inside the run — just mark `continue` where the flow is genuinely continuous.

> This is the plan agent's explicit commitment about how scenes connect. It must align with the prose "eye destination" sentence (§4.2 item 6) — that sentence is human-readable creative direction; `**Transition:**` is only a machine instruction for break seams.

**Hierarchy anchor (optional / soft — declares the scene's focal profile):**

A scene that stacks competing focal claims — it is multi-act, or an action/payoff (CTA) co-exists with proof (logos / stats) — must carry `**PrimarySubjectTimeline:**` + `**Handoff:**` (see the enforces list above). `validate-section.mjs` decides whether a scene is "risky" in one of two ways:

- **Declare it (preferred — turns the check into a schema read).** Add a `**Hierarchy:**` anchor naming the profile from this fixed vocabulary: `simple` / `multi-act` / `action` / `social-proof` / `data-proof` (comma- or space-separated, e.g. `**Hierarchy:** action, social-proof`). Declared values are **authoritative**: a scene tagged `simple` is never treated as risky even if the prose mentions logos or a CTA, and one tagged `multi-act` is gated even if the prose reads calm. An out-of-vocabulary tag is a validator fatal, so a typo can't silently disable the gate.
- **Omit it (fallback).** When absent, the validator infers the profile from the prose (the historical keyword classifier). This still works but is fuzzier and can mis-read incidental wording — declaring the anchor removes that ambiguity.

The anchor is **validator-only**: prep strips it before the worker brief, so it never adds noise to scene content. Place it among the anchors, before prose (it's in the block-order anchor set).

**SFX anchor (optional / soft - only write when using sound effects):**

Most scenes have no SFX - in that case **omit the entire `**SFX:**` line**. Omission = "no sound effect for this scene", validator does not complain. To add SFX, write `**SFX:**` alone on a line + one or more bullets:

```markdown
**SFX:**

- `impact-bass-1.mp3` at 0.2s, volume 0.35 — hero stamp lands
- `whoosh-short.mp3` at 4.1s — exit
```

(Explicit `**SFX:** none` is also accepted; but because it is optional, omitting the line when unused is simpler.)

**No silent drop risk:** once you cite a `<file>.mp3`, validator checks it immediately against `## SFX library` - misspelled filenames are Phase 3 fatal errors you can fix on the spot, no longer silently dropped by prep.mjs. So optional is safe: not writing = explicitly unused, writing = guaranteed valid.

- `<file>.mp3` must be listed in dispatch `## SFX library` (misspelling = validator fatal)
- `<T>s` is **scene-local seconds**; prep.mjs adds `start_s` offset automatically
- `volume` optional, default `0.35`; under narration use 0.2-0.3, pure SFX can be 0.4-0.6, 0.5+ may cover voice
- ` — <note>` is human annotation

**Placement rules:**

- **Impact / hit** (`impact-bass-*` / `ping` / `pop` / `glitch-*` / `whoosh`): trigger at the exact visual point, letting decay carry into the next shot (J-cut)
- **Riser / build-up** (`riser` 10s / `whoosh-cinematic` 5.5s): peak at the end; if it should explode at N seconds, trigger at `N - duration`
- **Short accent** (`click` / `click-soft` / `chime` / `sparkle` / `ping` / `whoosh-short`): sync with the visual point

**Less is more:** most scenes have zero SFX; one cue in a scene is typical. **Do not** add SFX at scene transitions (the hard cut itself is the audio-visual event).

**Forbidden:** estimated timestamps (`verify-output.mjs sfx` enforces ±0.1s drift) / shortening `data-duration` (impact cut mid-decay = amateur feel).

Available mp3 list is in dispatch `## SFX library` (each item has file / duration / purpose) - choose by purpose.

### Primary / Supporting Anti-Overlap Contract

Remember one rule: **only one primary subject at a time; all other visible content must be supporting.**

Risk scenes must include these two lines before prose:

```markdown
**PrimarySubjectTimeline:** 0-4.0s product panel primary; 4.0-7.0s proof cluster primary; 7.0-10.0s action headline primary, proof cluster supporting rail.
**Handoff:** Before the action headline enters, the proof cluster demotes to a small low-contrast rail. Camera push does not count as handoff. The new primary owns the center safe zone.
```

Rules:

- Multiple subjects can be on screen, but only one is primary; the rest must be supporting rail / side rail / background texture / low-emphasis chrome.
- Before a new primary enters, previous primary must exit / hide / compact / demote; **camera pan / zoom / push does not count as exit**.
- Action / payoff frame: primary headline / product / decision point owns the center safe zone; proof, labels, logos, stats, and card clusters, if retained, must be smaller, lower contrast, less animated, and outside primary bbox.

**Continuity comes directly from scriptwriting** (no inference): each scene `transition.continuity` in `narrator_scripts.json` (`break` | `continue`) - **copy it verbatim into the `**Continuity:**` anchor**. `continue` lands the scene in the same worker as the previous one (a continuous run of up to 3 scenes); `break` starts a new worker. Scene 1 is always `break`. Cross-scene consistency is covered in §5 "variety" soft guidance.

**Transition: translating scriptwriting narrative `intent` to concrete registry type** (this is visual-design's job - you have preset/palette/background/energy context; the scriptwriting phase does not). Each scene's `transition.intent` in `narrator_scripts.json` is one of 5 narrative intentions; translate it to a `**Transition:**` registry type only for `break` seams using the table below (full vocabulary in `<SKILL_DIR>/../hyperframes-animation/transitions/TRANSITION-REGISTRY.md`):

| scriptwriting `intent`             | -> `**Transition:**` registry type                              | Notes                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `morph` (+ `continuity: continue`) | _(no Tier-B type)_                                              | same-worker continue run; the worker writes one shared-DOM `group_wN.html` and authors the carried element inside that timeline — no `**Transition:**` / `**Bridge:**` anchor needed |
| `cut`                              | `crossfade`                                                     | clean cut; for high-energy moments you may omit Transition anchor and let default apply                                                                                              |
| `slide`                            | `push-slide <direction>`                                        | direction matches narrative flow (forward=LEFT/RIGHT, expanding downward=DOWN)                                                                                                       |
| `dissolve`                         | `blur-crossfade` when backgrounds clash / `crossfade` otherwise | inspect both scene `#root` backgrounds: large difference -> blur hides hard cut; similar -> normal crossfade                                                                         |
| `zoom`                             | `zoom-through`                                                  | camera push / high energy                                                                                                                                                            |

- **You have visual context, so you may override:** if a default translation is wrong for the preset (e.g. color clash should use blur where table says crossfade), use visual judgment - table is default, not law.
- **Use only 2-3 transition types repeatedly across the film** (repetition = cohesion, see motion-language.md). All harness transitions are Tier-B and occur only between different visual clips; `intent` narrows the choice and you pick concrete values within it.
- **When uncertain, omit the `**Transition:**` anchor** - downstream prep derives a Tier-B default from energy/color clash (see §2 Transition anchor). A `continue` scene needs no Transition anchor at all.

**`intent: morph` on a `continue` scene** is a soft hint: mark `**Continuity:** continue` (no Transition / Bridge anchor) and describe the carried element in prose. The one worker owning the continue run writes one group composition and authors the morph/accumulation with persistent DOM — there is no `**Bridge:**` anchor, no `data-bridge-id` contract, and no wrapper seam to hide a mismatch (see §2 "Continue runs").

> If the effect you need is not in catalog: first try combining existing effects. Still insufficient -> **do not invent a name**; mark in phase report `needed effect missing: <description>`.

---

## 3. Design Principles (inlined in `## Design rules`)

Four rule files (already inlined in dispatch; do not read from disk):

- `rules/typography.md` - 7-level type role ladder / multi-dimensional hierarchy / font pairing / forbidden pairs / CJK
- `rules/color-system.md` - 7 palette roles / 60-30-10 / cross-scene consistency / dangerous combinations / background layering
- `rules/composition.md` - four canvas zones / 7 templates (film >=3 templates) / density rules / depth techniques
- `rules/motion-language.md` - 5 spring intents / duration tiers / beat structure / stillness-before-climax (2-3 scenes, allocated in Film Direction) / motion budget (one macro move + 1-2 live elements) / transition vocabulary (film 2-3 types)

### Choosing the 2-5 `**Effects:**`

Compose freely from `## Effects catalog` to fit the scene's `narrativeRole` + `keyMessage` — there are no pre-baked skeletons. Free composition is the correct path for explainer scenes (concept naming, mechanism step, list item, quote, stat). To reach 2-5:

- Default-add `sine-wave-loop` (continuous / ambient layer) on most scenes — but plan its amplitude per `rules/motion-language.md` "Motion Budget" subtle defaults (±2-3 px / ±1-2% scale, 2.5-4s cycle), and remember it occupies one of the scene's 1-2 secondary live slots. **Drop it entirely** on the closing beat and on any scene where the idle phase would exceed 50% of duration; that scene `settles and holds` instead. Across the film, ≤ 2 consecutive scenes carry sustained drift.
- Then add by emotional beat: transition glue `scale-swap-transition` / `card-morph-anchor`, SVG life `svg-icon-enrichment` / `svg-path-draw`, data beats `counting-dynamic-scale` / `asr-keyword-glow`, depth reinforcement `3d-text-depth-layers` / `split-tilt-cards`.
- Effect order = timeline layering: background -> primary entry -> continuous -> emphasis -> transition.

---

## 4. Writing the Plan - Film Direction Once, Scene Deltas After

**Step 0 (before writing, mandatory):** restate voice register to yourself - that restatement **only sets direction in your head**; what belongs on disk is `## Film Direction` (film-level invariants, §4.1) and the scene blocks; any other preface = validator fatal.

**The litmus test that governs this whole section:** _"Could this sentence appear verbatim in another scene's prose?"_ **Yes -> it belongs in `## Film Direction`, not in the scene.** The archived failure mode this kills: an 11-scene plan of 4,000 words where every scene restated the caption band, the 60-30-10 split, the ambient layers, `multiplicative breathing`, and a `stillness-before-climax` - ~80% invariants repeated 11×, burying each scene's 2-3 genuinely unique ideas where the worker had to dig for them.

### 4.1 `## Film Direction` (write once, before Scene 1; hard cap 700 words, aim for ~250-400)

The film-level invariant layer. prep.mjs copies it into `group_spec.film_direction`; the orchestrator prepends it **verbatim** to every scene worker's packet and the finalize dispatch - so anything written here reaches every downstream agent exactly once. Cover, as compact labeled lines / short lists:

1. **Palette system** - the film's 60-30-10 by role with accent binding ("60% canvas / 30% hairline + repeated canvas (no surface token) / 10% accent: brand-primary carries heroes and the merge moment, deco-3 cyan as diff-addition accents only").
2. **Type roles** - what display / body / mono are for across the film (in a code-change film, mono usually owns code, paths, and diff fragments - say so once here).
3. **Motion defaults + budget** - default ease intent per element class ("entries `EASE.entry`; heroes heavy; idle `EASE.drift`; exits none - scenes hold the final frame"), and the film's **motion budget**: every scene gets ONE root-level macro motion (camera drift / dolly / parallax) + at most 1-2 secondary live elements; everything else rests (see motion-language.md "Motion Budget" - its subtle-amplitude defaults and scaling rules apply film-wide; per-scene prose names only justified departures). Reference only canonical role keys `EASE.entry/emphasis/exit/drift`, `DUR.snap/med/slow` - worker uses this key set directly; invented aliases fall through.
4. **Ambient system** - the recurring background / atmosphere layers and any alternation scheme ("architectural grid + paper grain, full-bleed every scene; dark↔light ground alternation by scene parity").
5. **Film negative list** - what NO scene may do ("no mesh gradients, no neon-on-black, no glow bloom, no purple-blue AI gradient, no bokeh").
6. **Transition vocabulary** - the 2-3 Tier-B registry types this film repeats (must agree with the per-scene `**Transition:**` anchors; `continue` seams are worker-authored and not part of this count).
7. **Asset coverage table** - every `assetCandidates[]` path -> the scene that uses it + its role, or `DROP` + a one-line reason. This is the **single place** coverage is decided; scene prose never defends keeping or dropping an asset. In this workflow `assetCandidates` is usually `[]` (visuals are LLM-invented per scene) - **when no scene has candidates, omit the table entirely**; when some do (a user-supplied image, a contributor-avatar clip), every path gets a row.
8. **Stillness-before-climax allocation** - name the 2-3 scenes (max) that get the beat, where the narration lands a payoff. Repeated in every scene it stops being a comma and becomes a tic.
9. **Captions** (only when top-level dispatch says `Captions: enabled`) - one line: the bottom ~17% band is reserved film-wide, foreground anchors around 0.42×height; per-scene prose mentions captions only for genuinely risky placements.

Same role/intent discipline as everywhere: **no hex / font names / ease curves / px / ms** (those live in `tokens.css` / `easings.js` / build work).

### 4.2 Scene prose (after anchors; target ≤150 words, validator-fatal above 320)

One free-prose paragraph of **scene-specific deltas only**, passed verbatim to the build agent - write as if briefing a senior animator who has **already read Film Direction**. In order:

1. **Emotion and rhythm footnote** - one sentence naming the beat's _feeling_ and _rhythm_ ("frustrated, slightly-off comma", "luminous launch-film slow build"). **This is the dividing line between real plan and generic AI output.**
2. **Composition + subject** - composition template (centered / thirds / split / layered / asymmetric / triptych / strip), the primary visual and its canvas share (>=40%; the primary visual is the chosen faceless register - kinetic type / graphic / diagram / data-viz / code-window - not a screenshot), supporting elements by role, whitespace intent. Mention the caption band only when this scene's concept pushes content low ("stat stamp's bottom edge sits just above the caption band"). A candidate ending in `.mp4` / `.webm` / `.mov` is a **moving clip**: say _when in the phase timeline it plays_ and whether it holds or loops (worker declares it on a poster `<img>` via `data-video-src`; `hoist-videos.mjs` mounts the real host-root `<video>` - a `.png` still is the static fallback).
3. **Scene-unique choreography** - for every id in `**Effects:**`: the text label, graphic, diagram element, or data-viz series it drives (name the register and the key text/data it carries, not a `public/<basename>` path - see "Faceless visual register" below; on the rare scene with non-empty `assetCandidates`, name the asset per the §4.1 coverage table), and when it fires (scene-local relative seconds / ratios - **never restate total duration**; worker timing is pinned from `group_spec`). Name this scene's **macro motion** (which camera-style move from the budget). Name spring intent / `EASE.*` keys / ambient amplitudes **only where the scene departs from the Film Direction defaults** (e.g. a justified higher-end amplitude per motion-language.md's scaling rules, or a long-idle `settle and hold` tail). The emotional beat sets phase ratios; do not stamp the same phase skeleton on every scene.
4. **Style deltas** (only if any) - where this scene deviates from Film Direction ("accent flips to deco-4 magenta as the hot focal this scene"; "text one weight lighter on the dark ground"). Nothing deviates -> write nothing.
5. **One negative sentence** (only if scene-specific) - "no glow on the cursor - flat pixel cursor only". Film-level negatives live in the header; do not repeat them.
6. **Eye destination** - one short sentence on where the eye travels into the next scene. **At a `break`, the Tier-B transition is injected by Step 7 onto the clip wrappers and the worker writes no exit tween** - do not elaborate veil/dissolve/curtain mechanics (the machine instruction is the `**Transition:**` anchor, break scenes only). **At a `continue` seam (same worker), specify which element carries across and roughly how it should look at the handoff** so the worker can author the continuous flow inside one group timeline.

### Faceless visual register

Faceless explainers have no captured assets; the scene's primary visual is invented. **Two registers are equally first-class, and the worker picks per scene by what the script is explaining:**

- **(a) Typography / abstract graphics** - kinetic type, hero words, framed quotes, shapes, gradients, icon fields, brand-derived geometry. Reach for this when the script states a **thesis, claim, quote, or term** ("a process / a number / a comparison" has no obvious figure).
- **(b) Diagram / data-viz** - step flows, node graphs, timelines, charts, comparison tables, counters. Reach for this when the script describes a **process** (-> diagram / numbered steps), a **number or comparison** (-> data-viz / chart / counter), or **structure / relationships** (-> node or flow diagram).

Neither register is a fallback for the other - a typographic scene is a full, deliberate composition (composition.md "Frame Density"), and a diagram scene is not "more real" for having boxes. Vary the register across the film the way you vary composition templates (§5 Variety): an all-typography film reads flat, an all-chart film reads like a dashboard. Name the chosen register in prose item 3 (§4.2).

**Do not** write pixel values, GSAP timeline code, composition HTML, concrete hex / font names / ease curves - that is build-agent work. **Do not re-promise what already travels via Film Direction or dedicated channels:** caption-band geometry, palette ratios, ambient layers, breathing / idle defaults, `EASE`/`DUR` labels that match the declared defaults, voice recipe mechanics (worker has the full `voice_file`; mention voice only for a special application - "hero resolves as one-line UPPERCASE stacked words"), or asset-coverage defenses ("rather than being dropped" - the §4.1 table owns coverage). **Every surviving word should be a decision unique to this scene.**

Anchor order (PST/Handoff before prose) is in §2 and unchanged - risky scenes still carry `**PrimarySubjectTimeline:**` + `**Handoff:**` lines.

### Complete File Example (header + one scene)

```markdown
# refactor(parser): streaming tokenizer — Engineering Slate

## Film Direction

**Palette:** 60% paper canvas / 30% hairline rules + repeated canvas (no surface token) / 10% accent — brand-red carries every hero and the merge moment; deco-green only as diff-addition marks. Ink stays warm off-black.
**Type:** display = hero claims only; mono = code, paths, diff fragments, eyebrows; body = explanatory lines.
**Motion:** entries EASE.entry; heroes heavy; idle EASE.drift; exits none — scenes hold the final frame. Budget: one root-level camera move per scene (slow drift or push) + at most one breathing hero; everything else rests.
**Ambient:** architectural grid at low opacity + paper grain, full-bleed, every scene. Nothing else.
**Never (film-wide):** no mesh gradients, no neon, no glow bloom, no bokeh.
**Transitions:** crossfade + push-slide only.
**Stillness-before-climax:** scenes 2 and 5 only.

## Scene 4: how-it-connects

**Effects:** [`svg-path-draw`, `discrete-text-sequence`, `center-outward-expansion`, `sine-wave-loop`]
**Duration:** 6.20s
**Continuity:** continue

Beat 2b — assembly (curious, building, click-into-place rhythm). Centered node-diagram composition: three labelled pipeline stages fill ~55% of canvas, generous breathing room around them. `svg-path-draw` traces the connecting edges one at a time (~0.6s each); as each edge lands `discrete-text-sequence` snaps in its stage label; `center-outward-expansion` reveals the nodes from the middle outward; `sine-wave-loop` carries the settled graph at one collective subtle breath. Macro motion: slow push-in on the scene root across the whole beat. Accent binds to the live edge only — settled edges fall to ink. Setup hold ~0.5s → edges-and-labels assembly ~4.5s (snappy per edge) → settle and hold. No glow on the edges — this is a clean schematic, not a network-effect ad. The completed graph hands off to Scene 5 holding its final pose, ready to gain the new tokenizer node.
```

That scene block is ~120 words of prose, and **every sentence is unique to the scene** - that is the target shape. The palette system, ambient grid, breathing defaults, and caption band are all upstairs in Film Direction, written once.

---

## 5. Soft Guidance (taste-level, affects plan quality but not validator)

### Scene Quality Floor - Motion Budget

> Declared once in Film Direction item 3 ("Motion defaults + budget"); full rationale + the subtle-amplitude defaults and scaling rules in motion-language.md "Motion Budget". Do not re-spec it per scene - scene prose only names which macro move this scene uses (§4.2 item 3).

Every scene gets:

1. **ONE macro motion** (required) - a root-level camera-style move: slow drift, dolly in/out, push, parallax. It moves every layer coherently (background counter-scale is an archive signature; concrete values are build work) - this global correlation is what makes a frame read as _filmed_ rather than _animated UI_.
2. **At most 1-2 secondary live elements** - hero multiplicative breathing (on final scale, not yoyo), CTA glow pulse, a single ambient deformation. Pick from motion-language.md's pattern menu, at its subtle-default amplitudes.
3. **Everything else rests.** Stillness is not dead air - it is what makes the moving element read (composition.md hierarchy: "one element moving vs all else static" is a strong contrast). A scene where everything floats at its own phase reads as noise, not life.

An element that springs in and then sits still while the camera holds = slide. An element that rests while the camera drifts = cinema.

### Scene Quality Floor - Ambient Layer

The ambient system (background swell / grid / scanline / particles / halftone) is declared **once** in Film Direction item 4 and mounted by every scene - scene prose does not re-list it. Per scene, what remains a floor:

1. **No bare solid background** - the film's declared ambient layers must actually be present
2. **Emphasis moment** - at least one impact beat (ripple / glow burst / impact lines / screen-shatter)

### Multi-Phase Choreography

```
entry -> ambient drift -> major transition (morph / pivot / collapse) -> [stillness-before-climax (~0.3-0.75s), only in the 2-3 scenes Film Direction allocates] -> result / emphasis -> idle hold
```

Phases vary by the beat's role (motion-language.md "Beat Structure"): a fast-montage scene may be two phases; a process-reveal scene may be one continuous take. Do not stamp the same skeleton on all scenes.

### Forbidden Patterns (most common failures)

- no macro motion: camera holds AND every element settles after entry (the scene reads as a slide)
- treating 3px micro-float as the only "motion" (archive minimum amplitude ±6px or ±2-5% scale)
- the opposite failure: everything moves - more than the budgeted 1-2 live elements floating / breathing / orbiting at once (uncorrelated ubiquitous motion = noise; it also erases motion as a hierarchy signal)
- using word-by-word text popping as the _primary_ visual (unless carefully choreographed as visual lead)
- all elements enter simultaneously (must stagger; total <=500ms)
- only ambient layer, no primary content (particles + captions)
- same composition every scene (at least 3 different templates per film)
- primary visual element <40% of canvas
- **when captions enabled, key content (CTA / hero / stat stamp / headline) enters bottom ~17% (y>900) caption band = covered by captions** (background/ambient layers may extend down; key foreground may not)
- generic AI clichés: saturated neon on pure `#000`, purple-blue AI gradient background, decorative floating bokeh balls
- solid background without swell / grid / scanline / particle
- in a scene Film Direction allocated a `stillness-before-climax`: jumping directly from action to payoff with no comma; in every other scene: stamping the comma anyway (a signature repeated everywhere is a tic)
- multiple primary subjects fighting for center safe zone; any product / proof / logo / stat / headline / card cluster on screen together must have primary/supporting and handoff
- treating camera pan / zoom / push as old-content exit; camera moves the viewpoint but does not automatically reduce old primary visual weight
- **copying concrete hex / font names / ease curves from `chunks/tokens.css` / `chunks/easings.js` into prose** - that is build-agent work

### Variety

Across all scenes, use at least 3 different composition arrangements. The strongest archive plan (playground-launch) used 5+ visual universes across 8 beats, glued with one shared transition vocabulary (cut-the-curve) + one shared palette grammar. **Visual worlds varied, seam treatment consistent** - that is the principle.
