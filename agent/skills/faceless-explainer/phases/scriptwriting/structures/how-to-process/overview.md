# How-To / Process

## Core Logic

Teach a sequence of **steps** that get the viewer from nothing to a finished outcome. Promise the result up front, justify why it is worth the effort, then walk the steps in order on a **consistent stage** — same surface, same framing, the artifact-being-built visibly accumulating — and close by showing the finished result and the one thing to remember. The persuasion is **procedural clarity**: the viewer trusts the method because they watched it assemble, step by visible step. There is no pain valley to climb out of; the engine is forward motion through numbered stages.

This is the explainer analog of a sales walkthrough, but the "product" is the **process itself**. The artifact under construction (the recipe dish, the diagram, the spreadsheet, the config) is the throughline element and the natural shared motif for morphs between consecutive steps.

## Emotional Arc Pattern

```
Curiosity ──▶ Motivation ──▶ Clarity ──▶ Momentum ──▶ Confidence ──▶ Satisfaction
  (hook)       (why)         (Step 1)    (Steps 2..N)   (result)       (takeaway)
```

A **steady ascent**, not a V-curve. The viewer never dips into anxiety; they move from "I want that outcome" to "oh, that's all it is" to "I could do this myself." Each step scene resolves a small uncertainty and hands momentum to the next. The signature feeling at the end is _earned competence_ — the opposite of being sold to. Some how-to topics open with a light valley ("most people get this wrong / it looks intimidating") to sharpen the relief of the first clean step, but keep it shallow: the structure's promise is _easy_, and a deep valley undercuts that.

## Typical Scene Sequence

`feature_showcase` is the workhorse type here — each step is a _showcase of the method doing one thing_. The validator requires at least one `feature_showcase` or `product_intro` scene; a how-to with 3+ steps satisfies this naturally. There is no real "product," so `product_intro` is repurposed as the **setup/ingredients** scene (what you start with), and `branding` as the closing **takeaway/principle** scene.

| Order | `type`            | Means here (explainer reading)                                       | Approx % | Job                                                                   |
| ----- | ----------------- | -------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| 1     | hook              | Outcome promise — show the finished result or the payoff in one line | 8-12%    | Make the viewer want the outcome; create the "show me how" gap        |
| 2     | pain_point        | Why it matters / why most get it wrong (shallow, optional)           | 8-12%    | Stakes — justify spending the next 60s; can be folded into the hook   |
| 3     | product_intro     | Setup — the starting materials / tools / prerequisites laid out      | 8-12%    | Establish the stage and the artifact in its "before" state            |
| 4     | feature_showcase  | **Step 1** — first concrete action, numbered, on the stage           | 12-18%   | Lowest-friction first move; prove the method is approachable          |
| 5     | feature_showcase  | **Step 2** — next action, artifact visibly advances                  | 12-18%   | Build momentum; the artifact is now recognizably forming              |
| 6     | feature_showcase  | **Step 3..N** — continue numbered steps on the same stage            | 12-18%ea | Each scene = exactly one step; never cram two steps into one scene    |
| N+1   | benefit_highlight | Result / recap — the finished artifact, all steps visible at once    | 10-15%   | Payoff: the promise from scene 1 is now fulfilled and inspectable     |
| N+2   | branding / cta    | Takeaway — the one principle to remember, or "now go try it"         | 8-12%    | Crystallize the method into a portable rule; invite the viewer to act |

Keep step scenes **uniform in length and framing** — visual consistency _is_ the signposting. A step that suddenly changes stage or runs 2× longer reads as "this one is hard," which contradicts the structure's promise. Always **number the steps on-screen** (Step 1 / Step 2 / 1·2·3): the count is the spine. Target 3-5 steps for a ~60-90s video (up to ~6-7 when you're using the full ~3 min); beyond that, merge adjacent steps or split into a `listicle`.

## When to Use

- The topic is genuinely **sequential** — order matters and step N depends on step N-1 (recipes, tutorials, setup guides, workflows, "how to do X").
- There is a single, showable **outcome** the viewer wants.
- The artifact accumulates visibly, so morphs between steps have a real throughline.
- The audience is at the "I'm ready to do this, just show me how" stage (mid-intent).

## When NOT to Use

- The items have **no required order** — they're parallel tips or options (→ use `listicle`).
- You're explaining _what something is_ or _why it works_ rather than _how to make it_ (→ use `concept-explainer`).
- The journey is driven by a character or anecdote, not a procedure (→ use `story-explainer`).
- There are 8+ micro-steps with no natural grouping — the spine collapses into a checklist; merge or re-scope.

## Hook Strategy Bias

How-to lives or dies on the **outcome promise**. Favored hooks (from the hook taxonomy):

- **Imagine / future-pacing** — show the viewer holding the finished result first: "By the end of this you'll have a one-page budget that updates itself." The strongest how-to hook; it sets the destination before the journey.
- **Rhetorical question** — "Ever wondered how to X in under five minutes?" — opens the curiosity gap the steps will close.
- **Shocking statistic** — "Most people spend 3 hours on this. Here's the 4-step version." — justifies the method by contrast with the slow way.
- **Category announcement** — name the method itself: "The two-pot method." — when the _technique_ is the memorable thing.

