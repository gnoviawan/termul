import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Upstream } from './upstream.ts'

const logPath = () => join(mkdtempSync(join(tmpdir(), 'canvas-eval-')), 'upstream.log')

function server(script: string) {
  return new Upstream(spawn(process.execPath, ['-e', script]), logPath())
}

describe('Upstream', () => {
  test('answers a request from the server', async () => {
    const upstream = server(
      `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const { id } = JSON.parse(line)
        console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }))
      })`
    )
    const reply = await upstream.request('ping', {})
    upstream.close()
    expect(reply.result).toEqual({ ok: true })
  })

  test('fails a pending request when the server exits without answering', async () => {
    const upstream = server(`process.stdin.once('data', () => process.exit(3))`)
    const reply = await upstream.request('tools/call', {})
    expect(reply.result).toBeUndefined()
    expect(String(reply.error?.message)).toContain('exited')
  })

  test('fails a request sent after the server exited', async () => {
    const upstream = server('process.exit(3)')
    await upstream.request('initialize', {})
    const reply = await upstream.request('tools/list', {})
    expect(String(reply.error?.message)).toContain('exited')
  })

  test('fails a request when the server cannot start', async () => {
    const upstream = new Upstream(spawn(join(tmpdir(), 'no-such-canvas-eval-server')), logPath())
    const reply = await upstream.request('initialize', {})
    expect(reply.error).toBeDefined()
  })
})
