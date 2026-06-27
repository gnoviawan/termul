## Core Principles

The video narrative is independent from the input text's layout. An article / brief / set of notes is an information dump; a video is a guided act of understanding.

- Scene sequence comes from narrative design, not from the input text's paragraph order.
- A text may run `intro -> background -> detail -> detail -> caveat -> conclusion`; a video may run `hook -> question -> concept -> mechanism -> example -> takeaway`, or `setup -> tension -> turn -> resolution -> lesson`, or `promise -> step -> step -> step -> payoff`, depending on the structure.
- Reorder, merge, omit, or compress the source text as needed. Strip the asides; surface the spine. The single most common failure is paraphrasing the article in order — do not do that.
- The input text is the source of **information**, not a story template.

The planning standard: **write the emotional beat alongside the structural type**, **name the specific rhetorical / clarity technique** (do not merely write "explain the idea"), and **specify a transition for every seam**. What carries the viewer's eye from scene N to scene N+1 is part of the story itself, not something to defer to the visual phase.

## Pick the Style Preset (you choose it; it sets the whole look)

This workflow does **not** hardcode a preset. Read the input, **pick one of the 5 shipped presets**, emit it as the top-level `stylePreset` in `narrator_scripts.json`, and match the narration register to it. The deterministic design-system step runs right after you return and builds the entire visual system from your choice — so `stylePreset` is the single lever that sets the film's look. There is **no `inference.json` to read** at this phase (design-system has not run yet); your choice _is_ the register signal. Default to `pin-and-paper` when nothing clearly fits.

| `stylePreset`   | Look                                                                                                      | Pick it when the topic is…                                          | Register                         |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| `pin-and-paper` | Yellow field-notebook paper, hard ink offset shadows, hairline ink — warm, handmade, considered (default) | reflective, educational, notes-like, humane — safe for almost any   | warm, plain, considered; no hype |
| `block-frame`   | 4px solid ink borders, hard black offset shadows, saturated pastel cycle — bold, poster-like, punchy      | confident, energetic, declarative; bold claims, "loud" explainers   | crisp, confident, declarative    |
| `capsule`       | Universal pill geometry, soft low shadows, Didone serif + grotesk — rounded, modern-editorial, friendly   | approachable, lifestyle, product-adjacent, polished                 | friendly, polished               |
| `scatterbrain`  | Cork / paper with post-its, hand-placed tilt, soft paper-lift — playful, messy-desk, brainstorm           | casual, fun, ideation, list-y, "my scattered notes"                 | light, conversational            |
| `claude`        | Warm cream editorial surface, hairline elevation, **ships a code-window** — literary, technical-but-human | technical / dev-ish / thoughtful longform; anything that shows code | warm, plain, considered          |

The preset tunes the **voice**, not the structure: scene segmentation is driven by the input text + the structure decision below.

## Explainer Structures

Before segmenting scenes, choose **one** explainer structure (or explicitly name a compound; see "Compound structures" below). Read its `overview.md` for guidance and study its samples. Do not splice phases from different structures, because each one is a complete, coherent path through understanding.

<structures>
<concept-explainer path="structures/concept-explainer/overview.md">
**Concept Explainer** — "what is X, and why does it matter." Open a curiosity gap, name the core concept, build understanding one layer at a time (definition -> mechanism -> implication), land a takeaway. Best for: a single idea, term, technology, or phenomenon the audience has heard of but does not truly grasp. The concept is usually named early (after the hook) and revisited at the takeaway.
</concept-explainer>

<how-to-process path="structures/how-to-process/overview.md">
**How-To / Process** — "here is how to do X" or "here is how X works," as an ordered sequence of steps / stages. Best for: tutorials, workflows, recipes, pipelines, mechanisms with a clear start→finish. The core is a **3–6 step sequence on a consistent visual stage**, each step advancing one move. When a shared motif (the object being acted on, the position marker, the running tally) carries across several adjacent steps as one continuous shot, group those steps as a `continue` run (one worker, up to 3 scenes) and hint `morph`.
</how-to-process>

