// Shared failure helper for prep.mjs and its concern modules (prep-assets,
// prep-design, prep-section, prep-sfx). Keeps the "✗ prep.mjs:" prefix stable
// across the split so error output is identical regardless of which module
// raised it — the whole pipeline is still "prep" from the caller's point of view.
export function die(msg) {
  console.error(`✗ prep.mjs: ${msg}`)
  process.exit(1)
}
