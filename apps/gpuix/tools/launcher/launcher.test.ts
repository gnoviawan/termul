import { describe, expect, test } from 'bun:test'
import { mkdtempSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostCommands, runHostAction } from '../../src/launcher/desktop-host'
import { claimInstance } from '../../src/launcher/instance'
import { dataDirArgs, resolveServerBinary, serverDataDir } from '../../src/launcher/paths'
import { classifyAuthReply } from '../../src/launcher/probe'
import { clearServerRecord, readServerRecord, writeServerRecord } from '../../src/launcher/record'
import { classifyEarlyExit, type ServerChild } from '../../src/launcher/server-process'
import type { ServerPhase } from '../../src/launcher/status'
import { createSupervisor, type SupervisorDeps } from '../../src/launcher/supervisor'

const facts = (
  platform: NodeJS.Platform,
  env: Record<string, string> = {},
  files: string[] = []
) => ({
  env,
  platform,
  homedir:
    platform === 'win32' ? 'C:\\Users\\ana' : platform === 'darwin' ? '/Users/ana' : '/home/ana',
  isFile: (candidate: string) => files.includes(candidate)
})

describe('paths', () => {
  test('the data dir is the Tauri desktop app_data_dir on each platform', () => {
    expect(serverDataDir(facts('linux'))).toBe('/home/ana/.local/share/com.termul-manager.app')
    expect(serverDataDir(facts('linux', { XDG_DATA_HOME: '/xdg' }))).toBe(
      '/xdg/com.termul-manager.app'
    )
    expect(serverDataDir(facts('darwin'))).toBe(
      '/Users/ana/Library/Application Support/com.termul-manager.app'
    )
    expect(serverDataDir(facts('win32', { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }))).toBe(
      'C:\\Users\\ana\\AppData\\Roaming\\com.termul-manager.app'
    )
    expect(serverDataDir(facts('linux', { TERMUL_GPUIX_DATA_DIR: '/tmp/d' }))).toBe('/tmp/d')
  })

  test('the server is pointed at the desktop host stores', () => {
    expect(dataDirArgs('linux', '/d')).toEqual([
      '--state-dir',
      '/d',
      '--sessions-dir',
      '/d/acp-sessions',
      '--projects-file',
      '/d/projects.json',
      '--store-file',
      '/d/store.json'
    ])
  })

  test('binary lookup: env, then bundled, then PATH', () => {
    const files = ['/app/termul-server', '/usr/bin/termul-server', '/opt/custom']
    expect(
      resolveServerBinary(facts('linux', { TERMUL_SERVER_BIN: '/opt/custom' }, files), ['/app'])
    ).toEqual({
      found: true,
      path: '/opt/custom'
    })
    expect(resolveServerBinary(facts('linux', { PATH: '/usr/bin' }, files), ['/app'])).toEqual({
      found: true,
      path: '/app/termul-server'
    })
    expect(resolveServerBinary(facts('linux', { PATH: '/usr/bin' }, files), ['/other'])).toEqual({
      found: true,
      path: '/usr/bin/termul-server'
    })
    expect(resolveServerBinary(facts('linux', { PATH: '/bin' }, files), ['/other'])).toEqual({
      found: false,
      searched: ['/other/termul-server', '/bin/termul-server']
    })
    expect(
      resolveServerBinary(facts('linux', { TERMUL_SERVER_BIN: '/missing' }, files), [])
    ).toEqual({
      found: false,
      searched: ['/missing']
    })
  })
})

describe('probe replies (frames recorded from termul-server)', () => {
  test('authenticate ok, mismatch and unauthorized', () => {
    expect(
      classifyAuthReply({ id: 'launcher-probe', ok: true, payload: { protocolVersion: 7 } })
    ).toEqual({
      kind: 'ok',
      protocolVersion: 7
    })
    expect(
      classifyAuthReply({
        id: 'launcher-probe',
        ok: false,
        err: {
          code: 'protocol_version_mismatch',
          message: 'protocol version mismatch: this host speaks version 8; reload the client'
        }
      })
    ).toEqual({ kind: 'version_mismatch', actual: 8 })
    expect(
      classifyAuthReply({
        ok: false,
        err: { code: 'unauthorized', message: 'invalid or missing auth token' }
      })
    ).toEqual({ kind: 'unauthorized' })
  })
})

