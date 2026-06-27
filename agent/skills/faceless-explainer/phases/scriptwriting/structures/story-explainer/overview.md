# Story Explainer

## Core Logic

Explain a concept by living through it. Open on a relatable situation with a named character or scenario → let a real problem surface inside that situation → introduce the insight/concept as the turning point → show how it plays out → land the lesson. The viewer learns the idea because they watched it _matter_ to someone, not because it was defined for them. The concept earns its entrance only after the scenario has made the viewer want an answer.

This is the only FE structure with a genuine **valley** — the scenario gets worse before the insight arrives. Use that valley deliberately; it is what makes the resolution legible. But the valley is _narrative tension_, not sales-anxiety: the viewer is curious about how it resolves, not afraid of a cost they'll bear.

## Emotional / Cognitive Arc Pattern

```
Recognition ──▶ Tension ──▶ Insight ──▶ Clarity ──▶ Confidence
  (scenario)   (problem)   (concept)  (it plays out)  (lesson)
```

A **shallow V**: dip into the problem-in-context, pivot on the concept, climb through resolution to the takeaway. Unlike a sales V-curve (anxiety → relief), the emotional spine is **curiosity → intrigue → clarity → conviction** — the negative beat is _tension/stuck_, never dread. The character (or recurring object) is the throughline; the audience's understanding rises as the character's situation resolves.

## Typical Scene Sequence

5–8 scene slots. `type` is from the fixed enum `hook | pain_point | product_intro | feature_showcase | benefit_highlight | social_proof | branding | cta`; for an explainer each is repurposed as noted.

| Order | Type (enum)         | Means here (explainer)                                                              | Approx % | Job                                                                                |
| ----- | ------------------- | ----------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| 1     | `hook`              | Scene-setting — drop the viewer into a concrete, relatable situation                | 8–12%    | Introduce the character/scenario; make the viewer recognize themselves             |
| 2     | `pain_point`        | The problem-in-context — the friction/stakes inside the scenario                    | 12–18%   | Raise tension: what's going wrong, what's at stake, why the obvious move fails     |
| 3     | `product_intro`     | The turning point — the **insight / concept / mechanism** enters as the hero        | 12–18%   | Name the idea. This is the pivot; the concept arrives as the answer to the tension |
| 4     | `feature_showcase`  | It plays out — the concept applied step-by-step inside the same scenario            | 15–22%   | Show the idea working on the character's actual problem (not abstract definition)  |
| 5     | `benefit_highlight` | Why it works — the principle behind the resolution; what changed and why it matters | 12–18%   | Generalize from this one case to the underlying truth                              |
| 6     | `social_proof`      | _(optional)_ Corroboration — a second instance, a real number, a "this is common"   | 8–12%    | Show the lesson isn't a one-off; widen from the character to the pattern           |
| 7     | `branding` / `cta`  | The lesson — the one-sentence takeaway, or a "next time you see X, remember Y"      | 10–15%   | Crystallize the principle; optionally invite the viewer to apply it                |

The "insight enters" pivot (`product_intro`) is the structural heartbeat — it lands at **roughly 30–45%**. Don't reveal the concept in scene 1: a story explainer that defines the idea up front collapses into a `concept-explainer` and throws away the tension that makes the lesson stick.

> `product_intro` here is **conceptual**, not a product. It names the idea/mechanism that resolves the scenario (e.g. "compound interest", "the bystander effect", "rubber-ducking"). `feature_showcase` = the concept _doing the work_; `benefit_highlight` = the generalizable principle. FE projects are text-only by default, so `assetCandidates` is `[]` on every scene unless a real file lives under `public/`.

## When to Use

- Case studies and "why X matters" topics — the stakes are easiest to feel through a single concrete instance.
- Behavior / psychology / finance / history — domains where an abstract principle is best taught through one person's situation.
- Any topic where the input already contains a protagonist, an example, or a "here's what happened" anecdote — let the source's narrative drive the structure.
- When the lesson is counterintuitive: a story disarms skepticism by letting the viewer reach the insight alongside the character.

## When NOT to Use

- A flat reference topic with no inherent scenario ("what is a hash map") → use `concept-explainer`.
- A sequence of independent items with no shared protagonist ("7 productivity apps") → use `listicle`.
- A literal procedure the viewer will follow themselves ("how to file taxes") → use `how-to-process`.
- Very short runtimes where you can't afford to spend 30% building a scenario before the payoff — the valley needs room to breathe.

## Hook Strategy Bias

From the hook taxonomy (`../../guide.md`), Story Explainer leans on hooks that _drop you into a moment_:

- **Relatable scenario / character hail** — the native opener. "It's 11pm and Maya is still staring at the same paragraph." Concrete time, place, and a name beat any abstract claim.
- **Rhetorical question** — frame the scenario as a puzzle the viewer wants solved. "Why did the smartest person in the room make the worst call?"
- **Imagine / future-pacing** — when the scenario is hypothetical-but-vivid. "Imagine you're handed $1,000 and told not to touch it for 40 years."
- **Shocking statistic** — only as a _doorway into_ the scenario, not the scenario itself. "90% of these end in regret — here's one of them." Then immediately cut to the character.

