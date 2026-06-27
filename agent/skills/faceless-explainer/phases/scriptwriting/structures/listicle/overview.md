# Listicle — Promise the Number → Deliver N Punchy Items

## Core Logic

Promise a finite count up front ("5 ways to…", "3 myths about…", "the 4 signs of…") → deliver each item as its own compact, parallel-structured scene → close with a wrap, ranking, or single takeaway. The number is the contract: it caps the runtime, sets the viewer's expectation, and supplies the spine. Momentum comes from **parallel composition** — every item beat looks and sounds like its sibling (same layout skeleton, same script rhythm), so the count itself becomes the through-line. There is no agitation phase and no late reveal; the value is delivered immediately and repeatedly. The persuasion is **completion** — once the viewer is told there are five, they stay to collect all five.

## Emotional Arc Pattern

```
Curiosity ──▶ Clarity (item 1) ──▶ Rhythm (items 2…N) ──▶ Satisfaction ──▶ Confidence
  (hook)        (first beat)        (parallel cascade)     (full set)        (takeaway)
```

This is a **steady, segmented climb** — no V-curve, no negative valley. Each item is a self-contained micro-payoff: curiosity opens it, clarity closes it, and the running counter ticks one notch up. The arc accumulates by repetition rather than by escalating one continuous tension. A mild valley is _optional_ in myth-busting / "mistakes you're making" framings (each item briefly names a wrong-belief before correcting it), but the dominant feeling is **collect-and-confirm**, not anxiety→relief.

## Typical Scene Sequence

For a 5-item list (scale the body up or down with N; aim for 5-8 total scenes):

| Order | `type`              | What it means here (explainer)                                                                                                                                        | Approx % |
| ----- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1     | `hook`              | **Promise the number.** State the count + the payoff ("5 habits that quietly drain your day"). Set the counter motif.                                                 | 8-12%    |
| 2     | `feature_showcase`  | **Item 1.** First point delivered in the parallel template. ("feature" = one list item / tip / claim, _not_ a product feature.)                                       | 15-18%   |
| 3     | `feature_showcase`  | **Item 2.** Same skeleton, new content. Counter ticks 1→2.                                                                                                            | 15-18%   |
| 4     | `feature_showcase`  | **Item 3.** Rule-of-three midpoint; often the strongest/most surprising item.                                                                                         | 15-18%   |
| 5     | `feature_showcase`  | **Item 4.** Maintain rhythm; vary the data-viz/typography so it doesn't read as a clone.                                                                              | 12-15%   |
| 6     | `benefit_highlight` | **Item 5 / the payoff item.** Land the final, highest-value point ("benefit" = the why-it-matters of the last item, the ranking winner, or the synthesizing insight). | 12-15%   |
| 7     | `cta`               | **Wrap / takeaway.** Recap the full set, name #1, or give one action. ("cta" = the closing nudge or single sentence to remember — explainers rarely "sell.")          | 8-12%    |

Notes:

- **All body items use `feature_showcase`** because each is a _demonstration of one discrete point_ — the closest enum fit. Promote the final or strongest item to `benefit_highlight` when you want the why-it-matters to land harder than the others (a ranked "#1" or a synthesizing takeaway).
- **`product_intro` is unused** in pure listicles (there is no product). The validator requires at least one `feature_showcase` _or_ `product_intro` scene — the item scenes satisfy this automatically.
- `social_proof` may replace one item when the list is evidence-driven ("3 studies that…"), and `branding` is generally skipped.

## When to Use

- The content is naturally enumerable: tips, do's/don'ts, "top N", comparisons, signs/symptoms, myth-busting, steps you can shuffle without breaking meaning.
- The source text already contains a count or an obvious set of parallel points.
- You want high information density and forward momentum over a single emotional journey.
- The audience wants to _collect_ takeaways quickly (skimmable, shareable explainers).

## When NOT to Use

