/**
 * The fixture every terminal check shares: a shell script that exercises
 * `ls --color`, a 256-colour and truecolor chart, alt-screen programs and a
 * wrapping line, plus the recorder that captures its bytes through Termul's
 * own `/terminal/ws` transport into `fixtures/session.bin`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTerminalTransport, spawnSession } from '../../src/terminal/transport'

export const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures')
export const FIXTURE_BYTES = resolve(FIXTURE_DIR, 'session.bin')
export const FIXTURE_COLS = 80
export const FIXTURE_ROWS = 24

export const SERVER_ORIGIN = process.env.TERMUL_SERVER_URL ?? 'http://127.0.0.1:8191'
export const SERVER_TOKEN = process.env.TERMUL_SERVER_TOKEN
export const PROJECT_ID = process.env.TERMUL_PROJECT_ID ?? 't1'
export const PROJECT_DIR = process.env.TERMUL_PROJECT_DIR ?? '/tmp/gpuix-t1/project'

/** A shell with a fixed prompt and no rc files, so the recording is stable. */
export const SHELL_SPAWN = {
  program: '/bin/bash',
  args: ['--norc', '--noprofile', '-i'],
  env: { PS1: '$ ', TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', COLUMNS: String(FIXTURE_COLS), LINES: String(FIXTURE_ROWS) }
} as const

/** Each step is a line typed at the prompt and the time to wait for its output. */
export const FIXTURE_STEPS: Array<{ input: string; waitMs: number }> = [
  { input: 'cd fixture && ls --color=always -la', waitMs: 400 },
  { input: 'for i in $(seq 0 255); do printf "\\e[48;5;${i}m "; if (( (i+1) % 32 == 0 )); then printf "\\e[0m\\n"; fi; done; printf "\\e[0m"', waitMs: 500 },
  { input: 'for i in $(seq 0 63); do printf "\\e[48;2;$((i*4));$((255-i*4));$((128+i))m "; done; printf "\\e[0m\\n"', waitMs: 400 },
  { input: 'printf "\\e[1mbold\\e[0m \\e[3mitalic\\e[0m \\e[4munder\\e[0m \\e[7minverse\\e[0m \\e[2mdim\\e[0m \\e[9mstrike\\e[0m \\e[1;31;44mbold red on blue\\e[0m\\n"', waitMs: 300 },
  { input: 'printf "%s\\n" "$(printf "wrap-%03d " $(seq 1 24))"', waitMs: 300 },
  { input: 'less -S wrapped.txt', waitMs: 800 },
  { input: 'q', waitMs: 400 },
  { input: 'vim -u NONE -N wrapped.txt', waitMs: 1500 },
  { input: ':q!\r', waitMs: 600 },
  { input: 'printf "done\\n"', waitMs: 300 }
]

export function seedFixtureDir(root = PROJECT_DIR): void {
  const dir = resolve(root, 'fixture')
  mkdirSync(resolve(dir, 'sub'), { recursive: true })
  writeFileSync(resolve(dir, 'file.txt'), 'hello\n')
  writeFileSync(resolve(dir, 'run.sh'), '#!/bin/sh\necho run\n', { mode: 0o755 })
  writeFileSync(resolve(dir, 'wrapped.txt'), `${'0123456789'.repeat(12)}\nsecond line\nthird line\n`)
}

export async function recordFixture(): Promise<Uint8Array> {
  seedFixtureDir()
  const transport = await loadTerminalTransport({ origin: SERVER_ORIGIN, token: SERVER_TOKEN })
  const chunks: Uint8Array[] = []
  const session = await spawnSession(transport, {
    ...SHELL_SPAWN,
    projectId: PROJECT_ID,
    cwd: PROJECT_DIR,
    cols: FIXTURE_COLS,
    rows: FIXTURE_ROWS,
    onData: (bytes) => chunks.push(bytes)
  })
  await Bun.sleep(500)
  for (const step of FIXTURE_STEPS) {
    session.write(step.input.endsWith('\r') ? step.input : `${step.input}\r`)
    await Bun.sleep(step.waitMs)
  }
  await Bun.sleep(300)
  session.dispose()
  await session.kill()
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

if (import.meta.main) {
  const bytes = await recordFixture()
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(FIXTURE_BYTES, bytes)
  console.log(`recorded ${bytes.length} bytes to ${FIXTURE_BYTES}`)
  process.exit(0)
}
