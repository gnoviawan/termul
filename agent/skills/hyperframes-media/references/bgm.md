# Background Music

`npx hyperframes bgm --duration <s>` generates a stereo WAV from a mood prompt. Auto-detects between Google Lyria (cloud) and MusicGen (local).

## Provider chain

| Order | Provider                             | Env / deps                                                          | Speed                                                   | Quality                                                    |
| ----- | ------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| 1     | Google Lyria RealTime                | `$GEMINI_API_KEY` or `$GOOGLE_API_KEY` + `pip install google-genai` | Real-time stream (≈ requested duration)                 | Production-grade, BPM / brightness / density / scale knobs |
| 2     | MusicGen (`facebook/musicgen-small`) | Python `transformers + torch + soundfile` (~300 MB on first run)    | Slow on CPU (minutes); fast on Apple Silicon MPS / CUDA | Decent; coarser controls (prompt only)                     |

Override with `--provider lyria|musicgen`. If neither path is available the command exits 1 with a clear message — callers decide whether to proceed without BGM.

```bash
# Auto (Lyria if a Google key is set)
npx hyperframes bgm --duration 30 -o bgm.wav

# Pin a provider
npx hyperframes bgm --duration 60 --provider musicgen -o bgm.wav

# Explicit mood
npx hyperframes bgm --duration 45 --prompt "Calm cinematic, soft strings, BPM 95" -o bgm.wav

# Infer mood from a script (industry-keyword match)
npx hyperframes bgm --duration 45 --from-file narrator_scripts.json -o bgm.wav

# Lyria tuning
npx hyperframes bgm --duration 30 --prompt "..." --bpm 95 --scale MINOR --brightness 0.6 --density 0.4
```

## Mood inference (`--from-file`)

Pass any text file (narrator script, script blob, JSON dump). The CLI scans the lowercased content against industry keywords and picks a prompt:

| Match                                                     | Default prompt                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `saas / api / cloud / developer / platform / sdk / infra` | `Uplifting corporate tech, bright and modern, gentle piano with synth pads, BPM 110, MAJOR` |
| `crypto / nft / web3 / defi / token / blockchain`         | `Atmospheric electronic, deep bass, futuristic synths, restrained percussion, BPM 100`      |
| `creative / agency / design / studio / art / brand`       | `Playful electronic, warm pads, light percussion, BPM 115, MAJOR`                           |
| `finance / fintech / bank / payment / invest / wealth`    | `Calm cinematic, soft strings, restrained percussion, BPM 95`                               |
| _(default)_                                               | Same as `saas`                                                                              |

`--prompt` always wins over `--from-file`.

## Lyria knobs

- `--bpm` 90–110 calm, 110–130 energetic (default 110)
- `--brightness` 0–1, ≥ 0.7 for promotional (default 0.8)
- `--density` 0–1, higher = fuller mix (default 0.5)
- `--scale` `MAJOR` upbeat / `MINOR` somber / `PENTATONIC` / etc. (default `MAJOR`)
- `--negative-prompt` styles to exclude (e.g. `"vocals, drums"`)

MusicGen ignores all of the above — pass the mood you want directly in `--prompt`.

## Output

48 kHz / 16-bit stereo WAV at the requested duration (Lyria; MusicGen returns 32 kHz mono). Lyria writes silence-padded if the stream timeouts; check the printed `durationSeconds` against your target.

## Failure modes

| Failure                                                                 | Behavior                                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `$GEMINI_API_KEY` / `$GOOGLE_API_KEY` unset **and** Python deps missing | Exit 1 with install hint (`pip install transformers torch soundfile` or set `$GEMINI_API_KEY`). |
| Lyria API error                                                         | Exit 1 with stderr tail. Re-run with `--provider musicgen` to fall back.                        |
| MusicGen OOM on CPU                                                     | Reduce `--duration` (each second ≈ 50 tokens; ~10 GB peak for 30 s on CPU).                     |

BGM generation is **synchronous** in the CLI — for multi-minute renders, run it in the background (`&` in shell, or your agent harness's background-execution option).
