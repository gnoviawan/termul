#!/usr/bin/env node
// Spine AD-24: canvas/figcraft.pin and the figcraft-mcp Cargo dependency name
// the same fork release. A `tag =` dependency must equal the pin's tag (the
// check fails closed). A `rev =` dependency is the interim state before the
// fork publishes a `termul-*` tag: a commit cannot be compared with a release
// tag, so the check warns and passes until the dependency moves to `tag =`.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cargoFigcraftMcpRef, readPin } from './figcraft-pin.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const pinPath = process.argv[2] ?? resolve(root, 'canvas', 'figcraft.pin')
const cargoPath = process.argv[3] ?? resolve(root, 'src-tauri', 'Cargo.toml')

const pin = readPin(pinPath)
const ref = cargoFigcraftMcpRef(readFileSync(cargoPath, 'utf8'))

if (ref === null) {
  console.log(
    `figcraft pin check skipped: ${cargoPath} has no figcraft-mcp dependency yet (pin tag ${pin.tag})`
  )
} else if (ref.kind === 'rev') {
  console.warn(
    `figcraft pin check warning: figcraft-mcp is pinned by rev ${ref.value}, not a tag; it cannot be compared with canvas/figcraft.pin tag ${pin.tag}. Move the dependency to tag = "<termul-* tag>" once the fork publishes one.`
  )
} else if (ref.value !== pin.tag) {
  console.error(
    `figcraft pin mismatch: canvas/figcraft.pin tag is ${pin.tag}, Cargo.toml figcraft-mcp tag is ${ref.value}`
  )
  process.exit(1)
} else {
  console.log(`figcraft pin matches Cargo.toml figcraft-mcp tag ${pin.tag}`)
}