Avoid deep **pain validation** openers — this is not PAS; lingering on frustration delays the promise and flattens the ascent. A one-line "most people overcomplicate this" is the most pain you want.

## Pacing & Transition Guidance

The artifact-being-built is the canonical **shared motif**, so consecutive steps are the prime location for **morph pairs**: the half-built thing in Step 2's exit frame _is_ the same thing in Step 3's entry frame, transformed by one action. This is the most polished seam available and it reinforces "same stage, continuous work."

Apply the rules exactly:

- **Scene 1 is always `break`** (placeholder `intent: cut`; no real opening transition).
- **continue runs (up to 3 scenes):** when the artifact carries continuously across 2-3 adjacent steps, group them as one `continue` run — a single worker owns all of them and authors the flow. `intent: morph` + `sharedMotif` (naming the artifact) are soft hints. A run is ≤3 scenes; a 4th step starts a new run with a `break`.
- Pattern the step run as continue-runs separated by Tier-B breaks: `continue-run(Step1,Step2,Step3) → break → continue-run(Step4,Step5) → break → …`. Group steps that share the acted-on artifact; start a new run (a `break`) when the stage resets.
- Use **Tier-B** at _register changes_, not between continuous steps: `slide` from setup into Step 1 (forward motion, "let's begin"); `cut` or `zoom` from the last step into the **result** recap (energy shift, pull back to see the whole); `dissolve` into the **takeaway** (reflective close). The hook→why and why→setup seams are typically `slide` or `cut`.
- The `sharedMotif` must be **load-bearing in both scenes** (the actual artifact, not a decorative numeral). The step counter incrementing is good supporting motion but the _thing being built_ is the morph subject.

## Emotional-Beat Trajectory

Lean **curiosity → clarity → confidence**, not anxiety → relief. Suggested per-slot beats (use the emotional-beat vocabulary; compound beats are strongest):

- Hook: **curiosity** / "curiosity and aspiration"
- Why-it-matters: **motivation** (or a shallow **skepticism** if you open with "most get this wrong")
- Setup: **clarity** / "clarity and readiness"
- Step 1: **ease** / "ease and reassurance" (prove it's approachable)
- Steps 2..N: **momentum** → **confidence** (rising as the artifact forms; "confidence and control")
- Result/recap: **satisfaction** / "satisfaction and pride"
- Takeaway/CTA: **empowerment** / "motivation to act"

The arc should _feel_ monotonically rising. Variation comes from the texture of each beat (ease vs. momentum vs. pride), not from a dip.

## Worked Example

**Topic:** _How to brew better coffee at home in 4 steps_ (≈70s, text + diagram visuals, pin-and-paper).

1. **The Promise** — `hook` — _"Café-quality coffee, four steps, one machine you already own."_ — `break` / `cut` (scene 1 placeholder; a hand-drawn finished cup fades up).
2. **Why Yours Tastes Flat** — `pain_point` (shallow) — _"Most home coffee fails on one thing: control. Fix four variables and it's transformed."_ — `slide` / `break` (push left into the four-variable list).
3. **What You'll Need** — `product_intro` (setup) — _"Beans, a grinder, a scale, and hot water just off the boil."_ — `slide` / `break` (the four tools slide onto a paper workbench — the **stage**).
4. **Step 1 · Grind Fresh** — `feature_showcase` — _"Grind right before you brew. Medium-coarse, like coarse sand."_ — `slide` / `break` (the bean motif slides in over the workbench).
5. **Step 2 · Weigh & Wet** — `feature_showcase` — _"Sixteen grams of water for every gram of coffee. Bloom for thirty seconds."_ — `morph` / `continue` · sharedMotif: **the coffee grounds bed** (the ground pile from Step 1 morphs into the wetted bloom).
6. **Step 3 · Pour Slow** — `feature_showcase` — _"Pour in slow circles. Steady is everything."_ — `break` / `cut` (resets the pair; pour diagram cuts in).
7. **Step 4 · Time It** — `feature_showcase` — _"Aim for a three-minute brew. Too fast is sour, too slow is bitter."_ — `morph` / `continue` · sharedMotif: **the brew timer dial** (the pour arc from Step 3 morphs into a sweeping timer).
8. **Now Taste It** — `benefit_highlight` (result/recap) — _"Four variables, one great cup. Grind, weigh, pour, time."_ — `zoom` / `break` (pull back: all four numbered steps and the finished cup on one page).
9. **Tweak One Thing** — `branding` (takeaway) — _"Change one variable at a time and your coffee gets better forever."_ — `dissolve` / `break` (soft fade to the single closing principle).

Continue runs land where the artifact carries through — (Step 1→2) grounds-bed, (Step 3→4) pour→timer — each a same-worker run separated by a `break`, and the recap `zoom` deliberately steps outside the step-stage to let the viewer see the whole method at once.
