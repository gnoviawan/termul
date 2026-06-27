#!/usr/bin/env node
// Phase 2.5 — audio (deterministic replacement for the audio subagent).
//
// Reads:  narrator_scripts.json (Phase 2).
// Writes: assets/voice/scene_*.wav, assets/voice/scene_*_words.json,
//         ./audio_meta.json, and (eventually) assets/bgm.wav inside the
//         HyperFrames project root passed via --hyperframes.
//
// Performance contract:
//   * Per-scene TTS is chained into per-scene transcribe (a scene's whisper run
//     starts the moment its own TTS finishes — does NOT wait for sibling scenes).
//   * BGM (Lyria) is spawned **detached** in parallel with voice work. This
//     script exits as soon as voice + transcribe are done; BGM keeps rendering
//     in the background. audio_meta.json sets `bgm_pending: true` so prep.mjs
//     trusts the path and Phase 4c runs wait-bgm.mjs before assemble/render.
//   * Local MusicGen fallback generates ONE ~28s seed clip (one generate()
//     call, kept under the model's ~30s positional limit), then trims it down
//     if the target is shorter, or loops it with short crossfades up to the
//     target length. This avoids the seams of the old per-segment concatenation.
//
// BGM prompt inference: the script reads concatenated `script` + `keyMessage`
// fields from narrator_scripts.json (no tokens.json side file — Phase 1
// hyperframes capture writes asset/section data into capture/extracted/
// which this script doesn't need). Override with --bgm-prompt "..." if the
// auto-inferred mood is wrong.
//
// Usage:
//   node audio.mjs \
//     --narrator-scripts ./narrator_scripts.json \
//     --hyperframes . \
//     --out ./audio_meta.json \
//     [--lyria-recipe <SKILL_DIR>/phases/audio/lyria-recipe.py] \
//     [--voice <id>] [--lang en] \
//     [--provider heygen|elevenlabs|kokoro] \
//     [--no-bgm] [--bgm-prompt "<custom prompt>"] \
//     [--bgm-seed-seconds 28]

import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { scratchPath } from './lib/scratch-dir.mjs'

// ---------- argv ----------
const argv = process.argv.slice(2)
function flag(name, def) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return def
  if (i + 1 >= argv.length) return true
  const v = argv[i + 1]
  return v.startsWith('--') ? true : v
}
function die(msg) {
  console.error(`✗ audio.mjs: ${msg}`)
  process.exit(1)
}

const narratorPath = resolve(flag('narrator-scripts', './narrator_scripts.json'))
const hyperframesDir = resolve(flag('hyperframes', '.'))
const outPath = resolve(flag('out', './audio_meta.json'))
const lyriaRecipe = flag('lyria-recipe') ? resolve(flag('lyria-recipe')) : null
const userVoice = typeof flag('voice') === 'string' ? flag('voice') : null
const userBgmPrompt = typeof flag('bgm-prompt') === 'string' ? flag('bgm-prompt') : null
const noBgm = flag('no-bgm') === true
const userProvider = typeof flag('provider') === 'string' ? flag('provider') : null
const lang = typeof flag('lang') === 'string' ? flag('lang') : 'en'
// Seed length for the local MusicGen path: generate ONE clip this long, then
// loop-with-crossfade up to the target (or trim down if the target is shorter).
// musicgen-small's positional limit is ~1500 tokens ≈ 30s, so we cap at 28s
// (1400 tokens) to keep a safety margin and avoid `IndexError: index out of range`.
const bgmSeedSecondsRaw =
  typeof flag('bgm-seed-seconds') === 'string' ? Number(flag('bgm-seed-seconds')) : 28
const bgmSeedSeconds =
  isFinite(bgmSeedSecondsRaw) && bgmSeedSecondsRaw > 0
    ? Math.min(Math.max(bgmSeedSecondsRaw, 10), 30)
    : 28

// ---------- load .env ----------
// Mirrors the CLI's loadEnvFile (packages/cli/src/capture/scaffolding.ts):
// walk up from hyperframesDir ≤ 5 dirs, first .env wins, shell env always
// takes priority (we never override an already-set key).
function loadEnvFromDir(startDir) {
  let dir = resolve(startDir)
  for (let i = 0; i < 5; i++) {
    const envPath = join(dir, '.env')
    if (existsSync(envPath)) {
      const txt = readFileSync(envPath, 'utf8')
      for (const raw of txt.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const key = line.slice(0, eq).trim()
        let val = line.slice(eq + 1).trim()
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1)
        }
        if (key && !(key in process.env)) process.env[key] = val
      }
      return
    }
    const parent = resolve(dir, '..')
    if (parent === dir) return
    dir = parent
  }
}
loadEnvFromDir(hyperframesDir)

