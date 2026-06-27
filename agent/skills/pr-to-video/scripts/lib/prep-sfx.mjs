// prep.mjs concern module — resolve the SFX library and scene cues into globally
// timed sfx records. Split out of prep.mjs (Step 6.5). Copies the opt-in library
// into the project, validates each cue against manifest.json, and offsets each
// cue's scene-local t by its scene start_s. Appends to the shared anomalies array
// and returns the sorted sfx[] for group_spec.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { die } from './prep-log.mjs'

// SFX library is OPT-IN: when the orchestrator passes --sfx-lib the directory is
// copied into <PROJECT_DIR>/assets/sfx/ and section_plan **SFX:** cues are
// validated against manifest.json. Without --sfx-lib, scene cues are silently
// dropped (warning only). Voice/bgm live under assets/; SFX matches.
export function resolveSfx({ sfxLibDir, hyperframesDir, scenes, groups, anomalies }) {
  const sfx = []
  if (sfxLibDir) {
    const sfxManifestPath = join(sfxLibDir, 'manifest.json')
    if (!existsSync(sfxManifestPath)) {
      die(`--sfx-lib points to ${sfxLibDir} but manifest.json is missing`)
    }
    let sfxManifest
    try {
      sfxManifest = JSON.parse(readFileSync(sfxManifestPath, 'utf8'))
    } catch (e) {
      die(`sfx manifest.json parse: ${e.message}`)
    }
    // Build filename → { duration, key } lookup so cues can reference by filename
    // (matching v1 storyboard syntax: `impact-bass-1.mp3` not the manifest key).
    const sfxByFile = new Map()
    for (const [key, entry] of Object.entries(sfxManifest)) {
      if (entry?.file && isFinite(entry.duration)) {
        sfxByFile.set(entry.file, { key, duration: entry.duration })
      }
    }

    // Copy entire SFX directory into <PROJECT_DIR>/assets/sfx/ (mp3 + manifest +
    // CREDITS). Idempotent: skip files that already exist (e.g. re-runs).
    const sfxDestDir = join(hyperframesDir, 'assets', 'sfx')
    mkdirSync(sfxDestDir, { recursive: true })
    let sfxCopied = 0
    for (const ent of readdirSync(sfxLibDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue
      const src = join(sfxLibDir, ent.name)
      const dest = join(sfxDestDir, ent.name)
      if (!existsSync(dest)) {
        copyFileSync(src, dest)
        sfxCopied++
      }
    }

    // Resolve each scene's cues against manifest + add scene.start_s offset.
    for (const g of groups) {
      for (const sid of g.scene_ids) {
        const sceneEntry = g.scenes[sid]
        const sceneCues = scenes.find((x) => x.sceneId === sid)?.sfxCues || []
        for (const cue of sceneCues) {
          const hit = sfxByFile.get(cue.file)
          if (!hit) {
            anomalies.push(
              `${sid}: SFX cue file "${cue.file}" not in manifest — dropping (known files: ${[...sfxByFile.keys()].slice(0, 5).join(', ')}${sfxByFile.size > 5 ? ', …' : ''})`
            )
            continue
          }
          const tGlobal = Number((sceneEntry.start_s + cue.t_local).toFixed(3))
          sfx.push({
            file: cue.file,
            t: tGlobal,
            duration: hit.duration,
            volume: cue.volume != null ? cue.volume : 0.35,
            scene_id: sid,
            t_local: cue.t_local,
            note: cue.note || ''
          })
        }
      }
    }
    // Sort by global t for predictable index.html emission order.
    sfx.sort((a, b) => a.t - b.t)
    console.log(`  sfx lib copied: ${sfxCopied} file(s) → assets/sfx/`)
  } else {
    // Surface plan cues that won't make it to the timeline because no lib was provided.
    let droppedCueCount = 0
    for (const s of scenes) droppedCueCount += s.sfxCues?.length || 0
    if (droppedCueCount > 0) {
      anomalies.push(
        `section_plan declares ${droppedCueCount} SFX cue(s) but --sfx-lib not passed — all cues dropped`
      )
    }
  }
  return sfx
}
