# Requirements & Caches

Each command downloads its own model on first run and caches it under `~/.cache/hyperframes/`:

- **TTS (HeyGen)** — no local deps; needs a HeyGen credential + `ffmpeg` on PATH (to transcode the mp3 response to `.wav`). Credential resolves like the CLI: `$HEYGEN_API_KEY` → `$HYPERFRAMES_API_KEY` → `~/.heygen/credentials` (shared with heygen-cli; run `hyperframes auth login`). An OAuth login is sent as `Authorization: Bearer`; an API key as `X-Api-Key`.
- **TTS (ElevenLabs)** — same as HeyGen: API key + `ffmpeg`.
- **TTS (Kokoro)** — Kokoro-82M (~311 MB) + voices (~27 MB) in `tts/`. Requires Python 3.8+ with `kokoro-onnx` and `soundfile` (`pip install kokoro-onnx soundfile`). Non-English text also needs `espeak-ng` system-wide.
- **BGM (Lyria)** — needs `$GEMINI_API_KEY` or `$GOOGLE_API_KEY` + `pip install google-genai`. No local model cache.
- **BGM (MusicGen)** — `pip install transformers torch soundfile`. `facebook/musicgen-small` (~300 MB) cached under `~/.cache/huggingface/` on first run.
- **Transcribe** — Whisper model size depending on choice (75 MB – 3.1 GB) in `whisper/`. Bundles `whisper.cpp`.
- **Remove-background** — `u2net_human_seg` (~168 MB ONNX) in `background-removal/models/`. Peak inference RAM ~1.5 GB.

Run `npx hyperframes doctor` if a command fails because of a missing dependency.