Avoid **category announcement** and pure **visual-spectacle** openers — naming the concept or leading with abstraction in scene 1 dissolves the tension this structure depends on.

## Pacing & Transition Guidance

Transition vocabulary and the continue-run model (continue = same worker, up to 3 scenes; `morph`/`sharedMotif` are soft hints) live in `../../guide.md` — follow them exactly. Story-Explainer specifics:

- **Scene 1 is always `break`** (`intent: cut`, placeholder — no real opening transition).
- **The recurring motif is a built-in morph throughline.** A character avatar, an object the story orbits (a jar of coins, a locked door, a single chart line), or the protagonist's "state" is naturally co-present across adjacent scenes — that is exactly what a `continue` run is for: group those adjacent scenes under one worker so it authors the throughline. `morph`/`sharedMotif` are soft hints naming the recurring object.
- **Best morph seams:**
  - `pain_point → product_intro` — the pivot. The motif that represented the _problem_ transforms into the thing that represents the _insight_ (the cluttered desk's single sticky note morphs into the lit idea). This is the most powerful seam in the structure; spend a morph pair here.
  - `feature_showcase → benefit_highlight` — the same applied object (the jar now full) morphs from the concrete case into the principle.
- **Use Tier-B (`cut` / `slide` / `dissolve` / `zoom`) where the register shifts:**
  - `hook → pain_point` — usually a `slide` or `dissolve`: same scenario, tension rising; no shared element transforms, so don't force a morph.
  - Entering `social_proof` — a `cut` signals "stepping outside the story to the wider world."
  - Into the final lesson — a `zoom` (pull back from the case to the principle) or a `dissolve` reads as "the camera rises above the story."
- **Continue runs ≤3 scenes:** group 2-3 adjacent scenes that share a recurring object/character (the jar, the curve, the protagonist) as one `continue` run owned by a single worker; separate runs with a `break`. Shape e.g. `break(1) → slide(2) → continue(3) → break(4) → continue(5) → break(6) → break(7)`. scene 1 is always `break`.

## Emotional-Beat Trajectory

Use the emotional-beat vocabulary (`../../guide.md`). Story Explainer is the one FE structure that earns a real **valley → resolution**, but keep it on the curiosity register, not the anxiety register:

```
curiosity → tension/stuck → intrigue → clarity → confidence → conviction
 (scene)     (problem)      (pivot)    (plays out)  (principle)  (lesson)
```

- Scene 1 `hook`: **curiosity** (or **recognition** — "that's me").
- `pain_point`: **tension** / **stuck** / **frustration** — the narrative valley. This is the only place a mildly negative beat belongs.
- `product_intro` pivot: **intrigue** / **clarity** — the "oh" moment.
- `feature_showcase` / `benefit_highlight`: **clarity** → **confidence** → (compound) **understanding and satisfaction**.
- Final lesson: **conviction** / **resolve** — "I'll remember this," not "buy now."

Write compound beats where two feelings are live ("intrigue and relief" at the pivot, "clarity and satisfaction" at the resolution).

## Worked Example

**Topic:** Why you should start saving in your 20s (compound interest). Recurring motif: **a coin jar**.

1. **Two friends, one choice** — `hook` — "Sam and Alex both turned 25 this year. Sam starts putting $100 a month into a jar. Alex waits." · _Transition: `break` / `cut` (scene 1 placeholder)._
2. **The 10-year head start** — `pain_point` — "By 35, Alex finally starts too — same $100 a month. Alex figures a decade is easy to make up." · _Transition: `break` / `slide` (tension rises inside the same scenario; no shared element morphs)._
3. **Enter compounding** — `product_intro` — "But money doesn't grow in a line. It grows on what it already grew — that's compound interest." · _Transition: `continue` / `morph`, sharedMotif: "the coin jar" (Sam's jar of coins morphs into a curve climbing off its own height — the problem-object becomes the insight)._
4. **The jars at 65** — `feature_showcase` — "At 65, Sam's jar holds far more than Alex's — even though Alex paid in nearly as much." · _Transition: `break` / `dissolve` (time-jump to the outcome; register shift)._
5. **Time did the work, not the deposits** — `benefit_highlight` — "Sam's edge wasn't more money. It was more time for the growth to feed itself." · _Transition: `continue` / `morph`, sharedMotif: "the growth curve" (the two jars' curves morph into a single labeled principle)._
6. **It's the same for everyone** — `social_proof` — "Run the math on any amount: the early start almost always wins." · _Transition: `break` / `cut` (step outside the two-friend story to the general case)._
7. **The lesson** — `branding` — "The best time to start was a decade ago. The second best is today." · _Transition: `break` / `zoom` (pull back from the example to the takeaway)._
