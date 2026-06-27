#!/usr/bin/env node
// Self-contained HeyGen TTS — bypasses the `hyperframes` CLI (Kokoro-only).
//
// One REST call to api.heygen.com/v3/voices/speech returns an audio_url plus
// word_timestamps. We download the audio, transcode mp3→wav (44.1k mono) when
// the output ends in .wav, and write the word timestamps in the flat
// { id, text, start, end } shape the captions pipeline consumes — so the
// separate Whisper transcribe pass is skipped.
//
// Mirrors the inline `synthesizeHeygen` in the video skills' audio.mjs, but
// stands alone: single text in → one wav (+ optional words JSON) out.
//
// Usage:
//   node heygen-tts.mjs "Text to speak"        -o narration.wav [--words narration.words.json]
//   node heygen-tts.mjs ./script.txt           -o narration.wav --words narration.words.json
//   node heygen-tts.mjs "Bonjour"              -o fr.wav --lang fr --voice <id>
//   node heygen-tts.mjs --list                 # list starfish voices and exit
//
// Flags:
//   -o, --output   Output path (.wav → ffmpeg transcode; .mp3 → raw bytes). Default: narration.wav
//       --words     Write word timestamps to this path ([{id,text,start,end}]). Optional.
//       --voice     HeyGen starfish voice_id. Default: first English public starfish voice (auto).
//       --speed     Speech speed multiplier. Default: 1.0
//       --lang      Language code; anything other than "en" is sent as `language`. Default: en
//       --list      List public starfish voices (voice_id / name / language) and exit.
//
// Requires: $HEYGEN_API_KEY (read from shell env or a nearby .env), and ffmpeg
// on PATH for .wav output.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
  console.error(`✗ heygen-tts: ${msg}`)
  process.exit(1)
}

// First non-flag arg (and not a flag value) is the text or .txt path.
const positional = (() => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      // skip its value if it consumes one
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) i++
      continue
    }
    if (a === '-o') {
      i++ // skip output value
      continue
    }
    return a
  }
  return null
})()

const output = resolve(
  (typeof flag('output') === 'string' && flag('output')) ||
    (argv.includes('-o') && argv[argv.indexOf('-o') + 1]) ||
    'narration.wav'
)
const wordsPath = typeof flag('words') === 'string' ? resolve(flag('words')) : null
const userVoice = typeof flag('voice') === 'string' ? flag('voice') : null
const speedRaw = typeof flag('speed') === 'string' ? Number(flag('speed')) : 1.0
const speed = isFinite(speedRaw) && speedRaw > 0 ? speedRaw : 1.0
const lang = typeof flag('lang') === 'string' ? flag('lang') : 'en'
const listOnly = flag('list') === true

