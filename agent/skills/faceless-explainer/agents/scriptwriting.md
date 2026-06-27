# Subagent Prompt: scriptwriting (Phase 2)

**INPUT:** `<PROJECT_DIR>/capture/extracted/visible-text.txt` (the user's arbitrary input text — article / notes / topic / brief; this is the narrative source of truth). There is **no** `design-system/` to read at this phase — it is built _after_ you return, from the `stylePreset` you pick.
**OUTPUT:** `<PROJECT_DIR>/narrator_scripts.json` (includes the top-level `stylePreset` you pick + the `orientation` you echo from dispatch)
**TOOLS:** Read · Bash
**DONE:** Validator exit 0, report structure / scene count / total duration, append to `<PROJECT_DIR>/context.log`

You are the **faceless-explainer** Phase 2 subagent. Read `<SKILL_DIR>/phases/scriptwriting/guide.md`, follow its process to **pick a style preset** (the guide's preset menu), choose an explainer structure, segment the input text into scenes, design each scene's narrative intent + transition, and write `narrator_scripts.json`. Explainer-structure detail pages are under `<SKILL_DIR>/phases/scriptwriting/structures/<name>/`.

**Path contract:** Run Bash through a `(cd "$PROJECT_DIR" && ...)` subshell.

**Input constraints:**

- `capture/extracted/visible-text.txt` is the **only narrative source**: the user's raw input text. There is **no** `context_pack.md`, **no** capture/assets, **no** asset inventory, **no** screenshots — this is a faceless explainer; downstream visuals are invented typography / abstract graphics / diagrams / data-viz, not captured assets. Read the whole text once, then restructure it into a narrative arc (do not follow the text's paragraph order; see the guide).
- **You pick the `stylePreset`** — one of the 5 shipped presets (`block-frame` / `capsule` / `claude` / `pin-and-paper` / `scatterbrain`; see the guide's preset menu) — from the input's subject + tone, emit it as a top-level field, and match the narration register to it. Default to `pin-and-paper` when nothing clearly fits. There is **no** `design-system/` (no `inference.json`, no `design.html` / `chunks/`) to read at this phase — it is built _after_ you return, from your `stylePreset`. Do **not** run any build step yourself.
- **Emit the top-level `orientation`** exactly as the dispatch's `Orientation:` line gives it — `landscape` (default), `portrait`, or `square`. This is **dictated by the user's chosen aspect, not a creative choice**: copy it verbatim, do not infer or change it. prep reads it to set the canvas (portrait → 1080×1920); omitting it falls back to landscape. If the dispatch has no `Orientation:` line, use `landscape`.
- **`assetCandidates` is `[]` for every scene by default.** FE is faceless: there are no real assets to name. Only emit a `{path, description}` entry when the user **explicitly provided a real image placed in `public/`** — then use `"public/<basename>"`. Do not invent asset paths.
- Do not generate derived files.
- Scenes must not contain `voicePath` / `voiceDuration` / `captions[]` fields (`<em>/<brand>/<emph>/<cta>` in `script` are stripped for TTS).

## Self-Check Before Reporting Done

The `Schema validator:` provided by dispatch is an absolute path. After writing, run it directly (**do not read the script source**):

```bash
(cd "$PROJECT_DIR" && node <validator-path> ./narrator_scripts.json)
```

Iterate until it exits 0. See the `narrator_scripts.json — canonical schema` chapter in the guide for the full schema.

## Report After Completion

- Selected explainer structure (one of: concept-explainer / how-to-process / listicle / story-explainer, or a `"<outer> with <inner>"` compound)
- Chosen `stylePreset` (one of the 5 shipped presets) + one-line rationale
- Scene count + total estimated duration
- One summary line for each scene (`sceneNumber` + `sceneName` + 8-word gist)

Append to `<PROJECT_DIR>/context.log` (generate the timestamp with the machine in UTC; do not hand-write it):

```bash
(cd "$PROJECT_DIR" && cat >> context.log <<EOF

## scriptwriting [done $(date -u +%Y-%m-%dT%H:%M:%SZ)]
Structure: <name>
Style: <stylePreset>
Orientation: <orientation>
Scenes: <count>, total ~<duration>s
EOF
)
```
