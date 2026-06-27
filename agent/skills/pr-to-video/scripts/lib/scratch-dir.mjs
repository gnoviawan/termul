// scratch-dir.mjs — private per-process scratch dir for audio.mjs intermediates
// (narration .txt handoffs, detached-BGM logs).
//
// Bare `/tmp/<predictable-name>` writes are symlink-race exploitable on shared
// hosts (CodeQL js/insecure-temporary-file): a co-located process can
// pre-create the path as a symlink and redirect the write. mkdtempSync yields
// an unpredictable, owner-only (0700) directory, so file names inside it can
// stay deterministic. Deliberately never cleaned up here: the detached BGM
// process keeps writing its log after audio.mjs exits; the OS tmp cleaner
// reaps the directory like any other tmpdir() entry.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scratchDir = null

export function scratchPath(name) {
  if (!scratchDir) scratchDir = mkdtempSync(join(tmpdir(), 'hf-audio-'))
  return join(scratchDir, name)
}