describe('early exit classification (log lines from termul-server)', () => {
  test('port taken, data dir locked, anything else', () => {
    expect(
      classifyEarlyExit('termul-server failed: Address already in use (os error 98)\n', '/d')
    ).toEqual({
      failure: { code: 'start_failed', detail: 'the port is taken' },
      portInUse: true
    })
    expect(
      classifyEarlyExit(
        "termul-server: data path '/d' is already in use by another Termul host (lock file '/d/.termul.lock' is held by pid 4242); stop the other host\n",
        '/d'
      )
    ).toEqual({
      failure: { code: 'data_locked', dataDir: '/d', holderPid: 4242 },
      portInUse: false
    })
    expect(classifyEarlyExit('starting\nerror: --port must be 1-65535\n', '/d')).toEqual({
      failure: { code: 'start_failed', detail: 'error: --port must be 1-65535' },
      portInUse: false
    })
  })
})

interface FakeChild extends ServerChild {
  crash(): void
}

function fakeChild(pid: number, port: number): FakeChild {
  let alive = true
  let resolveExit: (detail: string) => void = () => {}
  const exited = new Promise<string>((resolve) => {
    resolveExit = resolve
  })
  const die = (detail: string) => {
    if (!alive) return
    alive = false
    resolveExit(detail)
  }
  return {
    pid,
    port,
    exited,
    isAlive: () => alive,
    stop: async () => die('signal SIGTERM'),
    signalStop: () => die('signal SIGTERM'),
    crash: () => die('signal SIGKILL')
  }
}

function harness(ready: SupervisorDeps['waitForReady'] = async () => ({ ok: true })) {
  const children: FakeChild[] = []
  const events: string[] = []
  let nextPid = 100
  const deps: SupervisorDeps = {
    spawn: (spec) => {
      const child = fakeChild(nextPid++, spec.port)
      children.push(child)
      events.push(`spawn ${child.pid}:${spec.port} watch=${spec.watchParentPid}`)
      return child
    },
    waitForReady: ready,
    probe: async () => ({ kind: 'ok', protocolVersion: 7 }),
    pickPort: async () => 9001,
    isPidAlive: () => true,
    saveRecord: (record) => events.push(`save ${record.pid}`),
    clearRecord: (pid) => events.push(`clear ${pid}`),
    parentPid: 1,
    restartBackoffMs: [5]
  }
  return { deps, children, events }
}

const server = {
  binary: { found: true as const, path: '/bin/termul-server' },
  dataDir: '/d',
  token: 't',
  port: 9000,
  logFile: '/tmp/log',
  keepAlive: false,
  existingPid: null
}

async function phaseAfter(
  status: { get(): ServerPhase },
  kind: ServerPhase['kind'],
  pid?: number
): Promise<ServerPhase> {
  const matches = (phase: ServerPhase) =>
    phase.kind === kind && (pid === undefined || ('pid' in phase && phase.pid === pid))
  for (let i = 0; i < 400; i++) {
    if (matches(status.get())) return status.get()
    await Bun.sleep(5)
  }
  throw new Error(
    `never reached ${kind}${pid ? ` pid ${pid}` : ''}, stuck at ${JSON.stringify(status.get())}`
  )
}

