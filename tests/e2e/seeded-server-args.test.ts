import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { seededServerArgs } from './seeded-server-args'

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

describe('seededServerArgs', () => {
  const stateDir = join('tmp', 'termul-e2e-state-abc')
  const args = seededServerArgs({ port: 8188, stateDir })

  it('pins the store file inside the state dir so TERMUL_STORE_FILE cannot redirect it', () => {
    expect(flagValue(args, '--store-file')).toBe(join(stateDir, 'store.json'))
  })

  it('pins the sessions dir and projects file inside the state dir', () => {
    expect(flagValue(args, '--state-dir')).toBe(stateDir)
    expect(flagValue(args, '--sessions-dir')).toBe(join(stateDir, 'sessions'))
    expect(flagValue(args, '--projects-file')).toBe(join(stateDir, 'projects.json'))
  })

  it('binds loopback on the requested port', () => {
    expect(flagValue(args, '--host')).toBe('127.0.0.1')
    expect(flagValue(args, '--port')).toBe('8188')
  })
})