// ---------- resolve HeyGen credential ----------
// Mirrors the hyperframes CLI (packages/cli/src/auth: resolver.ts + store.ts +
// client.ts#buildAuthHeaders). First usable source wins:
//   1. $HEYGEN_API_KEY        → X-Api-Key
//   2. $HYPERFRAMES_API_KEY   → X-Api-Key  (alias)
//   3. ~/.heygen/credentials  (shared with heygen-cli / `hyperframes auth login`;
//                              $HEYGEN_CONFIG_DIR overrides the dir):
//        oauth (unexpired) → Authorization: Bearer  ·  else api_key → X-Api-Key
//        ·  legacy single-line plaintext key → X-Api-Key
// Pure resolution (never throws); returns { headers } | { expired: true } | null.
function heygenCredential() {
  const envKey = process.env.HEYGEN_API_KEY || process.env.HYPERFRAMES_API_KEY
  if (envKey) return { headers: { 'X-Api-Key': envKey } }

  const file = join(process.env.HEYGEN_CONFIG_DIR || join(homedir(), '.heygen'), 'credentials')
  if (!existsSync(file)) return null
  const raw = readFileSync(file, 'utf8').trim()
  if (!raw) return null
  if (!raw.startsWith('{')) return { headers: { 'X-Api-Key': raw } }

  const cred = JSON.parse(raw)
  const oauth = cred.oauth
  if (oauth?.access_token) {
    const expired = oauth.expires_at && new Date(oauth.expires_at).getTime() - 60_000 < Date.now()
    if (!expired) return { headers: { Authorization: `Bearer ${oauth.access_token}` } }
    if (!cred.api_key) return { expired: true }
  }
  if (cred.api_key) return { headers: { 'X-Api-Key': cred.api_key } }
  return null
}

// Headers for the HeyGen REST calls, or a clear error pointing at the fix.
function heygenAuthHeaders() {
  const cred = heygenCredential()
  if (cred?.headers) return cred.headers
  if (cred?.expired)
    die('HeyGen OAuth token expired — run `hyperframes auth refresh` (or `hyperframes auth login`)')
  die(
    'no HeyGen credentials — set $HEYGEN_API_KEY, or run `hyperframes auth login` (writes ~/.heygen/credentials)'
  )
}

// ---------- Step 1: bootstrap HyperFrames project root ----------
if (!existsSync(hyperframesDir)) {
  console.log(`HyperFrames project root missing → npx hyperframes init ${hyperframesDir}`)
  const r = spawnSync(
    'npx',
    [
      'hyperframes',
      'init',
      hyperframesDir,
      '--example',
      'blank',
      '--non-interactive',
      '--skip-skills'
    ],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) die('npx hyperframes init failed')
}
const voiceDir = join(hyperframesDir, 'assets', 'voice')
mkdirSync(voiceDir, { recursive: true })

// ---------- Step 2: read inputs ----------
if (!existsSync(narratorPath)) die(`narrator_scripts.json not found at ${narratorPath}`)
const narrator = JSON.parse(readFileSync(narratorPath, 'utf8'))

// story-design agents may embed inline tags in the script field: <em>...</em>,
// <brand>...</brand>, <emph>...</emph>, <cta>...</cta>. These are creative-time
// annotations only — the Phase 4a.5 captions agent does NOT consume them
// (captions are derived directly from whisper word JSON). audio.mjs strips
// them before TTS so the provider doesn't speak the tag names. The strip is
// conservative: only known tag names; unknown markup is passed through (the
// agent would have to face the TTS pronouncing it).
const CAPTION_TAG_RE = /<\/?(em|brand|emph|cta)\b[^>]*>/gi
function stripCaptionTags(s) {
  return String(s).replace(CAPTION_TAG_RE, '')
}

const scenes = (narrator.scenes || []).map((s) => {
  const dm = String(s.estimatedDuration ?? '0').match(/[\d.]+/)
  return {
    sceneNumber: s.sceneNumber,
    sceneId: `scene_${s.sceneNumber}`,
    script: stripCaptionTags(typeof s.script === 'string' ? s.script : ''),
    estimatedDuration: dm ? parseFloat(dm[0]) : 0
  }
})
if (scenes.length === 0) die('no scenes in narrator_scripts.json')
for (const s of scenes) {
  if (!s.script.trim()) die(`${s.sceneId}: empty "script" field in narrator_scripts.json`)
}