// ---------- load .env ----------
// Walk up from CWD ≤ 5 dirs, first .env wins; shell env always takes priority
// (never override an already-set key). Matches audio.mjs / the CLI loader.
function loadEnvFromDir(startDir) {
  let dir = resolve(startDir)
  for (let i = 0; i < 5; i++) {
    const envPath = join(dir, '.env')
    if (existsSync(envPath)) {
      const txt = readFileSync(envPath, 'utf8')
      for (const raw of txt.split('\n')) {
        let line = raw.trim()
        if (!line || line.startsWith('#')) continue
        if (line.startsWith('export ')) line = line.slice(7).trim()
        const eq = line.indexOf('=')
        if (eq < 1) continue
        const key = line.slice(0, eq).trim()
        let val = line.slice(eq + 1).trim()
        if (val.startsWith('"') || val.startsWith("'")) {
          const q = val.charAt(0)
          const end = val.indexOf(q, 1)
          val = end > 0 ? val.slice(1, end) : val.slice(1)
        }
        if (!(key in process.env)) process.env[key] = val
      }
      return
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}
loadEnvFromDir(process.cwd())

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

const authHeaders = heygenAuthHeaders()

const BASE = 'https://api.heygen.com/v3'

// GET public starfish voices — the /v3/voices/speech endpoint only accepts
// voice_ids from the starfish engine (v2 catalog ids are rejected with a 400).
async function fetchStarfishVoices() {
  const res = await fetch(`${BASE}/voices?engine=starfish&type=public&limit=50`, {
    headers: authHeaders
  })
  if (!res.ok) die(`voice list failed (HTTP ${res.status})`)
  const payload = await res.json()
  return payload.data ?? payload.voices ?? []
}

// ---------- --list ----------
if (listOnly) {
  for (const v of await fetchStarfishVoices()) {
    console.log(`${v.voice_id}\t${v.name}\t${v.language ?? ''}`)
  }
  process.exit(0)
}

// ---------- resolve input text ----------
if (!positional) die('no text given. Pass a string or a .txt path, or use --list.')
const text =
  positional.endsWith('.txt') && existsSync(resolve(positional))
    ? readFileSync(resolve(positional), 'utf8').trim()
    : positional
if (!text) die('input text is empty')

// ---------- resolve voice ----------
// Explicit --voice wins; otherwise pick the first English public starfish voice
// (the speech endpoint requires a starfish voice_id).
let voiceId = userVoice
if (!voiceId) {
  const voices = await fetchStarfishVoices()
  const pick = voices.find((v) => v.language === 'English') ?? voices[0]
  if (!pick) die('no public starfish voices available to default to — pass --voice')
  voiceId = pick.voice_id
  console.error(`· using voice ${voiceId} (${pick.name})`)
}

// ---------- synthesize ----------
const reqBody = { text, voice_id: voiceId, speed }
if (lang !== 'en') reqBody.language = lang

const res = await fetch(`${BASE}/voices/speech`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify(reqBody)
})
if (!res.ok) {
  const detail = await res.text().catch(() => '')
  die(`speech request failed (HTTP ${res.status})${detail ? `\n${detail.slice(0, 300)}` : ''}`)
}
const payload = await res.json()
const inner = payload.data ?? payload
if (!inner.audio_url) die('response had no audio_url')

// ---------- download audio ----------
const audioRes = await fetch(inner.audio_url)
if (!audioRes.ok) die(`audio download failed (HTTP ${audioRes.status})`)
const bytes = Buffer.from(await audioRes.arrayBuffer())

mkdirSync(dirname(output), { recursive: true })

if (output.endsWith('.wav')) {
  // Transcode mp3→wav (44.1k mono). ffmpeg detects the true container from
  // content, so the temp extension is cosmetic.
  const td = mkdtempSync(join(tmpdir(), 'hf-heygen-'))
  const tmpAudio = join(td, 'audio.mp3')
  writeFileSync(tmpAudio, bytes)
  const ff = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', tmpAudio, '-ar', '44100', '-ac', '1', output],
    { stdio: 'inherit' }
  )
  rmSync(td, { recursive: true, force: true })
  if (ff.status !== 0 || !existsSync(output)) {
    die('ffmpeg transcode failed (install ffmpeg, or output to .mp3 to skip transcode)')
  }
} else {
  writeFileSync(output, bytes)
}

// ---------- word timestamps → flat [{id,text,start,end}] ----------
let wordCount = 0
if (wordsPath) {
  const wts = inner.word_timestamps
  if (Array.isArray(wts)) {
    const words = wts
      .filter((w) => w && typeof w.word === 'string' && isFinite(w.start) && isFinite(w.end))
      // Drop HeyGen's <start> / <end> sentence-boundary sentinels — they carry
      // no spoken text and would render as literal "<start>" caption tokens.
      .filter((w) => !/^<.*>$/.test(w.word.trim()))
      .map((w, idx) => ({ id: `w${idx}`, text: w.word, start: w.start, end: w.end }))
    if (words.length) {
      mkdirSync(dirname(wordsPath), { recursive: true })
      writeFileSync(wordsPath, JSON.stringify(words, null, 2))
      wordCount = words.length
    }
  }
  if (!wordCount) {
    console.error('⚠ no word_timestamps in response — run `hyperframes transcribe` instead')
  }
}

const dur = typeof inner.duration === 'number' ? ` (${inner.duration.toFixed(2)}s)` : ''
console.log(`✓ ${output}${dur}${wordCount ? ` · ${wordsPath} (${wordCount} words)` : ''}`)