describe('supervisor', () => {
  test('a crash is published, then the server restarts on the same port', async () => {
    const { deps, children, events } = harness()
    const supervisor = createSupervisor(server, deps)
    const seen: string[] = []
    supervisor.status.subscribe((phase) => seen.push(phase.kind))
    expect(await supervisor.start()).toEqual({ kind: 'ready', origin: 'spawned', pid: 100 })
    children[0].crash()
    expect(await phaseAfter(supervisor.status, 'ready', 101)).toEqual({
      kind: 'ready',
      origin: 'spawned',
      pid: 101
    })
    expect(seen).toEqual(['starting', 'ready', 'crashed', 'starting', 'ready'])
    expect(events).toEqual([
      'spawn 100:9000 watch=1',
      'save 100',
      'spawn 101:9000 watch=1',
      'save 101'
    ])
    expect(supervisor.origin()).toBe('http://127.0.0.1:9000')
  })

  test('five quick crashes in a row stop the restarts', async () => {
    const { deps, children } = harness()
    const supervisor = createSupervisor(server, deps)
    await supervisor.start()
    for (let crash = 0; crash < 5; crash++) {
      await phaseAfter(supervisor.status, 'ready', 100 + crash)
      children.at(-1)?.crash()
    }
    expect(await phaseAfter(supervisor.status, 'failed')).toEqual({
      kind: 'failed',
      failure: { code: 'crash_loop', crashes: 5 }
    })
    supervisor.status.retry()
    expect(await phaseAfter(supervisor.status, 'ready', 105)).toEqual({
      kind: 'ready',
      origin: 'spawned',
      pid: 105
    })
  })

  test('the first start moves off a taken port; later starts keep it', async () => {
    let calls = 0
    const { deps, events } = harness(async () =>
      calls++ === 0
        ? {
            ok: false,
            failure: { code: 'start_failed', detail: 'the port is taken' },
            portInUse: true
          }
        : { ok: true }
    )
    const supervisor = createSupervisor(server, deps)
    expect(await supervisor.start()).toEqual({ kind: 'ready', origin: 'spawned', pid: 101 })
    expect(events.slice(0, 2)).toEqual(['spawn 100:9000 watch=1', 'spawn 101:9001 watch=1'])
    expect(supervisor.origin()).toBe('http://127.0.0.1:9001')
  })

  test('a protocol mismatch fails the start and stops the child', async () => {
    const { deps, children } = harness()
    deps.probe = async () => ({ kind: 'version_mismatch', actual: 6 })
    const supervisor = createSupervisor(server, deps)
    expect(await supervisor.start()).toEqual({
      kind: 'failed',
      failure: { code: 'version_mismatch', expected: 7, actual: 6 }
    })
    expect(children[0].isAlive()).toBe(false)
  })

  test('a missing binary fails without spawning', async () => {
    const { deps, events } = harness()
    const supervisor = createSupervisor(
      { ...server, binary: { found: false, searched: ['/x'] } },
      deps
    )
    expect(await supervisor.start()).toEqual({
      kind: 'failed',
      failure: { code: 'binary_not_found', searched: ['/x'] }
    })
    expect(events).toEqual([])
  })

  test('shutdown stops an owned server and does not restart it', async () => {
    const { deps, children, events } = harness()
    const supervisor = createSupervisor(server, deps)
    await supervisor.start()
    await supervisor.shutdown()
    await Bun.sleep(20)
    expect(children[0].isAlive()).toBe(false)
    expect(events).toEqual(['spawn 100:9000 watch=1', 'save 100', 'clear 100'])
    expect(supervisor.status.get()).toEqual({ kind: 'stopped' })
  })

  test('keep-alive: no watchdog, left running on shutdown', async () => {
    const { deps, children, events } = harness()
    const supervisor = createSupervisor({ ...server, keepAlive: true }, deps)
    await supervisor.start()
    await supervisor.shutdown()
    expect(children[0].isAlive()).toBe(true)
    expect(events).toEqual(['spawn 100:9000 watch=null', 'save 100'])
  })

  test('a recorded keep-alive server is reused, then replaced when it dies', async () => {
    const { deps, events } = harness()
    let alive = true
    deps.isPidAlive = () => alive
    const supervisor = createSupervisor({ ...server, existingPid: 42 }, deps)
    expect(await supervisor.start()).toEqual({ kind: 'ready', origin: 'reused', pid: 42 })
    expect(events).toEqual([])
    alive = false
    expect(await phaseAfter(supervisor.status, 'ready', 100)).toEqual({
      kind: 'ready',
      origin: 'spawned',
      pid: 100
    })
    await supervisor.shutdown()
  })
})