// BGM-inference corpus: concatenate every scene's narrative metadata so we can
// look for category keywords (SaaS / crypto / creative / fintech / etc.) and
// pick a matching Lyria prompt. Replaces the old tokens.json-based inference.
const bgmInferenceBlob = (() => {
  const parts = [
    narrator.project || '',
    narrator.narrativeArchetype || '',
    narrator.emotionalArc || ''
  ]
  for (const s of narrator.scenes || []) {
    parts.push(s.sceneName || '')
    parts.push(stripCaptionTags(s.script || ''))
    if (s.narrativeIntent) {
      parts.push(s.narrativeIntent.narrativeRole || '')
      parts.push(s.narrativeIntent.keyMessage || '')
    }
  }
  return parts.join(' ').toLowerCase()
})()

// ---------- Step 3: provider detection ----------
// Self-contained selection (no dependency on CLI provider plumbing):
//   heygen     ← $HEYGEN_API_KEY / $HYPERFRAMES_API_KEY / ~/.heygen/credentials
//                (cloud REST, returns word timestamps; see synthesizeHeygen / heygenCredential)
//   elevenlabs ← $ELEVENLABS_API_KEY + `pip install elevenlabs` (inline python)
//   kokoro     ← always (local, no key; via published `hyperframes tts`)
function heygenAvailable() {
  return heygenCredential() !== null
}
function elevenlabsAvailable() {
  if (!process.env.ELEVENLABS_API_KEY) return false
  const r = spawnSync('python3', ['-c', 'import elevenlabs'], {
    stdio: 'ignore'
  })
  return r.status === 0
}
// Lyria accepts either GEMINI_API_KEY or GOOGLE_API_KEY (OR-fallback).
function lyriaKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''
}

let provider = userProvider
if (!provider) {
  provider = heygenAvailable() ? 'heygen' : elevenlabsAvailable() ? 'elevenlabs' : 'kokoro'
}
if (!['heygen', 'elevenlabs', 'kokoro'].includes(provider))
  die(`invalid --provider "${provider}" (must be heygen | elevenlabs | kokoro)`)
if (provider === 'heygen' && !heygenAvailable())
  die(
    'provider=heygen but no HeyGen credentials — set $HEYGEN_API_KEY or run `hyperframes auth login`'
  )
if (provider === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY)
  die('provider=elevenlabs but $ELEVENLABS_API_KEY is not set')

let voiceId =
  userVoice ||
  (provider === 'elevenlabs'
    ? '21m00Tcm4TlvDq8ikWAM' // Rachel (ElevenLabs default)
    : provider === 'kokoro'
      ? lang === 'en'
        ? 'am_michael'
        : die(
            'Kokoro non-English path requires explicit --voice (see /hyperframes-media references/tts.md)'
          )
      : null) // heygen default resolved below — needs a starfish voice_id

// HeyGen's /v3/voices/speech only accepts STARFISH voice_ids; a v2-catalog id
// (the old hardcoded default 1bd001e7…) is rejected with HTTP 400. With no
// --voice, auto-pick the first English public starfish voice.
if (provider === 'heygen' && !voiceId) {
  const vres = await fetch(
    'https://api.heygen.com/v3/voices?engine=starfish&type=public&limit=50',
    {
      headers: heygenAuthHeaders()
    }
  )
  if (!vres.ok) die(`heygen voice list failed (HTTP ${vres.status})`)
  const list = (await vres.json()).data ?? []
  const pick = list.find((v) => v.language === 'English') ?? list[0]
  if (!pick) die('no public starfish voices available — pass --voice')
  voiceId = pick.voice_id
}

// ---------- Step 4: write narration → <scratch>/scene_<N>.txt ----------
for (const s of scenes) {
  writeFileSync(scratchPath(`${s.sceneId}.txt`), s.script)
}

// ---------- Step 4b: pre-flight BGM-deps install (parallel with TTS) ----------
// MusicGen via HuggingFace transformers (no audiocraft / xformers / PyAV — those
// don't build cleanly on Apple Silicon). If Lyria won't be used and deps are
// missing, kick off pip install now so it runs in the background while TTS is
// generating. We await the result in Step 5b before deciding whether to spawn BGM.
const BGM_PY_DEPS = ['transformers', 'torch', 'soundfile', 'numpy']
const BGM_PY_PROBE =
  'import transformers, soundfile, torch, numpy; from transformers import MusicgenForConditionalGeneration'