<listicle path="structures/listicle/overview.md">
**Listicle** — "N things about X" — a hook, then N roughly co-equal items, then a wrap. Best for: tips, mistakes, features-of-a-field, reasons, comparisons where items are parallel rather than sequential. Items are usually `cut`/`slide` between (parallel, not continuous); use `morph` only when a genuine throughline element survives from one item to the next. Rule-of-three is the strongest item count when the source allows compression.
</listicle>

<story-explainer path="structures/story-explainer/overview.md">
**Story Explainer** — teach through narrative: a setup, a tension or turn, a resolution, and the lesson it carries. Best for: case studies, histories, "how this came to be," cautionary tales, anything where a concrete arc makes an abstract point land. The emotional arc has real shape (calm -> tension -> turn -> relief/insight); the takeaway generalizes the story into a transferable idea.
</structures>

### Choosing the structure

Read the input text once, then ask:

- **Is the payload one idea to be understood?** → concept-explainer.
- **Is the payload an ordered procedure or mechanism with steps?** → how-to-process.
- **Is the payload a set of parallel, co-equal items?** → listicle.
- **Is the payload best carried by a concrete narrative / case / history?** → story-explainer.

When the text genuinely mixes modes, name a compound (below) rather than splicing. Default tie-breakers: if the text is an argument about one concept that happens to list supporting reasons, prefer concept-explainer with a listicle inner rhythm over a bare listicle. If a process is wrapped in a story (someone learns the steps the hard way), prefer story-explainer with a how-to inner rhythm.

### Compound structures

Real explainers often _layer_ structures. Pattern:

- **Outer structure** = macro arc the viewer rides (concept / process / list / story).
- **Inner rhythm** = the tactical rhythm inside the body phase. Common inner rhythms: a **process** rhythm (ordered steps) nested inside a concept-explainer's mechanism phase; a **listicle** rhythm (parallel items) inside a concept-explainer's "why it matters" phase.

Write `narrativeArchetype` as `"<outer> with <inner>"`, e.g. `"concept-explainer with process"` or `"story-explainer with how-to"`. The downstream visual phase reads it for pacing; a process / step inner rhythm means tighter `morph` / `slide` seams on a consistent stage and shorter scenes.

> The field name is `narrativeArchetype` (schema-fixed). For FE it names the chosen explainer **structure**, not a sales archetype.

## Narrative Architecture

Define each scene's role in the explanation. Every scene has five narrative fields (type, narrativeRole, keyMessage, persuasion, emotionalBeat), plus a separate transition spec:

- **Type** — one of the enum values `hook` / `pain_point` / `product_intro` / `feature_showcase` / `benefit_highlight` / `social_proof` / `branding` / `cta`. The enum is schema-fixed (validate-narrator.mjs enforces it), so FE **repurposes** these labels for teaching rather than selling. Use the mapping table below; pick the value whose downstream pacing matches the scene's job.
- **Narrative Role** — what this scene does in the explanation (its _job_, e.g. "Concretizes compound interest as a snowball rolling downhill", not "Shows a chart").
- **Key Message** — the one thing the viewer should walk away understanding (one sentence).
- **Persuasion** — a _named_ rhetorical / clarity technique (see catalog below). "Explain the idea" / "show benefits" is a failure mode; the standard is "Analogy: tax brackets as a staircase, not a cliff" / "Progressive disclosure: reveal the formula one term at a time" / "Worked example with concrete round numbers."
- **Emotional Beat** — target feeling (see vocabulary below). One word or a short compound phrase (e.g. "Curiosity and clarity"). Avoid generic "positive" / "interested".
- **Transition** — `{ continuity, intent, description, sharedMotif? }`, defining how this scene arrives from the **previous** scene. Every scene must have one, including scene 1 (use `continuity: "break"` + `intent: "cut"`). This is a **narrative-layer judgment** (whether the seam is continuous and what kind of connection it is), not visual implementation detail (specific ease / blur / direction is translated downstream by visual-design according to preset/palette). See Transition taxonomy below.

### Type-enum repurposing (schema-fixed enum → explainer roles)