describe('record', () => {
  test('round trip, owner-only files, and clear only for the recorded pid', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gpuix-launcher-'))
    const record = {
      pid: 7,
      port: 9000,
      protocolVersion: 7,
      dataDir: '/d',
      binary: '/b',
      keepAlive: true,
      startedAt: '2026-10-23T00:00:00.000Z'
    }
    writeServerRecord(dir, { record, token: 'secret' })
    expect(readServerRecord(dir)).toEqual({ record, token: 'secret' })
    expect(statSync(path.join(dir, 'server-token')).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(dir, 'server.json')).mode & 0o777).toBe(0o600)
    clearServerRecord(dir, 8)
    expect(readServerRecord(dir)?.record.pid).toBe(7)
    clearServerRecord(dir, 7)
    expect(readServerRecord(dir)).toBeNull()
  })
})

describe('single instance', () => {
  test('a second claim is secondary and focuses the first', async () => {
    const address = `\0termul-gpuix-test-${process.pid}`
    const first = await claimInstance(address, false)
    expect(first.kind).toBe('primary')
    let focused = 0
    if (first.kind === 'primary') first.onFocusRequest(() => focused++)
    expect((await claimInstance(address, false)).kind).toBe('secondary')
    await Bun.sleep(20)
    expect(focused).toBe(1)
    if (first.kind === 'primary') first.release()
    await Bun.sleep(20)
    const after = await claimInstance(address, false)
    expect(after.kind).toBe('primary')
    if (after.kind === 'primary') after.release()
  })
})

describe('desktop host commands', () => {
  test('per-platform argv keeps user text out of shell strings', () => {
    expect(hostCommands('linux', { kind: 'openUrl', url: 'https://a.dev/?q=1&x' })).toEqual([
      { argv: ['xdg-open', 'https://a.dev/?q=1&x'] }
    ])
    expect(
      hostCommands('linux', { kind: 'reveal', path: "/w/it's.txt" }).map((c) => c.argv)
    ).toEqual([
      [
        'gdbus',
        'call',
        '--session',
        '--dest',
        'org.freedesktop.FileManager1',
        '--object-path',
        '/org/freedesktop/FileManager1',
        '--method',
        'org.freedesktop.FileManager1.ShowItems',
        "['file:///w/it%27s.txt']",
        ''
      ],
      ['xdg-open', '/w']
    ])
    expect(hostCommands('darwin', { kind: 'reveal', path: '/w/a' })).toEqual([
      { argv: ['open', '-R', '/w/a'] }
    ])
    expect(hostCommands('win32', { kind: 'reveal', path: 'C:\\w\\a' })).toEqual([
      { argv: ['explorer.exe', '/select,C:\\w\\a'] }
    ])
    expect(
      hostCommands('darwin', { kind: 'notify', title: 'T"', body: 'B' })[0].argv.slice(-2)
    ).toEqual(['T"', 'B'])
    expect(hostCommands('win32', { kind: 'notify', title: 'T', body: 'B' })[0].env).toEqual({
      TERMUL_NOTIFY_TITLE: 'T',
      TERMUL_NOTIFY_BODY: 'B'
    })
  })

  test('falls back to the next command and reports every failure', async () => {
    const ran: string[] = []
    await runHostAction('linux', { kind: 'reveal', path: '/w/a' }, async ({ argv }) => {
      ran.push(argv[0])
      return argv[0] === 'gdbus' ? { code: 1, stderr: 'no FileManager1' } : { code: 0, stderr: '' }
    })
    expect(ran).toEqual(['gdbus', 'xdg-open'])
    await expect(
      runHostAction('linux', { kind: 'notify', title: 't', body: 'b' }, async () => ({
        code: 127,
        stderr: 'not found'
      }))
    ).rejects.toThrow('notify-send exited 127: not found')
  })
})
