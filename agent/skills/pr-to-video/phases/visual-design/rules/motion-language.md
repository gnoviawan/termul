---
name: video-motion-language
description: "Motion design decisions for HyperFrames videos — spring intents, beat structure, hold times, stillness-before-climax, transition vocabulary. GSAP eases, exact ms/frames, ease curves, and JS code live in build agent territory (/hyperframes-animation)."
category: visual-design
---

# Video Motion Language - Design-Judgment Layer

Plan-layer only — spring intent, beat structure, holds, transition vocabulary. GSAP ease names, ms/frame mapping, and stagger formulas are build-agent territory (`chunks/easings.js`). Plan references by **intent role** (`EASE.entry` / `EASE.emphasis` / `EASE.exit`, `DUR.snap` / `DUR.med` / `DUR.slow`; actual keys vary by preset).

## Spring Intent (by role, not curve)

HyperFrames uses GSAP. The table below is the **intent** vocabulary for plans; the build agent uses `/hyperframes-animation` to translate intent into concrete GSAP ease + duration:

| Intent     | Feel                                        | Use case                                        |
| ---------- | ------------------------------------------- | ----------------------------------------------- |
| **entry**  | confident slight overshoot, settles quickly | primary element entry (default)                 |
| **gentle** | soft slide-in, no overshoot                 | background elements, subtle motion              |
| **snappy** | tight overshoot, nearly instant             | UI elements, small icons, buttons               |
| **heavy**  | weighted deceleration                       | large type blocks, diagram panels, hero visuals |
| **slam**   | bouncy overshoot, intentionally loud        | logo / bell / impact moments                    |

**Consistency rule:** similar elements share the same intent. In one scene, all icons are `snappy`, all hero images are `heavy`. **Do not** invent a unique ease + duration for every element.

## Forbidden

- **`bounce.out` / `elastic.out`** - feels dated and pulls attention away from content. Real objects decelerate smoothly; they do not bounce. Low overshoot for `entry` intent (archive typical back.out 1.4-1.7) is OK; higher overshoot is reserved for clearly playful moments.
- **Unique ease + duration per element** - visual noise.

## Duration Intent (100 / 300 / 500 / 800 concepts)

Plan references by **intent tier** ("instant feedback", "state change", "layout change", "entry animation"); the build agent maps concrete ms / frames at 30fps using `/hyperframes-animation`.

- **Instant feedback** - micro-interaction, state flash
- **State change** - element entry, icon swap
- **Layout change** - scene entry, major transition
- **Entry animation** - hero reveal, opening sequence

**A single entry should not exceed ~800ms.** If you need a longer buildup, use multi-element stagger instead of lengthening one element.

## Exit = 75% of Entry

Exit animation is about 75% of entry duration (not 50%, not 100%). Arrival is deliberate; departure is swift but not abrupt.

- Exit too fast -> flash
- Exit = entry -> sluggish, blocks the next scene

This is a rule the plan can name in prose; the build agent computes concrete frames.

> Cut-the-curve deliberately reverses the ratio (entry ~127% of exit length) - entry takes longer to clear blur. This is the signature transition exception; plan only needs to cite the transition name.

## Stagger Total Cap

When staggering N elements, **total stagger duration <= 500ms** (much longer feels dragged out). Concrete formula (`(N-1) × per-item delay`) and the strategy "stagger the first 6-8, enter the rest with the last item" are build work; plan only needs to know:

- **3-7 elements** - normal stagger, total 300-700ms
- **8+ elements** - tighten per-item delay, or stagger only the first few
- **Never let stagger continue past 500ms**

## Beat Structure (core plan tool)

Rhythmic videos have beats: tension -> release -> tension -> release. The cleanest archive reference is playground-launch's 46-second plan:

| Phase              | Duration | Rhythm               | Scene type                         |
| ------------------ | -------- | -------------------- | ---------------------------------- |
| **Slow setup**     | 6-10s    | slow build           | hero establish, VO not yet present |
| **Fast montage**   | 6-10s    | ~2s each             | cut-the-curve every 1.5-2s         |
| **Process reveal** | 12-18s   | continuous no cut    | screen recording, real workflow    |
| **Closure**        | 3-5s     | still and breathable | logo, URL, CTA                     |