let bgmDepsInstallPromise = null
if (!noBgm && !(lyriaKey() && lyriaRecipe && existsSync(lyriaRecipe))) {
  const probe = spawnSync('python3', ['-c', BGM_PY_PROBE], { stdio: 'ignore' })
  if (probe.status !== 0) {
    console.log(
      `BGM: deps missing → pip install ${BGM_PY_DEPS.join(' ')} (background, parallel with TTS)…`
    )
    bgmDepsInstallPromise = new Promise((resolve) => {
      const proc = spawn('pip', ['install', '-q', ...BGM_PY_DEPS], { stdio: 'ignore' })
      proc.on('exit', (code) => {
        if (code === 0) console.log('BGM: deps install complete ✓')
        else console.log(`BGM: deps install failed (exit ${code}) — BGM will be skipped`)
        resolve(code === 0)
      })
      proc.on('error', () => resolve(false))
    })
  }
}

// ---------- Step 5: BGM variables + helpers ----------
const bgmRelPath = 'assets/bgm.wav'
const bgmAbsPath = join(hyperframesDir, bgmRelPath)
let bgmEnabled = false
let bgmReason = ''
let bgmPid = null
let bgmMeta = null

function bgmPyDepsAvailable() {
  const r = spawnSync('python3', ['-c', BGM_PY_PROBE], { stdio: 'ignore' })
  return r.status === 0
}

function inferBgmPrompt() {
  if (userBgmPrompt) return userBgmPrompt
  const blob = bgmInferenceBlob

  // --- Industry base ---
  let base, bpm
  if (/\b(crypto|nft|web3|defi|token|blockchain|exchange|wallet|dao)\b/.test(blob)) {
    base = 'atmospheric electronic, deep bass, futuristic synths, restrained percussion'
    bpm = 100
  } else if (/\b(finance|fintech|bank|payment|invest|wealth|insurance|treasury)\b/.test(blob)) {
    base = 'calm cinematic, soft strings, subtle piano, restrained percussion'
    bpm = 92
  } else if (/\b(creative|agency|design|studio|art|brand|marketing|content)\b/.test(blob)) {
    base = 'playful electronic, warm pads, light percussion'
    bpm = 115
  } else {
    // default: SaaS / tech / platform
    base = 'uplifting corporate tech, bright modern piano with synth pads'
    bpm = 108
  }

  // --- Archetype adjusts arc shape ---
  const archetype = (narrator.narrativeArchetype || '').toLowerCase()
  const arc = (narrator.emotionalArc || '').toLowerCase()

  // PAS: starts tense, resolves → build from minor to major feel
  if (/\bpas\b|pain.agitate|pain.+solve/.test(archetype)) {
    return `${base}, starts with subtle tension then builds to resolution, BPM ${bpm}, transitions from MINOR to MAJOR`
  }
  // BAB / Future Pacing: visionary, ascending energy
  if (/\bbab\b|before.after|future.pac|vision/.test(archetype)) {
    return `${base}, cinematic and aspirational, steady build with rising energy, BPM ${bpm}, MAJOR`
  }
  // Feature Cascade: fast momentum, no dip
  if (/cascade|feature.benefit/.test(archetype)) {
    bpm = Math.min(bpm + 10, 128)
    return `${base}, energetic and driving, consistent momentum without slowdown, BPM ${bpm}, MAJOR`
  }
  // Demo Loop: focused, clean, not distracting
  if (/demo.loop|question.+answer/.test(archetype)) {
    bpm = Math.max(bpm - 8, 88)
    return `${base}, clean and focused, minimal arrangement to not distract from UI demo, BPM ${bpm}`
  }

  // --- Emotional arc as tiebreaker ---
  if (/frustrat|anxiety|overwhelm|tension/.test(arc) && /relief|excite|triumph/.test(arc)) {
    return `${base}, builds from understated tension to uplifting resolution, BPM ${bpm}, MINOR to MAJOR`
  }
  if (/excit|awe|power|triumph/.test(arc)) {
    return `${base}, energetic and confident, uplifting throughout, BPM ${bpm}, MAJOR`
  }
  if (/trust|ease|clarity|reassur/.test(arc)) {
    return `${base}, warm and reassuring, gentle momentum, BPM ${Math.max(bpm - 5, 85)}`
  }

  return `${base}, BPM ${bpm}, MAJOR`
}

// ---------- Step 6: per-scene chained TTS → transcribe (parallel across scenes) ----------
function spawnP(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore', ...opts })
    p.on('exit', (code) => resolve({ status: code ?? -1 }))
    p.on('error', () => resolve({ status: -1 }))
  })
}

const ELEVENLABS_PY = `
import os, sys
from elevenlabs.client import ElevenLabs
from elevenlabs import save
client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
text = open(sys.argv[1]).read()
audio = client.text_to_speech.convert(
    text=text,
    voice_id=sys.argv[2],
    model_id="eleven_multilingual_v2",
    output_format="mp3_44100_128",
)
save(audio, sys.argv[3])
`

