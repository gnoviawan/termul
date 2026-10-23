/**
 * Runs inside a terminal the client opened (bun, through the real PTY path)
 * and times the client's terminal emulator from the inside, so the number is
 * the same kind for xterm.js and for a GPUIX terminal.
 *
 * The probe is a cursor position request (CSI 6n). The emulator answers it
 * only after it has parsed every byte written before it, and the answer
 * travels back over the client's input path. Time to the answer is therefore
 * "client processed all output and replied", which excludes only the final
 * paint (at most one frame).
 *
 *   burst: write PERF_PROBE_LINES lines as fast as the PTY accepts, then
 *          probe once. Result: ms from first byte to the reply.
 *   paced: write PERF_PROBE_RATE lines/s for PERF_PROBE_SECONDS and probe
 *          once per second. Result: reply round-trip ms per probe.
 *
 * Content is the canned, seeded line mix of tools/perf/fake-agent/flood.ts.
 * The JSON result goes to PERF_PROBE_OUT.
 */
import { writeFileSync } from 'node:fs'
import { generateLine, mulberry32 } from '../../../../tools/perf/fake-agent/flood.ts'

const env = (name: string, fallback: number) => {
  const n = Number(Bun.env[name])
  return Number.isFinite(n) && Bun.env[name] !== '' && Bun.env[name] !== undefined ? n : fallback
}
const mode = Bun.env.PERF_PROBE_MODE ?? 'burst'
const outPath = Bun.env.PERF_PROBE_OUT
const rng = mulberry32(env('PERF_PROBE_SEED', 42))
const encoder = new TextEncoder()

let pendingReply: ((t: number) => void) | null = null
let replyBuf = ''
process.stdin.setRawMode?.(true)
process.stdin.on('data', (chunk: Buffer) => {
  replyBuf += chunk.toString('latin1')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the reply is an ESC sequence
  if (/\x1b\[\d+;\d+R/.test(replyBuf)) {
    replyBuf = ''
    const done = pendingReply
    pendingReply = null
    done?.(performance.now())
  }
})

function probe(timeoutMs: number): Promise<number | null> {
  const sent = performance.now()
  const { promise, resolve } = Promise.withResolvers<number | null>()
  const timer = setTimeout(() => {
    pendingReply = null
    resolve(null)
  }, timeoutMs)
  pendingReply = (t) => {
    clearTimeout(timer)
    resolve(t - sent)
  }
  process.stdout.write('\x1b[6n')
  return promise
}

async function write(text: string): Promise<number> {
  const bytes = encoder.encode(text)
  const { promise, resolve } = Promise.withResolvers<void>()
  if (process.stdout.write(bytes)) resolve()
  else process.stdout.once('drain', () => resolve())
  await promise
  return bytes.length
}

async function burst() {
  const lines = env('PERF_PROBE_LINES', 20000)
  const started = performance.now()
  let bytes = 0
  for (let i = 0; i < lines; i += 100) {
    let chunk = ''
    for (let j = i; j < Math.min(lines, i + 100); j++)
      chunk += `${generateLine('mixed', j, rng)}\r\n`
    bytes += await write(chunk)
  }
  const written = performance.now() - started
  const sent = performance.now()
  const rtt = await probe(120_000)
  const total = rtt === null ? null : sent - started + rtt
  return { mode, lines, bytes, writeMs: written, replyAfterWriteMs: rtt, totalMs: total }
}

async function paced() {
  const rate = env('PERF_PROBE_RATE', 200)
  const seconds = env('PERF_PROBE_SECONDS', 30)
  const started = performance.now()
  const rtts: Array<Promise<number | null>> = []
  let bytes = 0
  let i = 0
  let nextProbe = started + 1000
  const lineEvery = 1000 / rate
  while (performance.now() - started < seconds * 1000) {
    const due = Math.floor((performance.now() - started) / lineEvery)
    let chunk = ''
    for (; i < due; i++) chunk += `${generateLine('mixed', i, rng)}\r\n`
    if (chunk) bytes += await write(chunk)
    if (performance.now() >= nextProbe && pendingReply === null) {
      nextProbe = performance.now() + 1000
      rtts.push(probe(5000))
    }
    await Bun.sleep(5)
  }
  return { mode, rate, seconds, lines: i, bytes, rttMs: await Promise.all(rtts) }
}

const result = mode === 'paced' ? await paced() : await burst()
if (outPath) writeFileSync(outPath, JSON.stringify(result))
process.stdin.setRawMode?.(false)
process.stdout.write(`\r\n[perf-probe] ${JSON.stringify({ ...result, rttMs: undefined })}\r\n`)
process.exit(0)
