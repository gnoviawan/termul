# Concept Explainer

## Core Logic

Explain **one** idea, mechanism, or term until it clicks. Open a curiosity gap ("what is X / how does X actually work"), ground the question in something the viewer already feels, then reveal the core concept by name, expose its mechanism one moving part at a time, anchor it with a concrete example or analogy, and close on the "so what" — why the idea now matters to the viewer. The persuasion is **comprehension itself**: the viewer is won the moment the thing makes sense. There is no pain to agitate and nothing to sell; the reward is the click of understanding.

This is the default structure for a single-topic faceless explainer. It is built on **progressive disclosure** (one new idea per scene, never two) and **analogy** (a familiar object stands in for the unfamiliar mechanism). The concept is named **early-to-mid** — late enough that the question lands first, early enough that the rest of the film has a name to attach to.

## Emotional Arc Pattern

```
Curiosity ──▶ Recognition ──▶ Intrigue ──▶ Clarity ──▶ Confidence ──▶ Conviction
  (hook)      (ground)        (reveal)     (mechanism)   (example)      ("so what")
```

This is a **staircase, not a V-curve**. Explainers do not dip into a named negative beat the way sales PAS does; the dominant motion is **curiosity → clarity → confidence**, each scene resolving one notch of confusion into one notch of understanding. The intrigue beat at the reveal is the emotional peak (the gap is widest just before it closes); the mechanism and example scenes pay it off as steady clarity. Verbalize the arc as something like: _"Curiosity about an unfamiliar mechanism resolves into clarity as the moving parts are exposed one at a time, ending in confidence that the idea is now genuinely understood."_

A shallow valley is _allowed_ but optional: a "why the obvious answer is wrong" beat (mild surprise / dissonance) can sit between ground and reveal to sharpen the gap. Keep it cognitive (surprise, dissonance), not emotional (anxiety, frustration) — that valley belongs to the story-explainer and how-to structures, not here.

## Typical Scene Sequence

Types are drawn from the fixed enum `hook | pain_point | product_intro | feature_showcase | benefit_highlight | social_proof | branding | cta`. For an explainer they are **repurposed** — the column below states what each MEANS here.

| Order | Type                | Means here (explainer)                                                              | Approx % | Job                                                               |
| ----- | ------------------- | ----------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| 1     | `hook`              | The curiosity-gap question — pose what the viewer doesn't yet know                  | 8-15%    | Open the gap; make the unknown feel worth chasing                 |
| 2     | `pain_point`        | Ground the question — the friction / confusion / "why this matters" the gap sits on | 10-15%   | Make the question the viewer's own, not an abstract trivia prompt |
| 3     | `product_intro`     | Name and define the concept — the term + a one-line plain-language definition       | 12-18%   | Plant the flag; give the rest of the film a name to hang on       |
| 4     | `feature_showcase`  | Mechanism beat — show ONE moving part of how it works                               | 15-22%   | Begin progressive disclosure; one component, no more              |
| 5     | `feature_showcase`  | Next mechanism beat — the next moving part, building on scene 4                     | 12-18%   | Assemble the mechanism; the diagram/throughline grows             |
| 6     | `benefit_highlight` | The concrete example / analogy — map the mechanism onto something familiar          | 15-22%   | "Oh, it's _like_ that" — the comprehension click                  |
| 7     | `branding`          | The "so what" takeaway — the one durable sentence the viewer keeps                  | 10-15%   | Land the idea as a principle, not a product; resolve the gap      |

5-8 slots is the working range. Compress 4+5 into one mechanism scene for a single-mechanism topic; expand to 2-3 mechanism scenes (a `feature_showcase` sequence) for a multi-part mechanism — the same "3+ consecutive mechanism scenes on one growing diagram" rhythm the showcase sequence uses elsewhere. A `cta`-typed final scene is **optional and soft** here: an explainer rarely asks for action, but if the brief wants a "learn more / read the full piece" close, use `cta` for scene 7+ instead of `branding`.