- The points are sequential and order-dependent (each depends on the previous) → use **how-to-process**.
- There is one core idea to unpack in depth, not many parallel ones → use **concept-explainer**.
- The material is inherently a single human/narrative throughline → use **story-explainer**.
- N would be 2 or 8+: two items isn't a list (it's a comparison — fold into concept-explainer); eight+ items overwhelm a short explainer — cut to the best 4-6 (up to ~6-7 only if you're filling the full ~3 min), or split the topic.
- The items aren't genuinely parallel (forcing dissimilar ideas into identical templates feels mechanical).

## Hook Strategy Bias

Listicles live or die on the opening promise. From the hook taxonomy, the strongest fits:

- **Category announcement** — name the list as the thing: "The 5 logical fallacies that win arguments." The count _is_ the hook.
- **Shocking statistic** — open on the number that justifies the list: "73% of these are made in the first 10 seconds. Here are the four." Statistic → enumeration is a tight pairing.
- **Rhetorical question** — pose the gap the list closes: "Why do some emails always get replies? Five reasons."
- **Imagine / future-pacing** — for aspirational lists: "Imagine never forgetting a name again — here are three tricks."

Avoid pain-validation / visceral-metaphor openers (those belong to anxiety-led structures); the listicle hook is brisk and promissory, not heavy. **Always state or strongly imply the count in the hook** — a listicle whose number arrives late forfeits its central mechanic.

## Pacing & Transition Guidance

The default seam between items is **Tier-B**: each item is its own beat, a clean parallel restart, so most item→item transitions are `cut` or `slide` (`continuity: break`). Reach for `slide` to express "next point" directional momentum (the counter advancing left-to-right), `cut` for high-energy snap between equal siblings, `dissolve` when the visual register shifts (typography item → data-viz item), and `zoom` to push into a number or a single focal stat. Scene 1 is always `break`.

**Where morph pairs naturally occur:** the **counter / number motif** is the listicle's built-in shared element — a running "1 of 5 → 2 of 5" badge, a progress dot row, or a recurring numeral frame that physically advances. When two adjacent items genuinely hand off that motif (the "3" digit morphs into the "4", or the progress bar fills from one segment to the next as the visual protagonist of _both_ scenes), use `intent: morph` (`continuity: continue`) with `sharedMotif: "the item counter"` (or `"the progress bar"`) as soft hints. This is the polished move — use it sparingly:

- **Continue runs ≤3 scenes:** a listicle is mostly parallel items, so most seams are `break` (cut/slide). Use `continue` only where the counter/motif genuinely hands off across 2-3 adjacent items; a run is ≤3 scenes, then a `break`. `morph`/`sharedMotif` are soft hints for that one worker.
- Don't morph _every_ seam — the listicle's signature is the parallel **restart**, and too many continuous morphs blur the discrete-item feel that makes it a list. One or two counter-morph pairs across the body is the sweet spot; keep the rest Tier-B.
- The hook→item-1 seam is usually Tier-B (`zoom` into the first item, or `cut`), since item 1 establishes the template the rest restart from.

## Emotional-Beat Trajectory

Lean **curiosity → clarity → confidence**, accumulating per item rather than swinging through a valley:

- **Hook:** `curiosity` (or `intrigue` when the count is surprising).
- **Items 1…N:** alternate `clarity` and `confidence`; sprinkle `intrigue` on a counter-intuitive item and `playfulness`/`ease` on a light one to keep the parallel cascade from flattening. Myth-busting variants may open each item on `skepticism` and resolve it to `clarity`.
- **Payoff item:** `confidence` or `reassurance` — the set feels complete.
- **Wrap/CTA:** `motivation` or `inevitability` — "now you know all five."

Avoid a monotone arc: identical beats on every item read as a list of facts, not a journey. Vary the _texture_ of clarity (surprise on one, ease on another) even though the macro-feeling stays positive.

## Worked Example

**Topic:** "5 ways to fall asleep faster" (sleep-hygiene explainer, faceless, typography + simple data-viz). 7 scenes, ~60s.

1. **Promise the Five** — `hook` — _"You'll waste 9 days a year just lying awake. Five fixes — starting tonight."_ — Transition: `break` / `cut` (scene 1 placeholder; counter badge "1 of 5" assembles on screen).
2. **Cool the Room** — `feature_showcase` — _"Drop the thermostat to 65. Your core temperature has to fall before sleep even begins."_ — Transition: `break` / `zoom` (push from the badge into item 1's thermometer graphic).
3. **Kill the Blue Light** — `feature_showcase` — _"Screens off an hour before bed — blue light tells your brain it's still noon."_ — Transition: `break` / `slide` LEFT (next-point momentum; counter ticks 1→2).
4. **The 4-7-8 Breath** — `feature_showcase` — _"Inhale four, hold seven, exhale eight. Repeat four times. It slows your heart on command."_ — Transition: `continue` / `morph`, `sharedMotif: "the item counter"` (the "2" numeral morphs into "3" as the breathing-timer ring draws — counter is the protagonist of both scenes).
5. **No Late Caffeine** — `feature_showcase` — _"Caffeine has a six-hour half-life. That 4pm coffee is still half-awake at 10."_ — Transition: `break` / `dissolve` (register shift to a decay-curve data-viz).
6. **Same Time, Every Day** — `benefit_highlight` — _"The single biggest lever: a fixed wake time. Anchor that, and the other four compound."_ — Transition: `break` / `slide` LEFT (final item; framed as the ranked #1 that ties the set together).
7. **Tonight's List** — `cta` — _"Cool, dark, breathe, cut the caffeine, fix your wake time. Pick one — start tonight."_ — Transition: `break` / `cut` (all five counter dots fill; recap of the full set as the takeaway).