// HeyGen TTS — inline, no CLI dependency. One REST call to
// api.heygen.com/v3/voices/speech returns audio_url + word_timestamps; we
// download, transcode mp3→wav (44.1k mono), and write the scene's words JSON
// directly from word_timestamps so the whisper pass is skipped (the "single
// call" caption path). Self-contained so the skill needs no provider plumbing
// in the published hyperframes CLI.
const HEYGEN_ENDPOINT = 'https://api.heygen.com/v3/voices/speech'

async function synthesizeHeygen(s) {
  const wordsAbs = join(hyperframesDir, `assets/voice/${s.sceneId}_words.json`)
  const wavAbs = join(hyperframesDir, `assets/voice/${s.sceneId}.wav`)
  try {
    const text = readFileSync(scratchPath(`${s.sceneId}.txt`), 'utf8')
    const reqBody = { text, voice_id: voiceId, speed: 1.0 }
    if (lang !== 'en') reqBody.language = lang
    const res = await fetch(HEYGEN_ENDPOINT, {
      method: 'POST',
      headers: { ...heygenAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    })
    if (!res.ok) return { status: -1 }
    const payload = await res.json()
    const inner = payload.data ?? payload
    if (!inner.audio_url) return { status: -1 }

    const audioRes = await fetch(inner.audio_url)
    if (!audioRes.ok) return { status: -1 }
    const bytes = Buffer.from(await audioRes.arrayBuffer())
    const td = mkdtempSync(join(tmpdir(), `hf-heygen-${s.sceneId}-`))
    const tmpAudio = join(td, 'audio.mp3') // ffmpeg detects true format from content
    writeFileSync(tmpAudio, bytes)
    const ff = spawnSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', tmpAudio, '-ar', '44100', '-ac', '1', wavAbs],
      { stdio: 'ignore' }
    )
    rmSync(td, { recursive: true, force: true })
    if (ff.status !== 0 || !existsSync(wavAbs)) return { status: -1 }

    // word_timestamps → scene_<N>_words.json ([{text,start,end}], scene-local)
    const wts = inner.word_timestamps
    if (Array.isArray(wts)) {
      const words = wts
        .filter((w) => w && typeof w.word === 'string' && isFinite(w.start) && isFinite(w.end))
        // Drop HeyGen's <start>/<end> boundary sentinels (no spoken text).
        .filter((w) => !/^<.*>$/.test(w.word.trim()))
        .map((w) => ({ text: w.word, start: w.start, end: w.end }))
      if (words.length) writeFileSync(wordsAbs, JSON.stringify(words, null, 2))
    }
    return { status: 0 }
  } catch {
    return { status: -1 }
  }
}

async function ttsScene(s) {
  const txt = scratchPath(`${s.sceneId}.txt`)
  const wavRel = `assets/voice/${s.sceneId}.wav`

  // HeyGen: inline REST (see synthesizeHeygen) — also writes the words JSON.
  if (provider === 'heygen') return synthesizeHeygen(s)

  // ElevenLabs: direct python SDK (no CLI dependency).
  if (provider === 'elevenlabs') {
    const wavAbs = join(hyperframesDir, wavRel)
    return spawnP('python3', ['-c', ELEVENLABS_PY, txt, voiceId, wavAbs], {})
  }

  // Kokoro: local model via the published hyperframes CLI.
  const args = ['hyperframes', 'tts', txt, '--voice', voiceId, '--output', wavRel]
  if (lang !== 'en') args.push('--lang', lang)
  return spawnP('npx', args, { cwd: hyperframesDir })
}

async function transcribeScene(s) {
  // `npx hyperframes transcribe` writes a fixed `transcript.json` into its
  // --dir. Parallel scenes would collide if they all wrote into
  // assets/voice/transcript.json, so give each scene its own
  // throwaway --dir and move the result into the canonical name afterwards.
  const wavRel = `assets/voice/${s.sceneId}.wav`
  const model = lang === 'en' ? 'small.en' : 'small'
  const td = mkdtempSync(join(tmpdir(), `hf-trans-${s.sceneId}-`))
  const args = ['hyperframes', 'transcribe', wavRel, '--model', model, '--dir', td]
  if (lang !== 'en') args.push('--language', lang)
  const r = await spawnP('npx', args, { cwd: hyperframesDir })
  if (r.status === 0) {
    const src = join(td, 'transcript.json')
    const dst = join(hyperframesDir, `assets/voice/${s.sceneId}_words.json`)
    if (existsSync(src)) {
      try {
        renameSync(src, dst)
      } catch {
        // cross-device fallback: read+write
        try {
          writeFileSync(dst, readFileSync(src))
        } catch {}
      }
    }
  }
  try {
    rmSync(td, { recursive: true, force: true })
  } catch {}
  return r
}