**Allocate motion by energy inside each scene:**

- **High-energy scenes** (hook, CTA) - faster entry, tighter stagger, `snappy` spring
- **Breathable scenes** (brand reveal, emotional beat) - slower entry, `gentle` spring, longer hold
- **Data scenes** (statistic, feature) - medium rhythm, clean stagger, count-up

## Hold Time

After an element enters, it must hold long enough to be read. Plan references minimum hold by **content type** (build maps concrete frames):

| Content                              | Minimum hold intent |
| ------------------------------------ | ------------------- |
| display text (1-3 words)             | ~1s                 |
| short sentence                       | ~1.5s               |
| data / statistic                     | ~1.5s               |
| hero graphic / chart                 | ~2s                 |
| complex visual (diagram, comparison) | ~2.5s               |
| hero / climax word                   | ~1-1.4s             |

Narration duration shorter than needed hold -> extend the scene to fill time.

## "Stillness Before Climax" Beat

Archive signature: leave a **0.3-0.75s pause** between the major action and confirmation/result. This silence creates narrative tension before the landing. **Allocate it to 2-3 scenes per film (named in `## Film Direction`), where the narration lands a payoff** - stamped on every scene it stops being a comma and becomes a tic, and the film's rhythm flattens.

- Icons collapse at 2.2s, but demo does not pop out until 2.95s (0.75s gap)
- Step 3 activates at 3.33s, button enters at 3.52s (0.19s buffer)
- "Hold on a final frustrated beat: cursor still, chat full, SFX slightly off-rhythm"

**Plan must explicitly schedule this beat in the allocated scenes** - name `stillness-before-climax` in that scene's choreography prose. An allocated scene that jumps directly from action to result loses the dramatic comma; a non-allocated scene that adds one anyway dilutes it.

## Motion Budget — One Macro Move, Few Live Elements

A real camera gives footage **globally correlated motion**: the lens drifts and every layer moves together, differentiated only by depth. Viewers read correlated motion as _someone is filming this_; they read many small independent motions as _UI animation / screensaver_. So the unit of "aliveness" is the **scene**, not the element — and **over-amplitude ambient motion is the more common failure**: visible drift in every scene reads as "the whole video is shimmering," especially across 5+ consecutive scenes or any single scene whose idle phase runs > 6s. Per scene the plan budgets:

1. **ONE macro motion (required)** - a camera-style move on the scene root: slow drift, dolly in/out, push, parallax pan. This alone keeps every visible element moving, coherently, for the whole beat.
2. **At most 1-2 secondary live elements** - chosen from the menu below, on the elements that carry the beat (the hero, the CTA), at the subtle-default amplitudes.
3. **Everything else rests.** Stillness is a tool, not a failure: composition.md lists "one element moving vs all else static" as a strong hierarchy contrast - if everything moves, motion stops carrying information. Prefer the macro move + depth parallax over multiple independent floats; do not give every icon its own oscillator.

Secondary-slot menu (concrete formulas and code are build work):

