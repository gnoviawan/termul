/**
 * One running `termul-webview-host`: numbers each request, resolves it on its `ack`, and hands
 * every other event to `onEvent`. When the helper exits, pending requests resolve as failures and
 * `onExit` runs; the owner decides whether to start another.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { encodeCommand, type HostEvent, type HostRequest, parseEvent } from './protocol'

export type AckResult = { ok: true } | { ok: false; error: string }

export interface HostProcessOptions {
  binary: string
  args: readonly string[]
  /** The helper's environment; this process's when absent. */
  env?: NodeJS.ProcessEnv
  onEvent(event: HostEvent): void
  onStderr(line: string): void
  onExit(detail: string): void
}

export class HostProcess {
  readonly child: ChildProcess
  private nextReq = 1
  private readonly pending = new Map<number, (result: AckResult) => void>()
  private exited: string | null = null

  constructor(private readonly options: HostProcessOptions) {
    this.child = spawn(options.binary, [...options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env
    })
    if (!this.child.stdout || !this.child.stderr || !this.child.stdin) {
      throw new Error('webview host spawned without stdio pipes')
    }
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line))
    createInterface({ input: this.child.stderr }).on('line', (line) => options.onStderr(line))
    // A dead helper closes the pipe under a pending write; the exit handler reports it.
    this.child.stdin.on('error', () => {})
    this.child.on('error', (error) => this.finish(`spawn failed: ${error.message}`))
    this.child.on('exit', (code, signal) =>
      this.finish(signal ? `killed by ${signal}` : `exited with ${code}`)
    )
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get alive(): boolean {
    return this.exited === null
  }

  request(request: HostRequest): Promise<AckResult> {
    if (this.exited !== null)
      return Promise.resolve({ ok: false, error: `webview host ${this.exited}` })
    const req = this.nextReq++
    return new Promise((resolve) => {
      this.pending.set(req, resolve)
      this.child.stdin?.write(encodeCommand({ ...request, req }))
    })
  }

  /** Ask the helper to close every webview and exit; SIGTERM if it has not after `graceMs`. */
  quit(graceMs = 1000): void {
    if (this.exited !== null) return
    this.child.stdin?.end(encodeCommand({ op: 'quit' }))
    setTimeout(() => this.kill(), graceMs).unref()
  }

  /** Synchronous, for `process.on('exit')`. */
  kill(): void {
    if (this.exited === null) this.child.kill('SIGTERM')
  }

  private receive(line: string): void {
    const event = parseEvent(line)
    if (!event) {
      this.options.onStderr(`unparsed stdout line: ${line.slice(0, 200)}`)
      return
    }
    if (event.ev === 'ack') {
      const resolve = this.pending.get(event.req)
      this.pending.delete(event.req)
      resolve?.(event.ok ? { ok: true } : { ok: false, error: event.error })
      return
    }
    this.options.onEvent(event)
  }

  private finish(detail: string): void {
    if (this.exited !== null) return
    this.exited = detail
    for (const resolve of this.pending.values())
      resolve({ ok: false, error: `webview host ${detail}` })
    this.pending.clear()
    this.options.onExit(detail)
  }
}