async function runScene(s) {
  const wordsRel = `assets/voice/${s.sceneId}_words.json`
  const wordsAbs = join(hyperframesDir, wordsRel)
  // Clear any stale words file from a prior run: HeyGen re-writes it from
  // word_timestamps; Kokoro/ElevenLabs leave it absent → whisper writes it.
  rmSync(wordsAbs, { force: true })

  const tts = await ttsScene(s)
  if (tts.status !== 0) return { sceneId: s.sceneId, ttsOk: false }

  // Skip the whisper pass when TTS already produced word timestamps (HeyGen).
  if (!existsSync(wordsAbs)) {
    await transcribeScene(s)
  }

  let wordsNonempty = false
  if (existsSync(wordsAbs)) {
    try {
      const arr = JSON.parse(readFileSync(wordsAbs, 'utf8'))
      wordsNonempty = Array.isArray(arr) && arr.length > 0
    } catch {
      wordsNonempty = false
    }
  }
  return {
    sceneId: s.sceneId,
    ttsOk: true,
    voicePath: `assets/voice/${s.sceneId}.wav`,
    wordsPath: wordsNonempty ? wordsRel : ''
  }
}

console.log(`provider: ${provider}  voice: ${voiceId}  lang: ${lang}`)
console.log(`spawning ${scenes.length} TTS+transcribe pipelines in parallel…`)
const t0 = Date.now()
const results = await Promise.all(scenes.map(runScene))
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`voice work done in ${elapsed}s`)

// ---------- Step 5a: ffprobe voice durations ----------
function ffprobeDuration(path) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) return NaN
  return parseFloat(r.stdout.trim())
}

const scenesMap = {}
const failedScenes = []
let totalDuration = 0
for (const r of results) {
  if (!r.ttsOk) {
    failedScenes.push(r.sceneId)
    continue
  }
  const dur = ffprobeDuration(join(hyperframesDir, r.voicePath))
  if (!isFinite(dur) || dur <= 0) {
    failedScenes.push(r.sceneId)
    continue
  }
  scenesMap[r.sceneId] = {
    voicePath: r.voicePath,
    voiceDuration: parseFloat(dur.toFixed(3)),
    wordsPath: r.wordsPath
  }
  totalDuration += dur
}

if (Object.keys(scenesMap).length === 0) {
  const emptyAudioMeta = {
    tts_provider: provider,
    voice_id: voiceId,
    bgm_provider: null,
    bgm_enabled: false,
    bgm_path: null,
    bgm_pending: false,
    bgm_log: null,
    bgm_pid: null,
    bgm_mode: null,
    bgm_target_duration_s: null,
    bgm_seed_duration_s: null,
    bgm_loop_count: null,
    total_duration_s: 0,
    scenes: scenesMap
  }
  writeFileSync(outPath, JSON.stringify(emptyAudioMeta, null, 2))
  console.error(
    `✗ audio.mjs: zero scenes got voice — wrote audio_meta.json with empty scenes map for orchestrator to decide`
  )
  process.exit(1)
}

const bgmTargetDurationS = Math.max(1, totalDuration)

// ---------- Step 5b: spawn BGM (after TTS — deps install may now be done) ----------
if (bgmDepsInstallPromise) {
  console.log('BGM: waiting for deps install to finish…')
  await bgmDepsInstallPromise
}