| Pattern                      | Use case                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Settle and hold**          | closing beats, post-climax tails, the final 25-40% of any scene > 12s (default when nothing else applies) |
| **Slow drift**               | a single isolated hero element                                                                            |
| **Sine float**               | one decorative cluster at most (counter-phase to avoid sync; not three+ concurrent)                       |
| **Multiplicative breathing** | the single focal hero (±1-2% scale on final transform, **not yoyo**)                                      |
| **Rotational drift**         | 3D cards / hero logo (≤ ±0.5°)                                                                            |
| **Orbit**                    | surrounding icons (counts as the scene's one decorative cluster)                                          |
| **Glow pulse**               | CTA / click target                                                                                        |
| **Halftone breathing**       | atmospheric / background scenes (density deforms with beat)                                               |

**Default amplitude (the subtle floor — write this in prose unless a stronger amplitude is justified):**

- Y translation: **±2-3 px**
- Scale breath: **±1-2%**
- Rotation: **±0.3-0.8°** (rarely needed)
- Cycle period: **2.5-4s per breath** (slower = calmer; under 2s reads as fidgeting)

**Reach for the higher end** (±4-6 px / ±3-5% / ±1-3°) **only when:**

1. The element is **alone on canvas** (single hero, no competing motion).
2. The scene is **short** (< 6s, finishes before idle fully settles in).
3. The brief explicitly asks for "kinetic" / "playful" / "energetic" register.

**Scaling rules (hard):**

- **Idle phase > 30% of scene duration → halve every amplitude.** A 17-second scene with 6.5s of `sine-wave-loop` idle ≠ a 6-second scene with 1.5s of idle. Long idle at default amplitude = the eye exhausts and the viewer reads "the whole composition is fidgeting."
- **N ≥ 2 concurrent drifting elements → per-element amplitude ≤ default / √N.** Three columns each at ±6px = effectively ±18px of competing motion. Three at ±2-3px reads as one collective breath.
- **Across the film: ≤ 2 consecutive scenes carry sustained drift.** The third should `settle and hold` for ≥ 60% of its duration so drift reads as deliberate, not pervasive.

**Multiplicative breathing** stays the signature treatment for a hero **that holds a live slot** — not a default stamped on every hero in every scene. **Forbid** yoyo tweens (they overwrite entry scale). Concrete formula (`scale = final * (1 + Math.sin(t * freq) * amp)`, `onUpdate` reads `tl.time()`) is build work — the `/hyperframes-animation` `sine-wave-loop` rule has a ready-to-paste "settle and fade" envelope for long idle. The budget caps how many things move; it does not license invisible motion.

**Anti-pattern: "fill the idle with drift."** When a scene runs much longer than the narrator estimated (audio drift > 50% — `prep.mjs` warns on these), the temptation is to stretch ambient motion across the entire tail. Don't. Add **one more active beat** (a glow re-pulse, a number tick, a chip reveal) at the 60-70% mark to give the eye somewhere new to land, then `settle and hold` until the transition.

## Transition Vocabulary - Use Only 2-3 Across the Film

Inter-scene transitions follow a limited vocabulary. Choose only 2-3 and repeat them - repetition creates professional cohesion. Cleanest archive reference: playground-launch uses **only cut-the-curve** across 8 distinct visual universes, which is what makes the film cohere.

> **These 2-3 slots count only Tier-B transitions on `break` boundaries** (choose 2-3 from crossfade / blur-crossfade / push-slide / zoom-through / squeeze). `shared-element` (morph, Tier-A) is a shared-element bridge hand-written by the worker inside two scenes, **not part of this vocabulary and not counted** - it is driven by narrative `intent: morph`, and may be used freely where the story needs it (e.g. several morph pairs in a demo sequence).

### Cut-the-curve (archive signature; default for most cases)

Current scene blurs + slides out -> next scene blurs + slides in. Both sides use the same blur magnitude; direction alternates across seams (right -> left -> up -> down); background triggers slightly before foreground content; internal reveals occur after the stage settles. Plan only names direction ("cut-the-curve LEFT"); concrete 0.33s / 0.42s / 8-10px blur is build work.

### Scale + fade (zoom-through)

One scene fades while pulling toward frame center; camera pushes forward into the next headline.

### Slide

Directional slide (matches narrative flow), optionally with parallax.

### Morph (strongest narrative seam)

Shared element transforms between scenes (phone cluster -> circular avatar = scale + borderRadius tween).

### Hard cut

Instant opacity flip, used for high-energy moments (grid appears fully filled with no build-in). **Use sparingly** - cut-the-curve is default; hard cuts are reserved for type/tone shifts.

**Plan must name a transition for every scene** - it determines Continuity for the next scene (see guide.md "Hard Contracts"):

- `hard cut` / `jump cut` -> Continuity `break`
- `cut-the-curve` / `morph` / `scale+fade` on the same material -> Continuity `continue`

## Plan Reference Example

> "Macro motion: slow dolly-in on the scene root across the whole beat. Multi-phase: hero enters on `EASE.entry` (heavy intent) -> icons enter with snappy stagger (5 items, total stagger ~400ms), then rest -> **stillness-before-climax 0.6s** (allocated scene; cursor still, only the dolly continues) -> result emphasis: text gentle entry + double-layer glow -> idle hold, hero breathing ±1% as the one live element."

Do not write concrete ease curve names / ms values / stagger formulas / JS code.