The enum values cannot change (validate-narrator.mjs enforces them; at least one scene must be `feature_showcase` or `product_intro`). Map your explainer roles onto them as follows:

| Explainer role you want          | Use enum `type`     | Why this value                                                                                         |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| Hook / curiosity gap             | `hook`              | Same job: the high-leverage opening 3–5s.                                                              |
| Pain / problem / why-care        | `pain_point`        | The friction or gap the explanation resolves ("you've probably wondered…", "this keeps going wrong").  |
| Name the core concept            | `product_intro`     | The "introduce the protagonist" beat — here the protagonist is the **idea** being named/defined.       |
| Mechanism / step / stage         | `feature_showcase`  | A unit of the explanation's body — one move of a process, one mechanism, one list item.                |
| Implication / payoff / "so what" | `benefit_highlight` | The consequence or value of understanding — what it gets you, what now becomes possible.               |
| Evidence / example / data point  | `social_proof`      | A concrete grounding: a real number, a worked example, a citation, a comparison that proves the point. |
| Thesis / takeaway / principle    | `branding`          | The _philosophical_ landing beat — the generalizable idea, the rule, the one line to remember.         |
| Call to think / try / act        | `cta`               | The closing ask — try it, watch for it, question it, do the thing.                                     |

Use this mapping consistently. The explainer body is usually a run of `feature_showcase` (steps/mechanisms/items) optionally interleaved with `benefit_highlight` (implications) and `social_proof` (examples/data). At least one `feature_showcase` or `product_intro` must exist (every explainer has a body and a named idea, so this is automatic).

### Hook Strategy Taxonomy

Choose one. The hook is the highest-leverage 3–5 seconds. For explainers it opens a cognitive gap or stakes:

| Strategy                            | When to use it                                                 | Example                                                                 |
| ----------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Shocking statistic**              | You have a credible data point that quantifies the stakes      | "90% of plastic ever made has never been recycled."                     |
| **Rhetorical question**             | Create an immediate cognitive gap                              | "Why does time seem to speed up as you get older?"                      |
| **Counterintuitive claim**          | The truth contradicts common belief                            | "Adding more lanes to a highway makes traffic worse."                   |
| **Pain validation**                 | The audience already feels the confusion; say it back to them  | "Everyone tells you to 'just diversify' — nobody says what that means." |
| **Visceral metaphor**               | The idea is abstract and needs to become concrete / embodied   | "Your attention is a spotlight, and apps are fighting over the switch." |
| **Concept announcement**            | The term itself is the subject; make it memorable              | "There's a word for this: the bystander effect."                        |
| **Direct address / character hail** | Audience is clearly defined                                    | "If you've ever rage-quit a recipe halfway through — this is for you."  |
| **Imagine / scenario**              | A new perspective or thought experiment frames the whole piece | "Imagine money that loses value if you don't spend it."                 |
| **Stakes / consequence**            | The "why care now" is a real cost or risk                      | "Get this one step wrong and the whole batch is ruined."                |

### Rhetorical / Clarity Technique Catalog

Each scene's `persuasion` field is a _named technique_, not a vague intent. For explainers, the field carries **how this scene makes the idea land or clear** — a clarity / rhetoric mechanism, not a sales mechanism. Choose from this catalog (combine when several are active, e.g. "Analogy + progressive disclosure"):

