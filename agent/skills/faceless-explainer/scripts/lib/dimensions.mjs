// dimensions.mjs — single source of truth for the video canvas size.
//
// ============================================================================
//  THE A/B ↔ C SEAM  (read this before wiring orientation in upstream)
// ============================================================================
// The whole faceless-explainer pipeline used to be hard-locked to landscape
// 1920×1080. It is now dimension-parametric: every deterministic script
// (assemble-index, transitions, captions, preflight-finalize) and every
// scene worker reads the canvas size from ONE place — `group_spec.json`
// `width`/`height` — which prep.mjs stamps in.
//
// prep.mjs resolves the size with this precedence (see resolveDimensions):
//   1. explicit `--width N --height N` flags on prep        (testing / override)
//   2. `narrator_scripts.json` → `dimensions: { width, height }`   (explicit px)
//   3. `narrator_scripts.json` → `orientation: "landscape|portrait|square"`
//   4. default → landscape 1920×1080                        (back-compat)
//
// >>> For whoever wires the intent→orientation entry (Step 0 / scriptwriting):
//     do NOT thread pixels through every script. Just write ONE field into
//     `narrator_scripts.json` — `orientation` (friendly) or `dimensions`
//     (explicit px) — exactly the way `stylePreset` already lives there. prep
//     picks it up and the rest of the pipeline follows automatically. If you
//     write nothing, the video stays landscape (no behavior change).
// ============================================================================

// Named orientation presets. Square/portrait are 1080-based so they share the
// long-edge pixel budget with landscape (same render cost ballpark).
export const ORIENTATION_PRESETS = {
  landscape: { width: 1920, height: 1080 }, // 16:9 — default
  portrait: { width: 1080, height: 1920 }, // 9:16 — reels / shorts / TikTok
  square: { width: 1080, height: 1080 } // 1:1 — feed
}

export const DEFAULT_DIMENSIONS = ORIENTATION_PRESETS.landscape

function sane(w, h) {
  return Number.isFinite(w) && Number.isFinite(h) && w >= 240 && h >= 240 && w <= 8192 && h <= 8192
}

// Resolve canvas dims from (in priority order) explicit flags, an explicit
// `dimensions` object, a named `orientation`, else the landscape default.
// `flags` = { width, height } (strings or numbers, may be undefined).
// `narratorScripts` = the parsed narrator_scripts.json (may be null).
// Returns { width, height, source } — `source` is for logging/anomalies.
export function resolveDimensions(flags = {}, narratorScripts = null) {
  const fw = flags.width != null ? parseInt(flags.width, 10) : NaN
  const fh = flags.height != null ? parseInt(flags.height, 10) : NaN
  if (sane(fw, fh)) return { width: fw, height: fh, source: 'flags' }

  const dim = narratorScripts && narratorScripts.dimensions
  if (dim) {
    const w = parseInt(dim.width, 10)
    const h = parseInt(dim.height, 10)
    if (sane(w, h)) return { width: w, height: h, source: 'narrator_scripts.dimensions' }
  }

  const orient =
    narratorScripts && typeof narratorScripts.orientation === 'string'
      ? narratorScripts.orientation.trim().toLowerCase()
      : ''
  if (orient && ORIENTATION_PRESETS[orient]) {
    return { ...ORIENTATION_PRESETS[orient], source: `orientation=${orient}` }
  }

  return { ...DEFAULT_DIMENSIONS, source: 'default(landscape)' }
}

// Read dims back out of a group_spec (downstream consumers). Falls back to the
// landscape default so a group_spec produced before this change still works.
export function readDims(groupSpec) {
  const w = parseInt(groupSpec?.width, 10)
  const h = parseInt(groupSpec?.height, 10)
  if (sane(w, h)) return { width: w, height: h }
  return { ...DEFAULT_DIMENSIONS }
}

// Caption band geometry, derived from canvas height. The band is the bottom
// ~16.67% of the canvas (matches the original landscape 180px band at h=1080:
// 1080 − round(1080 × 0.1667) = 900). Foreground content must end `safetyPx`
// above the band top.
export const CAPTION_BAND_FRACTION = 0.1667
export function captionBand(height, safetyPx = 20) {
  const h = Number.isFinite(height) ? height : DEFAULT_DIMENSIONS.height
  const bandHeight = Math.round(h * CAPTION_BAND_FRACTION)
  const bandTopY = h - bandHeight // foreground must end at/above this y
  return { bandHeight, bandTopY, foregroundMaxY: bandTopY - safetyPx }
}
