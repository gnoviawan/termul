# Audio (Phase 2.5) - workflow guide

Phase 2.5 is handled end-to-end by **`scripts/audio.mjs`**: `narrator_scripts` -> per-scene voice + word JSON + `audio_meta.json`, plus optional detached BGM. In Step 3, the orchestrator runs `node audio.mjs` directly; there is **no subagent**. Force a provider with `--provider <name>`; override the BGM mood with `--bgm-prompt "<text>"`. For the full flag list, see SKILL.md Step 3 / `audio.mjs --help`. This file only describes the schema and failure modes.

## BGM backend selection (cloud Lyria → local MusicGen fallback)

`audio.mjs` Step 5b picks a backend by what can **actually run**, not just by config:

1. **Lyria (cloud)** — chosen only when `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set, `--lyria-recipe` exists, **and** `import google.genai` succeeds. If the key+recipe are present but the package is missing, audio.mjs runs `pip install google-genai python-dotenv` on demand (background, parallel with TTS) and re-probes.
2. **MusicGen (local)** — the fallback whenever Lyria can't run (no key, missing recipe, or google-genai still not importable). `facebook/musicgen-small` via `transformers`; deps (`transformers torch soundfile numpy`) auto-install in the background. No API key, no network at generation time once the model is cached.
3. **Skipped** — only when neither backend can be made to run (e.g. no network for pip). Voice + SFX still render.

Selecting Lyria on config alone (key present but `google-genai` not installed) used to launch a doomed detached process that crashed with `ModuleNotFoundError: No module named 'google'` and **never fell back** — leaving the video with no BGM. The probe + fallback above is the fix; `--no-bgm` still disables BGM entirely.

## Artifacts

```
./audio_meta.json                       # index for prep.mjs (PROJECT_DIR root)
assets/voice/scene_<N>.wav              # per-scene narration (PROJECT_DIR/assets/, no hyperframes/ subdirectory)
assets/voice/scene_<N>_words.json       # per-scene word-level timestamp JSON
assets/bgm.wav                          # BGM (optional; may not be written yet when audio.mjs exits)
```

`audio_meta.json` schema (consumed by `prep.mjs`):

```json
{
  "tts_provider": "heygen" | "elevenlabs" | "kokoro",
  "voice_id": "<provider-specific voice id>",   // actual TTS voice id used (top-level)
  "bgm_provider": "lyria" | "musicgen" | null,
  "bgm_enabled": true | false,
  "bgm_pending": true | false,        // detached BGM may still be rendering; Step 7 wait-bgm.mjs verifies it
  "bgm_path": "assets/bgm.wav" | null,
  "bgm_log": "<private mkdtemp dir>/bgm-<timestamp>.log" | null,
  "bgm_pid": 12345 | null,
  "bgm_mode": "detached-single" | "detached-seed-loop" | "detached-seed-trim" | null,
  "bgm_target_duration_s": 62.4 | null,  // BGM target duration (= measured total voice duration; trim/loop to this)
  "bgm_seed_duration_s": 28 | null,    // MusicGen: single seed clip length (<=30s to avoid the positional-encoding limit)
  "bgm_loop_count": 3 | null,          // number of seed crossfade-loop tiles needed to reach target duration (1 when trimming)
  "total_duration_s": <sum of measured voice durations for successful scenes (failed scenes excluded)>,
  "scenes": {
    "scene_1": {
      "voicePath": "assets/voice/scene_1.wav",
      "voiceDuration": 4.823,
      "wordsPath": "assets/voice/scene_1_words.json"
    },
    "scene_2": { ... }
  }
}
```

See the `hyperframes-media` skill for the underlying capability documentation.

## Failure Modes

| Failure                  | Behavior                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Single scene TTS exits 1 | That scene is omitted from `audio_meta.scenes`; the rest continue. Phase 4a falls back to `group_spec` `estimatedDuration_s` (from `narrator_scripts.estimatedDuration`).            |
| BGM pending              | `bgm_enabled: true` + `bgm_pending: true`. Step 7 runs `wait-bgm.mjs` first, and mounts track 11 only when ready.                                                                    |
| BGM exits 1              | `wait-bgm.mjs` produces `bgm_status.json { status: "failed" }` during Step 7 finalize (this phase does not produce it); voice is complete, and Phase 4c skips the `<audio>` element. |
| All scenes fail          | `audio.mjs` exits 1, reports an error on stderr, and the pipeline stops.                                                                                                             |

BGM failure never blocks; only "zero scenes received voice" is fatal.