**Concept-naming timing** — name the concept at **scene 3 (≈12-30% in)**. Earlier than PAS's late product reveal, later than Cascade's scene-1 reveal: the question must land first (scenes 1-2) so the name arrives as the _answer to a question already asked_, not as a cold definition. Naming it in scene 1 wastes the curiosity gap; naming it past 40% leaves too little runtime to actually explain it.

## When to Use

- "What is X" / "how does X work" topics — a single idea, mechanism, term, or phenomenon
- Science, tech, finance, biology — anything with a _mechanism_ that can be disclosed in steps
- The payoff is the viewer **understanding** something, not feeling a pain relieved or wanting a product
- One clean analogy is available (or inventable) to carry the example beat
- The topic genuinely fits in one throughline — a single concept, not a survey

## When NOT to Use

- The text is a sequence of steps the viewer must _perform_ (→ use **how-to-process**)
- The text is several parallel items / a ranking with no single mechanism (→ use **listicle**)
- The payoff depends on a character, stakes, or a turn of events (→ use **story-explainer**)
- The topic is actually three concepts wearing one title — split, or pick the load-bearing one; concept-explainer disclosing two ideas per scene collapses into noise
- There is no mechanism to expose, only a definition — then it's a 15-second card, not a full ~1-3 min film

## Hook Strategy Bias

From the inherited Hook Strategy Taxonomy, concept-explainer leans on the **gap-opening** hooks:

- **Rhetorical question** — the canonical concept-explainer open. "Why does your coffee go cold faster than your tea?" — names the gap and makes the viewer want it closed. Default choice.
- **Shocking statistic** — when a credible number _is_ the gap. "Your brain uses 20% of your energy doing nothing." The number is the hook because it defies expectation.
- **Imagine / future-pacing** — for forward-looking or counterfactual concepts. "Imagine a battery that charges in the time it takes to read this sentence." Use when the concept's _implication_ is more gripping than its definition.
- **Category announcement** — when the _term_ itself is the draw and is unfamiliar enough to be intriguing. "This is dollar-cost averaging." Use sparingly: only when the name carries mystery on its own.
- **Visceral metaphor** — when the concept is abstract and needs an embodied entry point that the example beat later pays off ("Think of your immune system as a city under siege").

Avoid the sales-coded opens — **pain validation** and **direct address / character hail** — unless the brief is genuinely pain-shaped; they signal "this is a fix for you" and tilt the film toward PAS, undercutting the curiosity arc. Avoid **visual spectacle for its own sake**: spectacle without a question is a screensaver, not a hook.

## Pacing & Transition Guidance

The natural throughline of a concept-explainer is **one shared visual** — the diagram, the analogy object, the term card — that _grows_ across the mechanism scenes. That growing element is exactly what a **continue run** is for: one worker owns the run and authors the visual continuity itself.

- **Where continue runs land:** across consecutive **mechanism** beats that share the same growing diagram/object, or from the **definition → first-mechanism** seam (scenes 3↔4 above) when the term card unfolds into the first moving part. A continue RUN can be **2-3 scenes in one worker (cap=3)** — use `continue` when 2-3 adjacent scenes share a growing element / continuous stage, `break` otherwise. The growing diagram usually justifies a run because progressive disclosure _is_ one element accreting detail. `morph` is now just a soft hint that the worker carries a shared element across a continue seam; `sharedMotif` (`"the concept diagram"`, `"the analogy object"`, `"the term card"`) names that element as a hint, but nothing validates the two against continuity.
- **Where break + Tier-B is right:** the **register shifts**. Scene 1→2 (question → grounding): `slide` or `dissolve`. Scene 2→3 (grounding → naming the concept): `cut` or `zoom` — a deliberate beat change that says "here's the answer." Mechanism → **example/analogy** (5→6): `dissolve` or `zoom`, because the analogy is a _new visual world_ (kitchen, city, river) handed to a new worker, not a continuation of the diagram. Example → "so what" (6→7): `slide` or `cut` to land the takeaway cleanly.