| Family               | Techniques                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Make-concrete**    | Analogy / metaphor • Concretization (abstract → tangible object) • Worked example with real numbers • Anchoring on a familiar referent       |
| **Reveal-in-order**  | Progressive disclosure (one term/layer at a time) • Build-up (simple case → general case) • Signposting ("first… then… finally")             |
| **Contrast**         | Before/after contrast • Common-belief vs reality • Comparison of two options • Counterexample (here is when it breaks)                       |
| **Structure**        | Rule of three (triplet) • Numbered enumeration • Question→answer pairing • Frame-then-fill (state the shape, then populate it)               |
| **Evidence**         | Statistical proof / hard metric • Citation / source attribution • Demonstration (show the mechanism running) • Causal chain (A → B → C)      |
| **Memory & landing** | Callback (return to the hook's image) • Distillation (compress to one line) • Mnemonic / coined term • Generalization (specific → principle) |

When a scene's technique is not in the catalog, you may name a new one inline, but you must explain its _mechanism_ (e.g. "Subtractive framing: define the concept by what it is _not_ before saying what it is"). Do not write generic "explain the idea" / "show benefits."

### Emotional Beat Vocabulary

`emotionalBeat` should be one word or a short compound phrase (e.g. "Curiosity and clarity", "Tension and recognition"). Avoid generic "positive" / "happy" / "interested." Explainers ride a comprehension arc:

**Negative valley** — _open the gap_ (hook / pain_point scenes): curiosity • puzzlement • surprise • tension • concern • skepticism • recognition • intrigue

**Pivot** — _orient_ (product_intro / concept-naming scenes): clarity • orientation • anticipation • focus

**Build** — _build understanding_ (feature_showcase / benefit_highlight / social_proof scenes): comprehension • "aha" • confidence • fascination • foresight • momentum • conviction • delight • unease (for a caveat) • mastery

**Resolution** — _land_ (branding / cta / final beats): clarity • satisfaction • resolve • inspiration • inevitability • "now I get it"

> The structure pages (`structures/*/overview.md`) refer to these four groups by their register names — **Negative valley**, **Pivot**, **Build**, **Resolution** — so a beat-trajectory link from a structure page resolves to the matching group above.

Scenes with compound beats are often strongest, e.g. "Surprise _and_ recognition", "Comprehension _and_ delight". When two feelings are active, write both.

### Transition Taxonomy

Every scene's `transition` describes **how it arrives from the previous scene**, using two machine fields + prose + (for morph) a shared element name:

#### `continuity` — `"break"` | `"continue"` (**drives worker grouping**)

The only machine consequence of `continuity` is grouping: `prep.mjs` puts adjacent `continue` scenes into the **same scene worker** (cap=3 — a `continue` run is up to 3 scenes). The one worker that owns a run controls every DOM in it, so it authors the visual continuity across all its scenes itself and the seams read as one continuous shot.

- **`continue` = "same worker as the previous scene."** Use it for a run of 2-3 adjacent scenes that should flow as one continuous shot — a growing diagram, a persistent object, a camera that keeps moving, a counter that advances. The worker authors the flow (and any shared-element morph) directly inside one continuous visual stage.
- **`break` = a new worker** + an inter-scene Tier-B transition (`cut` / `slide` / `dissolve` / `zoom`) injected by the harness onto the clip wrappers after assembly.
- **Scene 1 is always `break`** (there is no previous scene to continue from).

> `continuity` is **decoupled from `intent`** (the old morph⟺continue biconditional was removed). `continue` no longer requires `morph`; it just means "keep these scenes on one worker for continuity." A `continue` **run is at most 3 scenes** (cap=3): `break → continue → continue` groups three scenes in one worker; a 4th consecutive scene must start a new run with a `break`. Use `continue` only where the scenes genuinely share a continuous stage — a seam that merely "feels continuous" should stay `break`. Many short runs are welcome: `run(1,2,3) → break → run(4,5) → break → 6 → 7`.

#### `intent` — 5 narrative seam intentions (**not** visual implementation)

Choose one of these 5. This is "narrative-level" vocabulary — it expresses what kind of connection the seam is, **not** blur amount / direction / duration (visual-design translates those according to preset/palette):

| Intent     | Narrative meaning                                                                                                                                                        | Pairs with (soft hint) | Downstream translation direction (visual-design decides values)                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------- |
| `morph`    | **One shared element transforms across scenes** (the shared element is open-ended: a diagram node that becomes a chart bar, a word that becomes an icon — only examples) | `continue`             | worker carries a shared element across the continue run (it owns the shared visual stage) |
| `cut`      | Clean switch; scenes are not continuous (topic/tone shift, new list item, high-energy beat)                                                                              | **`break`**            | hard cut / crossfade                                                                      |
| `slide`    | Directional slide / push (matches narrative flow: next step, next point)                                                                                                 | **`break`**            | push-slide (direction set by visual-design)                                               |
| `dissolve` | Soft dissolve / focus shift (enter atmosphere, emotional transition, time passing)                                                                                       | **`break`**            | crossfade / blur-crossfade (when colors clash)                                            |
| `zoom`     | Camera pushes / scales through to the next focal point (zoom into a detail, pull back to the big picture)                                                                | **`break`**            | zoom-through                                                                              |

`continuity` is **decoupled from `intent`** — `intent` is a soft hint. `morph` naturally pairs with `continue` (same worker carries the element); `cut` / `slide` / `dissolve` / `zoom` naturally pair with `break`. Nothing enforces this; choose `continuity` by whether the scenes share a continuous stage.

#### `sharedMotif` — optional hint (names the carried element)

Name the **element / motif that carries through this seam** (what morphs at the narrative layer), ≤8 words. Examples: `"the running tally"` / `"the central diagram node"` / `"the timeline marker"` / `"the key term"`. **Only name what it is; do not describe geometry/implementation** — the downstream worker uses this as the persistent subject inside the continue run. Omit this field when `intent` is not morph.

**What makes a good shared element (pass these three tests before choosing `morph`)**: do not invent a shared element just to have one; identify which element that already belongs in both scenes can connect them best.

- **Load-bearing in both scenes:** it is the visual protagonist or key information carrier in both outgoing and incoming scenes (the object the process acts on, the central diagram, the data series, the named concept's icon), **not** a decorative object inserted temporarily just to enable a morph.
- **Naturally co-present:** first ask "Is there an element that would naturally appear in both scenes?" If yes, use morph to connect it; if no, use Tier-B.
- **The transformation advances the explanation:** the element's morph must **carry** the conceptual jump (the same diagram gains a layer, the same number flows from formula into result, the same shape reorganizes from problem to solution), rather than making the explanation pause for a flashy animation.

Hint `morph` (with `continue`) when all three are true; otherwise the scenes don't share a continuous stage — use `break` + a Tier-B seam (`dissolve` / `slide`), which still reads clean.

#### `description` — 10–30 word visual direction (keep)

Concrete direction for downstream: what morphs/slides/dissolves, where the eye lands, and what color/shape guides it. For `morph`, be especially clear about the handoff point (what shape is handed to the next scene).

> **Why 5 intentions, not visual types:** the model lets scriptwriting express only **narrative intent + continuity**, leaving "which exact transition + blur/direction/duration" to visual-design, which has preset/palette context. `morph` covers shared-element continuity inside a continue run; the rest are Tier-B between-scene transitions per the table.

### Script Voice Quality Bar

Strong explainer scripts have these traits. The failure mode is reading the article aloud, or bullet-point prose.

**Strong:** _Concretization_: "Compound interest isn't addition, it's a snowball — every turn picks up the snow from the last turn, then more." — turns an abstract formula into a moving image.

**Weak:** _Article-paraphrase in order_: "The study, published in 2019, examined three cohorts and found that…" — that is reading, not explaining. Compress to the one fact that matters and lead with it.

### Empty / Silent Scripts Are Allowed

When the visual itself carries the information, set `script: ""` and keep the scene silent. This is common and good in explainers:

- A diagram assembling itself (each part appearing on beat) — the build _is_ the message; let it breathe.
- A worked-example animation (numbers flowing through a formula) — the motion teaches; narration would only narrate the obvious.
- A beat of held tension before the turn in a story-explainer — silence is the device.

If you set an empty script, `narrativeIntent` must be especially strong, because `narrativeRole` and `persuasion` must carry what the script does not say.

## The Explainer Body Is a Sequence, Not a Single Scene

An explainer's core is almost always **3–6 body scenes on a consistent visual stage**, each advancing one mechanism / step / item / layer, building understanding cumulatively (for connection rules, see the hard constraint below). The body runs `feature_showcase` / `benefit_highlight` / `product_intro` — these may interleave per the structure (a concept- or story-explainer typically goes `product_intro → feature_showcase → benefit_highlight` rather than 3 consecutive of one type); the only floor is the schema's `≥1 feature_showcase` or `product_intro`. Patterns by structure:

- **concept-explainer:** name the concept → reveal mechanism layer by layer → land implications. The body is `product_intro` then a run of `feature_showcase` (sometimes interleaved with `benefit_highlight` for "so what" beats and `social_proof` for a grounding example).
- **how-to-process:** `feature_showcase` per step, ordered, on one stage. The object being acted on is often a genuine shared motif → pair adjacent steps with `morph` where the throughline carries.
- **listicle:** `feature_showcase` per item; items are usually parallel, so default to `cut` / `slide` between them. Use `morph` only when a real element survives item→item.
- **story-explainer:** scenes follow the narrative beats (setup / tension / turn / resolution / lesson); types map per the table (`pain_point` for tension, `branding` for the lesson).

A single isolated body scene rarely teaches anything. Group adjacent scenes that share a continuous stage into a `continue` run (`continuity: "continue"`) — up to 3 scenes per run, all owned by one worker that authors the flow (and any shared-element morph) directly; **between runs, use a `break`** with a Tier-B transition (`cut` / `slide` / `dissolve` / `zoom`). A run is at most 3 scenes; a 4th consecutive scene starts a new run with a `break`. Shape: `run(s1,s2,s3) -> break -> run(s4,s5) -> break -> ...`. Use `continue` only where the scenes genuinely share a continuous stage; a parallel listicle may legitimately use `break` throughout.

Identify a body sequence by:

- Scene type is `feature_showcase`, `product_intro`, or `benefit_highlight`
- `narrativeRole` contains words such as "Defines", "Demonstrates", "Reveals", "Walks through", "Concretizes", "Builds on"
- `script` advances one mechanism / step / item / layer per scene, cumulatively
- Adjacent scenes that share a continuous stage are grouped as a `continue` run (up to 3); between runs (and across parallel items) is a `break` + Tier-B (`cut` / `slide` / `dissolve` / `zoom`)

## Faceless Visuals — assetCandidates is `[]` by Default

FE is a **faceless** explainer: there are no captured assets, no product screenshots, no asset inventory. Downstream (visual-design + scene workers) invents the visuals — typography, abstract graphics, diagrams, and data-viz — from each scene's `narrativeRole` / `keyMessage` / `script`. Both typographic/abstract treatments and diagram/data-viz treatments are first-class; downstream picks per scene by content. Your job here is the **narrative**, not the visual asset list.

Therefore:

- **`assetCandidates` is `[]` for every scene by default.** This is the normal, correct value — it tells downstream "this scene is invented from the brief."
- **The only exception:** the user explicitly provided a real image and placed it in `public/`. Then add one entry `{ "path": "public/<basename>", "description": "<≤25 words: what it is + visual notes>" }`. Do not invent paths, do not reference `capture/`, do not fabricate basenames — a path to a nonexistent file is a downstream fatal.
- Do **not** describe the intended diagram/typography here as if it were an asset. Visual intent belongs in `narrativeRole` + the transition `description`; the visual phase reads those.

## Validation Checklist

- Does every scene have complete Narrative Intent (all 5 fields)?
- Does every scene have `transition` — `continuity` (break/continue), `intent` (one of the 5, a soft hint), and `description` (10–30 words)? Is scene 1 `continuity: break`? Is every `continue` run at most 3 scenes?
- Is `assetCandidates` present on every scene as an array? Is it `[]` everywhere except where the user supplied a real `public/<basename>`?
- Does the emotional arc have meaningful variation (not monotone)? Does it match the structure (concept = gap → comprehension; story = calm → tension → insight)?
- Is the sequence driven by narrative, not by the input text's paragraph order?
- Is there a coherent body that builds cumulatively (a run of `feature_showcase` / `benefit_highlight` / `product_intro`, interleaving allowed per structure) — not a single isolated body scene? Are `continue` runs used only where scenes share a continuous stage, each run ≤3 scenes, separated by a `break`?
- Are Persuasion fields named rhetorical/clarity techniques from the catalog rather than vague "explain the idea"?
- Are Emotional beats specific (word or short compound phrase), not generic "positive"?
- Does the hook use a named strategy from the taxonomy?
- Is there only one outer structure (no splicing top-level frameworks)? Explicitly named inner-rhythm compounds are allowed.
- Is the type-enum used per the repurposing table (so the file stays schema-valid, with at least one `feature_showcase`/`product_intro`)?
- Is a top-level `stylePreset` set to one of the 5 shipped presets (`pin-and-paper` | `block-frame` | `capsule` | `scatterbrain` | `claude`)?

## `narrator_scripts.json`: Canonical Schema

Downstream agents expect these **exact** field names. Wrong names (e.g. `scene_id` instead of `sceneNumber`, `narration` instead of `script`, or flattened intent fields) are fatal in `validate-narrator.mjs`.

```json
{
  "project": "Project name",
  "narrativeArchetype": "Explainer structure (concept-explainer | how-to-process | listicle | story-explainer), or compound \"<outer> with <inner>\"",
  "stylePreset": "One of: pin-and-paper | block-frame | capsule | scatterbrain | claude — drives the entire visual system (default pin-and-paper)",
  "orientation": "Canvas aspect, echoed verbatim from the dispatch Orientation line: landscape (16:9, default) | portrait (9:16) | square (1:1). Dictated by the user's aspect, not chosen. prep maps it to group_spec.width/height. Omit → landscape.",
  "emotionalArc": "Comprehension journey description (e.g. 'Puzzlement at why time speeds up shifting to clarity and a small delight as memory density explains it.')",
  "scenes": [
    {
      "sceneNumber": 1,
      "sceneName": "Scene name",
      "transition": {
        "continuity": "break|continue",
        "intent": "morph|cut|slide|dissolve|zoom",
        "sharedMotif": "Only when intent=morph: name of the element carried across scenes (<=8 words, e.g. 'the running tally'); omit this key for other intents",
        "description": "10-30 word concrete visual direction explaining what morphs/slides/dissolves and where the eye should land"
      },
      "narrativeIntent": {
        "type": "hook|pain_point|product_intro|feature_showcase|benefit_highlight|social_proof|branding|cta",
        "narrativeRole": "The scene's job in the explanation (not what appears on screen)",
        "keyMessage": "What the viewer should understand after this scene (one sentence)",
        "persuasion": "Named rhetorical/clarity technique from the catalog (combine if multiple are active)",
        "emotionalBeat": "Word or short compound phrase from the vocabulary"
      },
      "assetCandidates": [],
      "script": "Plain-text narration. May include <em>/<brand>/<emph>/<cta> tags as authoring-time annotations (TTS strips them). Can be an empty string when visuals carry the information.",
      "estimatedDuration": "5-6s"
    }
  ]
}
```

Field rules (use exact field names above; wrong names are fatal in `validate-narrator.mjs`):

- Every scene must have a `transition` field (`continuity` + `intent` + `description`; add `sharedMotif` for morph), including scene 1 (`continuity: "break"` + `intent: "cut"`). **Scene 1 has no previous scene, so its `transition` does not generate any transition downstream (downstream ignores it) — `intent: "cut"` is just a placeholder.**
- `continuity` is **decoupled from `intent`** (a soft hint). `continue` = same worker (a run of up to 3 scenes); `break` = new worker. `validate-narrator.mjs` checks only enum membership + scene 1 = `break`.
- `assetCandidates` is a **required** field and must be an array. For FE it is `[]` on essentially every scene; only a user-provided `public/<basename>` image yields a `{path, description}` entry.
- `narrativeArchetype` names one of the four explainer structures (or a `"<outer> with <inner>"` compound). At least one scene must be `type: feature_showcase` or `product_intro`.

### Captions (not owned by scriptwriting)

Do not write a `captions: string[]` field. `<em>/<brand>/<emph>/<cta>` tags inside `script` are stripped by TTS; whether you include them does not drive downstream visuals.
