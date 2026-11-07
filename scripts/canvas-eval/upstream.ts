import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'

export type Json = Record<string, unknown>

export interface Rpc {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Json
  result?: Json
  error?: Json
}

/** One MCP server process the router talks to over newline-delimited JSON-RPC. */
export class Upstream {
  private next = 1
  private waiting = new Map<number, (reply: Rpc) => void>()
  private proc: ChildProcessWithoutNullStreams
  private name: string
  private dead: string | undefined

  constructor(proc: ChildProcessWithoutNullStreams, logPath: string) {
    this.proc = proc
    this.name = proc.spawnfile
    proc.stderr.pipe(createWriteStream(logPath, { flags: 'a' }))
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let reply: Rpc
      try {
        reply = JSON.parse(line)
      } catch {
        return
      }
      if (typeof reply.id === 'number') {
        this.waiting.get(reply.id)?.(reply)
        this.waiting.delete(reply.id)
      }
    })
    proc.on('exit', (code, signal) => this.fail(`exited (${code ?? signal})`))
    proc.on('error', (error) => this.fail(error.message))
    proc.stdin.on('error', (error) => this.fail(error.message))
  }

  /** Answers every pending and later request with an error, so callers never wait on a dead server. */
  private fail(why: string) {
    this.dead ??= `${this.name} ${why}, see its log`
    for (const [id, done] of this.waiting) done(this.failure(id))
    this.waiting.clear()
  }

  private failure(id: number): Rpc {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: this.dead } }
  }

  request(method: string, params: Json): Promise<Rpc> {
    const id = this.next++
    if (this.dead) return Promise.resolve(this.failure(id))
    return new Promise((done) => {
      this.waiting.set(id, done)
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async open(): Promise<Rpc> {
    const hello = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'canvas-eval', version: '1' }
    })
    if (!this.dead) {
      this.proc.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
      )
    }
    return hello
  }

  close() {
    this.proc.kill()
  }
}
