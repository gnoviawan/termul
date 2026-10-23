/**
 * The fixture every terminal check shares: a shell script that exercises
 * `ls --color`, a 256-colour and truecolor chart, alt-screen programs and a
 * wrapping line. `record.ts` captures its bytes through Termul's own
 * `/terminal/ws` transport into `fixtures/session.bin`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TerminalSpawnOptions } from '@shared/types/ipc.types'

export const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures')
export const FIXTURE_BYTES = resolve(FIXTURE_DIR, 'session.bin')
/** Byte offset of the stream after each step, keyed by step name: `fixtures/session.json`. */
export const FIXTURE_CHECKPOINTS = resolve(FIXTURE_DIR, 'session.json')
export const FIXTURE_COLS = 80
export const FIXTURE_ROWS = 24

export const PROJECT_ID = process.env.TERMUL_PROJECT_ID ?? 't1'
export const PROJECT_DIR = process.env.TERMUL_PROJECT_DIR ?? '/tmp/gpuix-t1/project'

/** A shell with a fixed prompt and no rc files, so the recording is stable. */
export const SHELL_SPAWN: Pick<TerminalSpawnOptions, 'program' | 'args' | 'env'> = {
  program: '/bin/bash',
  args: ['--norc', '--noprofile', '-i'],
  env: {
    PS1: '$ ',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  }
}

/** Each step is a line typed at the prompt and the time to wait for its output. */
export const FIXTURE_STEPS: Array<{ name: string; input: string; waitMs: number }> = [
  { name: 'ls', input: 'cd fixture && ls --color=always -la', waitMs: 400 },
  {
    name: 'palette-256',
    input:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion typed at the prompt
      'for i in $(seq 0 255); do printf "\\e[48;5;${i}m "; if (( (i+1) % 32 == 0 )); then printf "\\e[0m\\n"; fi; done; printf "\\e[0m"',
    waitMs: 500
  },
  {
    name: 'truecolor',
    input:
      'for i in $(seq 0 63); do printf "\\e[48;2;$((i*4));$((255-i*4));$((128+i))m "; done; printf "\\e[0m\\n"',
    waitMs: 400
  },
  {
    name: 'attributes',
    input:
      'printf "\\e[1mbold\\e[0m \\e[3mitalic\\e[0m \\e[4munder\\e[0m \\e[7minverse\\e[0m \\e[2mdim\\e[0m \\e[9mstrike\\e[0m \\e[1;31;44mbold red on blue\\e[0m\\n"',
    waitMs: 300
  },
  { name: 'wrap', input: 'printf "%s\\n" "$(printf "wrap-%03d " $(seq 1 24))"', waitMs: 300 },
  { name: 'less', input: 'less -S wrapped.txt', waitMs: 2500 },
  { name: 'less-quit', input: 'q', waitMs: 400 },
  { name: 'vim', input: 'vim -u NONE -N wrapped.txt', waitMs: 2500 },
  { name: 'vim-quit', input: ':q!\r', waitMs: 600 },
  { name: 'done', input: 'printf "done\\n"', waitMs: 300 }
]

export function seedFixtureDir(root = PROJECT_DIR): void {
  const dir = resolve(root, 'fixture')
  mkdirSync(resolve(dir, 'sub'), { recursive: true })
  writeFileSync(resolve(dir, 'file.txt'), 'hello\n')
  writeFileSync(resolve(dir, 'run.sh'), '#!/bin/sh\necho run\n', { mode: 0o755 })
  writeFileSync(
    resolve(dir, 'wrapped.txt'),
    `${'0123456789'.repeat(12)}\nsecond line\nthird line\n`
  )
}