if (noBgm) {
  bgmReason = 'disabled by --no-bgm'
} else if (lyriaKey() && lyriaRecipe && existsSync(lyriaRecipe)) {
  // Path A: Lyria (cloud)
  const totalS = bgmTargetDurationS
  const prompt = inferBgmPrompt()
  const log = scratchPath(`bgm-${Date.now()}.log`)
  console.log(`BGM: launching Lyria (detached) — prompt: "${prompt.slice(0, 70)}…"`)
  console.log(`     log: ${log}`)
  const fd = openSync(log, 'w')
  const bgm = spawn(
    'python3',
    [
      lyriaRecipe,
      '--output',
      bgmAbsPath,
      '--duration',
      String(Math.max(1, totalS)),
      '--prompt',
      prompt
    ],
    { detached: true, stdio: ['ignore', fd, fd] }
  )
  bgm.unref()
  closeSync(fd)
  bgmEnabled = true
  bgmPid = bgm.pid
  bgmMeta = {
    provider: 'lyria',
    mode: 'detached-single',
    pid: bgmPid,
    log,
    target_duration_s: Math.max(1, totalS)
  }
} else if (bgmPyDepsAvailable()) {
  // Path B: MusicGen via HuggingFace transformers (local, free, no API key).
  // pip install transformers torch soundfile numpy → facebook/musicgen-small (~300MB).
  // MusicGen emits ~50 codec frames per second, so max_new_tokens ≈ duration_s × 50.
  //
  // Generate ONE seed clip in a single generate() call (kept ≤28s / 1400 tokens
  // to stay under the decoder's ~30s positional limit, which otherwise fails
  // with `IndexError: index out of range`). Then:
  //   * target ≤ seed → trim the seed down (with a tail fade-out), or
  //   * target > seed → loop the seed with short crossfades until we reach the
  //     target, so there are no hard per-segment seams.
  const totalS = bgmTargetDurationS
  const prompt = inferBgmPrompt()
  const log = scratchPath(`bgm-${Date.now()}.log`)
  const targetS = Math.max(1, totalS)
  const seedS = Math.min(bgmSeedSeconds, 30)
  const loops = targetS > seedS ? Math.ceil(targetS / seedS) : 1
  console.log(
    `BGM: launching MusicGen via transformers (detached, local, ${seedS}s seed → ${targetS > seedS ? `crossfade-loop ×${loops}` : 'trim'} → ${targetS.toFixed(1)}s) — prompt: "${prompt.slice(0, 70)}…"`
  )
  console.log(`     log: ${log}`)
  const fd = openSync(log, 'w')
  const script = `
import math
import os
import sys
import traceback
from pathlib import Path

import numpy as np
import soundfile as sf
from transformers import MusicgenForConditionalGeneration, AutoProcessor

prompt = ${JSON.stringify(prompt)}
out_path = ${JSON.stringify(bgmAbsPath)}
target_s = float(${targetS.toFixed(3)})
seed_s = float(${seedS.toFixed(3)})
token_rate = 50
crossfade_s = 0.3

def apply_fade(arr, sr, fade_in_s=0.08, fade_out_s=0.5):
    n_in = min(int(round(fade_in_s * sr)), arr.shape[0] // 2)
    n_out = min(int(round(fade_out_s * sr)), arr.shape[0] // 2)
    if n_in > 1:
        arr[:n_in] *= np.linspace(0.0, 1.0, n_in, dtype="float32")
    if n_out > 1:
        arr[-n_out:] *= np.linspace(1.0, 0.0, n_out, dtype="float32")
    return arr

def loop_crossfade(seed, target_len, xf):
    # Equal-power crossfade the seed onto itself until we cover target_len samples.
    if seed.shape[0] >= target_len:
        return seed[:target_len]
    xf = min(xf, seed.shape[0] // 2)
    if xf < 1:
        reps = int(math.ceil(target_len / seed.shape[0]))
        return np.tile(seed, reps)[:target_len]
    t = np.linspace(0.0, 1.0, xf, dtype="float32")
    fade_out = np.cos(t * (math.pi / 2))
    fade_in = np.sin(t * (math.pi / 2))
    out = seed.copy()
    while out.shape[0] < target_len:
        tail = out[-xf:] * fade_out
        head = seed[:xf] * fade_in
        out = np.concatenate([out[:-xf], tail + head, seed[xf:]])
    return out[:target_len]

try:
    Path(os.path.dirname(out_path)).mkdir(parents=True, exist_ok=True)
    print(f"[musicgen] seed render target={target_s:.3f}s seed={seed_s:.3f}s", flush=True)
    processor = AutoProcessor.from_pretrained("facebook/musicgen-small")
    model = MusicgenForConditionalGeneration.from_pretrained("facebook/musicgen-small")
    model.eval()
    sr = int(model.config.audio_encoder.sampling_rate)

    # Only generate as much seed as we actually need (target may be < seed).
    gen_s = min(seed_s, target_s)
    tokens = max(1, int(math.ceil(gen_s * token_rate)))
    print(f"[musicgen] generating seed: dur={gen_s:.3f}s tokens={tokens}", flush=True)
    inputs = processor(text=[prompt], padding=True, return_tensors="pt")
    audio = model.generate(**inputs, max_new_tokens=tokens)
    seed = audio[0, 0].detach().cpu().numpy().astype("float32")

    # Normalize the seed to ~0.89 peak BEFORE looping. MusicGen output sits near
    # full-scale, so the equal-power crossfade's brief energy bump at each loop
    # join would otherwise push samples past 1.0 and clip. Headroom prevents it.
    seed_peak = float(np.max(np.abs(seed)))
    if seed_peak > 1e-6:
        seed = seed * (0.89 / seed_peak)

    want_total = max(1, int(round(target_s * sr)))
    if seed.shape[0] >= want_total:
        final = seed[:want_total].copy()
        print(f"[musicgen] trimmed seed to {want_total} samples", flush=True)
    else:
        xf = int(round(crossfade_s * sr))
        final = loop_crossfade(seed, want_total, xf)
        print(f"[musicgen] crossfade-looped seed to {final.shape[0]} samples", flush=True)

    if final.shape[0] < want_total:
        final = np.pad(final, (0, want_total - final.shape[0]))
    else:
        final = final[:want_total]
    final = apply_fade(final, sr)
    # Safety limiter: a residual peak >1.0 (rounding, fade edges) would clip on
    # write. Scale the whole buffer down by the overshoot if it ever happens.
    peak = float(np.max(np.abs(final)))
    if peak > 1.0:
        final = final / peak
    sf.write(out_path, final, sr)
    print(f"[musicgen] wrote {out_path} samples={final.shape[0]} sr={sr}", flush=True)
except Exception:
    traceback.print_exc()
    sys.exit(1)
`
  const bgm = spawn('python3', ['-c', script], {
    detached: true,
    stdio: ['ignore', fd, fd]
  })
  bgm.unref()
  closeSync(fd)
  bgmEnabled = true
  bgmPid = bgm.pid
  bgmMeta = {
    provider: 'musicgen',
    mode: targetS > seedS ? 'detached-seed-loop' : 'detached-seed-trim',
    pid: bgmPid,
    log,
    target_duration_s: Number(targetS.toFixed(3)),
    seed_duration_s: seedS,
    loop_count: loops
  }
} else {
  const depsHint = `pip install ${BGM_PY_DEPS.join(' ')}`
  bgmReason = !lyriaKey()
    ? `$GEMINI_API_KEY/$GOOGLE_API_KEY not set; BGM deps not installed (${depsHint})`
    : `--lyria-recipe not provided; BGM deps not installed (${depsHint})`
}

