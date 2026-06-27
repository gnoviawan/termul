# Story-Design (PR → narrative)

## Core Principles

- Scene sequence comes from narrative design, not from the diff's file order or the commit list order.
- A PR's files may be touched in any order; a video runs `hook → the change → why it matters → ship`, or `bug → root cause → fix → result`, or `what's new (×N) → wrap`, depending on the archetype.
- Reorder, merge, omit, compress. Surface the one change that matters; drop the incidental churn (lockfile bumps, formatting, test scaffolding) unless it _is_ the story.
- The PR is the source of **information**, not a story template. The single most common failure is narrating the diff file-by-file or reading the PR description aloud — do not do that. **Explain the change.**

The planning standard: **write the emotional beat alongside the structural type**, **name the specific rhetorical / clarity technique** (not merely "explain the change"), and **specify a transition for every seam**.

## Use `site_dna` to Set the Register (optional, read once at the start)

`design-system/inference.json` `site_dna` is the deterministic Phase 1 register summary. If present, read **only the `site_dna` section** once and tune narration to the same channel as the final visuals (**do not read** `design.html` / `chunks/` — parallel design-system outputs; reading them breaks Phase 1b∥2 parallelism). If `inference.json` is missing, proceed without it.

The shipped style is **claude** (warm editorial, considered, a serif that thinks, scarce coral, a navy code window). Absent any other signal, default narration to a **plain, technical, unhurried developer voice** — accurate, specific, no hype, no marketing gloss. You are talking to engineers about a real change; respect their time and their intelligence.

| `site_dna` field                               | How to use it                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `voice_tone` (warm / neutral / formal)         | `warm` allows a wry aside; `neutral` is sharp-but-plain; `formal` stays restrained. Default to neutral-technical. |
| `voice_heading_style` / `voice_heading_length` | `tight` → short claims / single-line statements; `loose` → a setup line then the point.                           |

`site_dna` is a **soft input**: it tunes voice. The archetype and scene segmentation are driven by the PR + the decision below.

## PR Archetypes

Before segmenting scenes, choose **one** archetype (or explicitly name a compound). Each is a complete, coherent path through understanding a change — do not splice phases from different archetypes.

<archetypes>
<changelog>
**Changelog** — "here's what shipped." A hook naming the headline, then **2-4 roughly co-equal change items**, then a wrap / ship line. Best for: release PRs, multi-change PRs, "what's new in vN." Items are usually parallel → default to `cut` / `slide` between them; use `morph` only when a real throughline survives item→item. Rule-of-three is the strongest item count when the changes compress. Type spine: `hook` → run of `feature_showcase` (one per change) → `cta`/`branding`.
</changelog>

<feature-reveal>
**Feature-Reveal** — "we built X; here's what it does." Hook (the new capability) → name the feature (`product_intro`) → show it working: the new code typing on, or the new behavior (`feature_showcase`) → impact / why (`benefit_highlight`) → close. Best for: a PR that adds **one notable feature**. The new code is the centerpiece; the feature is a single protagonist. The code-window often persists across 2-3 scenes as it fills in → a `continue` run with `morph` on the code-window.
</feature-reveal>

<fix-explainer>
**Fix-Explainer** — "this was broken; here's the fix." Setup the symptom / bug / pain (`pain_point`) → the root cause (`feature_showcase` or `product_intro`) → the fix, as a before→after diff (`feature_showcase`) → the result, now it works (`benefit_highlight`). Best for: bugfix PRs. The diff **is the turn**; the before→after contrast is the strongest beat. Emotional arc has real shape (tension → turn → relief). Pairs naturally with `dissolve` into the cause and a hard `cut` / before-after `morph` on the fix.
</fix-explainer>

<refactor-walkthrough>
**Refactor-Walkthrough** — "same behavior, better shape." Hook (the smell / the why) → the old shape → the new shape → the payoff (cleaner / faster / safer, with numbers). Best for: refactors, perf work, cleanups, migrations. Heavy on before→after **structural** comparison (file-tree, call-graph, the diff) and **numbers** (lines removed, perf delta, files touched) to land the payoff. The old→new structure is a genuine shared element → a `continue` run with `morph` works well.
</refactor-walkthrough>
</archetypes>

### Choosing the archetype

Read the PR once, then ask:

- **Is it one notable new capability?** → feature-reveal.
- **Is it a bug fix?** → fix-explainer.
- **Is it a behavior-preserving cleanup / perf / migration?** → refactor-walkthrough.
- **Is it many co-equal changes / a release?** → changelog.

Tie-breakers: a feature PR that also fixes a bug → feature-reveal with the fix as one body beat. A fix that required a small refactor → fix-explainer (the fix is the headline). A big PR that's really "one feature + three supporting changes" → `"feature-reveal with changelog"`.

### Compound archetypes

Write `narrativeArchetype` as `"<outer> with <inner>"`, e.g. `"feature-reveal with changelog"` or `"fix-explainer with refactor-walkthrough"`. Outer = the macro arc the viewer rides; inner = the tactical rhythm inside the body. The downstream visual phase reads it for pacing.

> The field name is `narrativeArchetype` (schema-fixed). For pr-to-video it names the chosen PR archetype. The validator does **not** constrain its value — any string passes — but pick from the four (or a compound) so the visual phase reads a known shape.

## Narrative Architecture

Every scene has five narrative fields (type, narrativeRole, keyMessage, persuasion, emotionalBeat), plus a separate transition spec:

- **Type** — one of the enum values `hook / pain_point / product_intro / feature_showcase / benefit_highlight / social_proof / branding / cta`. The enum is schema-fixed (`validate-narrator.mjs` enforces it), so pr-to-video **repurposes** these labels for code changes. Use the mapping table below.
- **Narrative Role** — what this scene does in the explanation (its _job_, e.g. "Shows the request now retries on 5xx with backoff", not "Shows code").
- **Key Message** — the one thing the viewer should walk away understanding (one sentence).
- **Persuasion** — a _named_ rhetorical / clarity technique (catalog below). "Explain the change" is a failure mode; the standard is "Before/after contrast: the throw becomes a retry loop" / "Worked example: one failing request, now recovered."
- **Emotional Beat** — target feeling (vocabulary below). One word or a short compound phrase. Avoid generic "positive" / "interested".
- **Transition** — `{ continuity, intent, description, sharedMotif? }`, how this scene arrives from the **previous** scene. Every scene must have one, including scene 1 (`continuity: "break"` + `intent: "cut"`).

### Type-enum repurposing (schema-fixed enum → PR roles)

The enum values cannot change (`validate-narrator.mjs` enforces them; at least one scene must be `feature_showcase` or `product_intro`). Map your PR roles onto them as follows:

| PR role you want                                   | Use enum `type`     | Why this value                                                                   |
| -------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Hook / what shipped                                | `hook`              | The high-leverage opening 3–5s.                                                  |
| Problem / bug / smell / why-care                   | `pain_point`        | The friction the PR resolves ("every deploy, the same flaky timeout").           |
| Name the change / the feature / the PR itself      | `product_intro`     | The "introduce the protagonist" beat — here the protagonist is the **change**.   |
| The diff / a shipped item / the mechanism          | `feature_showcase`  | A unit of the change's body — one before→after, one new function, one list item. |
| Impact / payoff / what it unlocks                  | `benefit_highlight` | The consequence of the change — what now works, what's now possible.             |
| Evidence / metric / +N −M stats / benchmark / test | `social_proof`      | Concrete grounding: a real number, a passing test, a perf delta.                 |
| Thesis / principle / takeaway                      | `branding`          | The landing line — the rule, the one thing to remember.                          |
| Try it / upgrade / ship line                       | `cta`               | The closing ask — pull it, upgrade, read the PR.                                 |

The body of a PR video is usually a run of `feature_showcase` (the changes/diffs) optionally interleaved with `benefit_highlight` (impact) and `social_proof` (stats/tests). At least one `feature_showcase` or `product_intro` must exist (every PR has a change and a named thing, so this is automatic).

### Hook Strategy Taxonomy

Choose one. The hook is the highest-leverage 3–5 seconds:

| Strategy                   | When to use it                      | Example                                                    |
| -------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| **Shocking statistic**     | A change quantifies the stakes      | "This PR deletes 1,200 lines." / "40% faster cold starts." |
| **Counterintuitive claim** | The change contradicts intuition    | "We made the client slower — and that fixed it."           |
| **Pain validation**        | The audience already feels the bug  | "Every deploy, the same flaky timeout."                    |
| **Concept announcement**   | The change has a name worth landing | "Meet retry-with-backoff."                                 |
| **Before/after teaser**    | The diff is the whole story         | "One line threw. Now it recovers."                         |
| **Stakes / consequence**   | The "why care now" is a real cost   | "This crash hit every user on a flaky network."            |
| **Direct address**         | The audience is clearly defined     | "If you've ever waited on a 5-minute CI run…"              |

### Rhetorical / Clarity Technique Catalog

Each scene's `persuasion` is a _named technique_, not a vague intent. Choose from this catalog (combine when several are active):

| Family               | Techniques                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Make-concrete**    | Worked example (one real request / one real input) • Analogy (backoff as "knock, wait longer, knock again") • Concretization (abstract change → one tangible code line) |
| **Reveal-in-order**  | Progressive disclosure (the diff one line at a time) • Build-up (the simple call, then the edge case) • Signposting ("before… after…")                                  |
| **Contrast**         | Before/after diff • Old shape vs new shape • The bug vs the fix • Two approaches compared                                                                               |
| **Structure**        | Rule of three (three changes) • Numbered enumeration • Question→answer • Frame-then-fill (state the shape, then the code)                                               |
| **Evidence**         | +N/−M stat • Passing test / green check • Benchmark / perf delta • Causal chain (request → 5xx → retry → success)                                                       |
| **Memory & landing** | Callback (return to the hook's bug) • Distillation (the change in one line) • Generalization (this fix → the principle)                                                 |

Do not write generic "explain the change" / "show the code." Name the mechanism.

### Emotional Beat Vocabulary

`emotionalBeat` is one word or a short compound phrase (e.g. "Recognition and relief", "Curiosity and clarity"). Avoid generic "positive" / "happy". A PR video rides a comprehension arc:

**Negative valley** — _open the gap_ (hook / pain_point): curiosity • frustration • recognition • concern • skepticism • "ugh, that bug"

**Pivot** — _orient_ (product_intro / naming the change): clarity • orientation • anticipation • focus

**Build** — _build understanding_ (feature_showcase / benefit_highlight / social_proof): comprehension • "aha" • confidence • satisfaction • momentum • conviction • relief (for a fix)

**Resolution** — _land_ (branding / cta): satisfaction • resolve • confidence • "ship it" • inevitability

Compound beats are often strongest, e.g. "Recognition _and_ relief" (a fix), "Curiosity _and_ confidence" (a feature).

### Transition Taxonomy

Every scene's `transition` describes **how it arrives from the previous scene**, using two machine fields + prose + (for morph) a shared element name:

#### `continuity` — `"break"` | `"continue"` (**drives worker grouping**)

The only machine consequence of `continuity` is grouping: `prep.mjs` puts adjacent `continue` scenes into the **same scene worker** (cap=3 — a `continue` run is up to 3 scenes). The one worker that owns a run authors the visual continuity across all its scenes itself, so the seams read as one continuous shot.

- **`continue` = "same worker as the previous scene."** Use it for a run of 2-3 adjacent scenes that flow as one continuous shot — a code-window that fills in line by line, a before→after that morphs in place, a counter that advances, a file-tree that grows. The worker authors the flow (and any shared-element morph) inside one continuous stage.
- **`break` = a new worker** + an inter-scene Tier-B transition (`cut` / `slide` / `dissolve` / `zoom`) injected by the harness onto the clip wrappers after assembly.
- **Scene 1 is always `break`** (there is no previous scene).

> A `continue` **run is at most 3 scenes** (cap=3). Many short runs are welcome: `run(1,2,3) → break → run(4,5) → break → 6`. Use `continue` only where the scenes genuinely share a continuous stage; a parallel changelog may legitimately use `break` throughout.

#### `intent` — 5 narrative seam intentions (**not** visual implementation)

Choose one of these 5. This is "narrative-level" vocabulary — what kind of connection the seam is, **not** blur/direction/duration (visual-design translates those):

| Intent     | Narrative meaning                                                                                                                                 | Pairs with (soft hint) |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `morph`    | **One shared element transforms across scenes** (the code-window gains lines; the old function becomes the new one; the failing test turns green) | `continue`             |
| `cut`      | Clean switch; scenes not continuous (new change item, topic shift, high-energy beat)                                                              | `break`                |
| `slide`    | Directional push (next change, next step)                                                                                                         | `break`                |
| `dissolve` | Soft dissolve / focus shift (into the cause, a quieter beat, time passing)                                                                        | `break`                |
| `zoom`     | Camera pushes / pulls through to the next focal point (zoom into a code line, pull back to the file tree)                                         | `break`                |

`continuity` is **decoupled from `intent`** (a soft hint). `morph` naturally pairs with `continue`; the rest pair with `break`. Nothing enforces this; choose `continuity` by whether the scenes share a continuous stage.

#### `sharedMotif` — optional hint (names the carried element)

Name the **element that carries through the seam**, ≤8 words. PR examples: `"the request flow"` / `"the failing test"` / `"the code window"` / `"the line count"` / `"the old vs new function"`. **Only name what it is; do not describe geometry** — the downstream worker uses this as the persistent subject inside the continue run. Omit when `intent` is not morph.

**Three tests before choosing `morph`** (don't invent a shared element just to have one):

- **Load-bearing in both scenes:** it is the visual protagonist in both outgoing and incoming scenes (the code-window, the diff, the data series), not a decoration.
- **Naturally co-present:** an element that would appear in both scenes anyway.
- **The transformation advances the explanation:** the morph _carries_ the conceptual jump (the same code gains the retry block; the same test flips red→green), rather than being a flashy pause.

#### `description` — 10–30 word visual direction (keep)

Concrete direction for downstream: **which file/hunk to show**, what morphs/slides, where the eye lands. For a code beat, name the snippet ("the `request()` retry block, ~6 lines"). For morph, be clear about the handoff (what shape is handed to the next scene).

## The PR Body Is a Sequence, Not a Single Scene

A PR video's core is almost always **2–5 body scenes**, each advancing one change / one before→after / one item, building understanding cumulatively. The body runs `feature_showcase` / `benefit_highlight` / `product_intro` (interleaved per archetype; the only floor is the schema's `≥1 feature_showcase` or `product_intro`):

- **changelog:** `feature_showcase` per change item; usually parallel → default `cut` / `slide`.
- **feature-reveal:** `product_intro` (name it) then `feature_showcase` (the code working), often a `continue` run morphing the code-window, then `benefit_highlight`.
- **fix-explainer:** `pain_point` (symptom) → `feature_showcase` (cause + fix diff, often a `continue` morph red→green) → `benefit_highlight` (result).
- **refactor-walkthrough:** before→after structure across a `continue` run, then a `social_proof` numbers beat.

Group adjacent scenes that share a continuous stage into a `continue` run (≤3 scenes, one worker); **between runs use a `break`** + Tier-B transition. Shape: `run(s1,s2,s3) → break → run(s4,s5) → break → …`.

## Faceless Visuals — assetCandidates is `[]` by Default

- **`assetCandidates` is `[]` for every scene by default.** It tells downstream "this scene is invented from the brief + diff."
- **Exception 1 — a user-provided image:** the user explicitly placed a real image in `public/` (e.g. an architecture diagram). Then add `{ "path": "public/<basename>", "description": "<≤25 words>" }`. Do not invent paths; do not reference `capture/`.
- **Exception 2 — the credits / shipped-by close (contributor avatars):** see below.
- Visual intent (which hunk, before/after, file-tree) belongs in `narrativeRole` + the transition `description`; the visual phase reads those.

### Optional close: a credits / shipped-by scene (the one relaxation of faceless)

A PR is shipped by people. `capture/extracted/people.json` lists the real contributors — `author` (the PR opener), `committer`s (the people who actually wrote/co-authored the commits, with a `commitCount`), `reviewer`s (each with a `reviewState`), `commenter`s — bot-filtered and deduped, and the orchestrator has already downloaded each one's GitHub avatar to `public/avatars/<login>.png` (the `avatarFetched: true` entries — confirm with `ls public/avatars/`). The top-level `reviewDecision` (e.g. `APPROVED`) is honest grounding.

> **The PR `author` is only who opened the PR — not necessarily who wrote the code.** A teammate frequently authors most commits and force-pushes the branch. Lead the credits with the `committer`s by `commitCount`, not the opener, or you'll miss the main contributor.

You **may** add a single closing scene that names the humans behind the change — a `branding` ("shipped by …") or `social_proof` ("approved by 3 reviewers") beat. On that scene only:

- `assetCandidates` = an array of `{ "path": "public/avatars/<login>.png", "description": "<login>, <role>" }`, **2-6 entries**, commit authors (by `commitCount`) first then reviewers, only `avatarFetched: true` logins.
- The body stays faceless — avatars appear **only** on this close, never decorating a code/diff scene.
- The visual register is an avatar row / contributor wall with names + roles + an "approved" check (the visual phase already handles non-empty `assetCandidates` — it features them like real screenshots).

This is **optional and tasteful, not mandatory**: a one-line hotfix doesn't need a credits roll; a feature or release the team rallied around earns one. When `people.json` has only the author (a solo PR with no reviews), a credits scene is usually overkill — skip it. The hook/body/payoff arc remains the spine; credits are a grace note at the end.

## Per-Scene Length Budget — ≤ 9 s, Word Count Is the Real Measurement

The single largest quality bug in PR videos is **scripts that talk too long**. The narrator agent tends to write 30-50 words per scene "because the change has nuance," then estimate `"7s"`. The actual TTS at the Phase 3 default voice (ElevenLabs Rachel for technical narration) is **~2.2 words/second (~130 wpm)** — so a 45-word script is a 20-second scene, not a 7-second one. The visual phase then has to fill 13 seconds of unplanned tail with `sine-wave-loop` idle drift, and the viewer reads the whole film as "shimmering."

**Budget the script by word count, not by gut-feel seconds.** The validator (`scripts/validate-narrator.mjs`) enforces these as machine checks; failing the hard cap is fatal.

| Bound                             | Words (at 2.2 wps) | Duration     | When                                                                                                                                                                                      |
| --------------------------------- | ------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Soft target — default**         | **≤ 19**           | **≤ 9 s**    | Every scene aims for this; visual phase plans tight, idle phase stays short, the cut feels alive.                                                                                         |
| **Exception budget — ≤ 2 scenes** | ≤ 26               | ≤ 12 s       | The main `feature_showcase` (the one change you really need to explain) or a complex causal-chain `product_intro`. Earn the extra seconds; don't spend them on hook / branding / credits. |
| **Hard cap — fatal**              | > 26               | > 12 s       | The validator rejects. Trim or split the scene.                                                                                                                                           |
| **Whole-film target**             | ≤ ~400             | up to ~3 min | Sweet spot is still ~30-90 s (≤ ~155 words); ~3 min is the ceiling. The body carries the load, the close is 5-8 s.                                                                        |

**How to estimate while writing:**

```
estimatedDuration ≈ word_count / 2.2     // round up to the nearest whole second
```

29-word script → `"13s"` (over budget, trim). 17-word script → `"8s"`. 12-word script → `"6s"`. The agent's old habit of writing `"6s"` for a 29-word script is a 2.3× miscalculation that downstream cannot fix.

**Trim pass — concrete techniques** (apply when a scene comes out 25+ words):

1. **Cut the lead-in clause.** "Until now, the agent shipped …" → "The agent shipped …". Lead-in framing is implied by the hook; the words don't earn their seconds.
2. **Move evidence off-script.** Numbers (`+2035 lines`, `23 files`, commit counts) belong as on-screen counters, not narration. The visual phase animates them; the script gains 3-5 seconds.
3. **Split into two scenes** only as the last resort — split only when the two halves carry **distinct emotional beats** (cause then effect, problem then fix).

**Where exceptions are earned:**

- The **single most complex `feature_showcase`** — e.g. a 4-step pipeline with a best-effort contract. Allow up to 12s / 26 words.
- A **causal-chain `product_intro`** — e.g. "URL → role check → bg-remove → sha256 → durable URL" — the words have to land sequentially with the on-screen edges drawing.
- Never the **hook**, the **branding/credits** close, or a single-fact `benefit_highlight`. These should be the shortest scenes in the film (5-8 s each).

**Anti-pattern: "but the change is complex."** A complex change does not require a long script; it requires a careful one. If you cannot say the headline of a change in 19 words, the headline isn't sharp yet — write it again. Distillation (line 292) is the strongest persuasion technique in this catalog precisely because it forces this discipline.

## Validation Checklist

- Does every scene have complete Narrative Intent (all 5 fields nested under `narrativeIntent`)?
- Does every scene have `transition` — `continuity` (break/continue), `intent` (one of the 5), `description` (10–30 words)? Is scene 1 `continuity: break`? Is every `continue` run at most 3 scenes?
- Is `assetCandidates` present on every scene as an array (`[]` except a user-supplied `public/<basename>`)?
- Does the emotional arc have meaningful variation matching the archetype (fix = frustration → relief; feature = curiosity → confidence)?
- Is the sequence driven by narrative, not the diff's file order or the commit list?
- Is there a coherent body that builds cumulatively (a run of `feature_showcase` / `benefit_highlight` / `product_intro`), not a single isolated body scene?
- Are Persuasion fields named techniques from the catalog, not "explain the change"?
- Are Emotional beats specific (word or short compound phrase)?
- Does the hook use a named strategy from the taxonomy?
- Is there only one outer archetype (no splicing top-level frameworks)? Named inner-rhythm compounds are allowed.
- Is the type-enum used per the repurposing table (≥1 `feature_showcase`/`product_intro`)?
- Did you feature **2-4 real diff hunks** (named in transition `description`s), each a small legible snippet — not a whole file?
- Did each scene's `script` fit the budget — **≤ 19 words / ≤ 9 s** as the default, with no more than 2 scenes claiming the ≤ 26 words / ≤ 12 s exception? Did you compute `estimatedDuration` as `ceil(word_count / 2.2)` for each, not guess? (See "Per-Scene Length Budget" above; `scripts/validate-narrator.mjs` enforces the hard cap and warns on the soft target.)

## `narrator_scripts.json`: Canonical Schema

Downstream agents expect these **exact** field names. Wrong names (e.g. `scene_id` instead of `sceneNumber`, `narration` instead of `script`, or flattened intent fields) are fatal in `validate-narrator.mjs`.

```json
{
  "project": "Project name",
  "narrativeArchetype": "PR archetype (changelog | feature-reveal | fix-explainer | refactor-walkthrough), or compound \"<outer> with <inner>\"",
  "orientation": "Canvas aspect, echoed verbatim from the dispatch Orientation line: landscape (16:9, default) | portrait (9:16) | square (1:1). Dictated by the user's aspect, not chosen. prep maps it to group_spec.width/height. Omit → landscape.",
  "emotionalArc": "Comprehension journey (e.g. 'Frustration at a flaky timeout shifting to relief as the retry loop recovers the request.')",
  "scenes": [
    {
      "sceneNumber": 1,
      "sceneName": "Scene name",
      "transition": {
        "continuity": "break|continue",
        "intent": "morph|cut|slide|dissolve|zoom",
        "sharedMotif": "Only when intent=morph: the element carried across scenes (<=8 words, e.g. 'the code window'); omit this key otherwise",
        "description": "10-30 word concrete visual direction: which hunk/file to show, what morphs/slides, where the eye lands"
      },
      "narrativeIntent": {
        "type": "hook|pain_point|product_intro|feature_showcase|benefit_highlight|social_proof|branding|cta",
        "narrativeRole": "The scene's job in the explanation (not what appears on screen)",
        "keyMessage": "What the viewer should understand after this scene (one sentence)",
        "persuasion": "Named rhetorical/clarity technique from the catalog (combine if multiple are active)",
        "emotionalBeat": "Word or short compound phrase from the vocabulary"
      },
      "assetCandidates": [],
      "script": "Plain-text narration ≤ 19 words for the soft target (≤ 9 s) — only the main feature_showcase / a causal-chain product_intro may push to ≤ 26 words. May include <em>/<brand>/<emph>/<cta> tags as authoring annotations (TTS strips them). Can be \"\" when visuals carry the information (e.g. a diff typing on).",
      "estimatedDuration": "8s   // = ceil(word_count / 2.2). Realistic ElevenLabs Rachel TTS rate is 2.2 wps; do not guess by feel — the validator catches drift."
    }
  ]
}
```

Field rules:

- Use `sceneNumber` (not `scene_id`), `sceneName` (not `scene_name`), `script` (not `narration`), and nest intent fields inside `narrativeIntent` (do not flatten them onto the scene object).
- Every scene must have a `transition` field (`continuity` + `intent` + `description`; add `sharedMotif` for morph), including scene 1 (`continuity: "break"` + `intent: "cut"`). Scene 1's transition does not generate any transition downstream (it's ignored) — `intent: "cut"` is just a placeholder.
- `continuity` is **decoupled from `intent`** (a soft hint). `continue` = same worker (a run of up to 3 scenes); `break` = new worker. `validate-narrator.mjs` checks only enum membership + scene 1 = `break`.
- `assetCandidates` is a **required** field and must be an array. For pr-to-video it is `[]` on essentially every scene; only a user-provided `public/<basename>` image yields a `{path, description}` entry (path must start with `public/`).
- At least one scene must be `type: feature_showcase` or `product_intro`.
- **Empty `script` is allowed** when the visual carries the information (a diff typing on, a before→after morph, a counter running). When you set `script: ""`, make `narrativeRole` especially strong.

## Script Voice Quality Bar

Strong PR-video scripts are clear, voiced, and technical-but-human. The failure mode is reading the PR description aloud, or noun-phrase bullets.

**Strong:**

- _Before/after_: "Before, a 500 just threw. Now the client waits, backs off, and tries again." — names the exact change.
- _Distillation_: "Eighty-four lines added, one real idea: retry, don't give up." — compresses the diff to its point.

**Weak (avoid):**

- _Diff-paraphrase in order_: "This PR modifies request.js, adds backoff.js, and updates package-lock.json." — that's reading, not explaining.