Respect the rules: **scene 1 is always `break`.** A continue seam gets a short crossfade (smooths the same-worker cut); a break seam gets the intent-driven Tier-B type (`cut`/`slide`/`dissolve`/`zoom`). `intent` and `sharedMotif` are soft hints only — pick `continue` when 2-3 adjacent scenes genuinely share a growing element (≤3 per run), `break` otherwise. A growing diagram across scenes 4-5-6 can be one **3-scene continue run** owned by a single worker; a 4th scene must start a new run with a `break`.

## Emotional-Beat Trajectory

Use the inherited Emotional Beat Vocabulary. Concept-explainer rides the curiosity→clarity→confidence channel, drawing mostly from the **Pivot** and **Build** registers; it touches the **Negative valley** only lightly (cognitive, not emotional):

| Scene             | Beat                        | Note                                                                     |
| ----------------- | --------------------------- | ------------------------------------------------------------------------ |
| hook              | curiosity                   | the gap opens; sometimes _curiosity and surprise_ for a statistic hook   |
| ground            | curiosity / mild dissonance | "wait, why?" — keep it cognitive, not anxious                            |
| reveal (naming)   | intrigue / clarity          | the emotional peak; the name arrives as relief-of-the-question           |
| mechanism         | clarity / focus             | one notch of understanding per beat; build, don't dazzle                 |
| example / analogy | clarity and recognition     | the "oh, it's _like_ that" click — the strongest single beat of the film |
| "so what"         | confidence / conviction     | the idea is owned; ends settled, not urgent                              |

Compound beats are strongest: _"intrigue and clarity"_ at the reveal, _"clarity and recognition"_ at the analogy. Avoid generic "interested" / "positive". Do not borrow PAS's anxiety→relief — an explainer that manufactures dread to sell understanding reads as clickbait.

## Worked Example

**Topic:** _How does compound interest actually work?_ (~60s, 7 scenes). Style: pin-and-paper. Throughline shared element: a **stack of paper coins** that grows.

1. **The Snowball Question** · `hook` · _"Why does a little money left alone turn into a lot — without you adding a thing?"_ · **break / cut** (scene 1; placeholder)
2. **The Boring Savings Account** · `pain_point` · _"Most of us picture savings as a flat pile that just… sits there. It doesn't."_ · **break / slide** (push into the misconception)
3. **Meet Compound Interest** · `product_intro` · _"This is compound interest — interest that earns interest on the interest."_ · **break / zoom** (push through to the named answer)
4. **Year One: The First Layer** · `feature_showcase` · _"Year one, your money earns a little. That little gets added to the pile."_ · **continue / morph** — sharedMotif: `"the growing coin stack"` (term card unfolds into the first coin layer)
5. **Year Two: It Earns On Itself** · `feature_showcase` · *"Year two, you earn on the original *and* on last year's gain. The pile grows faster than before."* · **break / dissolve** (close the morph pair; quiet beat as the curve bends)
6. **The Rolling Snowball** · `benefit_highlight` · _"It's a snowball rolling downhill — every turn picks up more snow than the last, on its own."_ · **break / dissolve** (cut to a new analogy world: the hillside)
7. **Start Early, Not Big** · `branding` · _"So the trick was never how much you start with. It's how long you let it roll."_ · **break / slide** (land the durable takeaway)

Notice: one new idea per scene; the concept named at scene 3; scenes 3-4 form one continue run on the growing coin stack (one worker, `morph` as a soft hint that it carries the stack across the seam), then `break` before the analogy jump; the analogy enters via `dissolve` into a new worker's new visual world; the arc runs curiosity → intrigue → clarity → recognition → conviction with no negative valley. `narrativeArchetype` for this file would be `"concept-explainer"` (or `"concept-explainer with mechanism showcase"` if the mechanism runs 3+ scenes).