// ---------- Step 7: assemble audio_meta.json ----------
const audioMeta = {
  tts_provider: provider,
  voice_id: voiceId,
  bgm_provider: bgmMeta?.provider || null,
  bgm_enabled: bgmEnabled,
  bgm_path: bgmEnabled ? bgmRelPath : null,
  bgm_pending: bgmEnabled && !existsSync(bgmAbsPath),
  bgm_log: bgmMeta?.log || null,
  bgm_pid: bgmMeta?.pid || null,
  bgm_mode: bgmMeta?.mode || null,
  bgm_target_duration_s: bgmMeta?.target_duration_s || null,
  bgm_seed_duration_s: bgmMeta?.seed_duration_s || null,
  bgm_loop_count: bgmMeta?.loop_count || null,
  total_duration_s: parseFloat(totalDuration.toFixed(3)),
  scenes: scenesMap
}

writeFileSync(outPath, JSON.stringify(audioMeta, null, 2))

// ---------- Step 8: summary ----------
console.log(`\n✓ wrote ${outPath}`)
console.log(`  provider: ${provider}  voice: ${voiceId}`)
console.log(`  scenes voiced: ${Object.keys(scenesMap).length}/${scenes.length}`)
const transcribed = Object.values(scenesMap).filter((s) => s.wordsPath).length
console.log(`  scenes transcribed: ${transcribed}/${Object.keys(scenesMap).length}`)
console.log(`  total voice duration: ${audioMeta.total_duration_s}s`)
if (bgmEnabled) {
  const bgmBackend =
    lyriaKey() && lyriaRecipe && existsSync(lyriaRecipe)
      ? 'Lyria'
      : `MusicGen via transformers (local, ${bgmMeta?.seed_duration_s || '?'}s seed ${bgmMeta?.mode === 'detached-seed-loop' ? `→ crossfade-loop ×${bgmMeta?.loop_count || '?'}` : '→ trim'})`
  console.log(`  bgm: launched via ${bgmBackend} pid=${bgmPid} (detached, → ${bgmRelPath})`)
  if (bgmMeta?.log) console.log(`       log: ${bgmMeta.log}`)
  if (audioMeta.bgm_pending) {
    console.log(`       bgm_pending=true; Phase 4c wait-bgm.mjs waits/checks before assemble`)
  } else {
    console.log(`       bgm.wav already on disk`)
  }
} else {
  console.log(`  bgm: disabled (${bgmReason})`)
}
if (failedScenes.length) {
  console.log(
    `\nfailed scenes (omitted from audio_meta — Phase 4a falls back to estimatedDuration):`
  )
  for (const id of failedScenes) console.log(`  - ${id}`)
}
