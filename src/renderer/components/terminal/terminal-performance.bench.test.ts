import { describe, it, expect, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

/**
 * Terminal Performance Benchmark Suite
 *
 * These benchmarks establish a measurable baseline for xterm 5.5 heavy-output
 * performance. They are designed to be repeatable and comparable against future
 * xterm 6.1 migration validation.
 *
 * Benchmark philosophy:
 * - Measure terminal.write() throughput under representative workloads
 * - Capture frame time / duration for heavy streaming scenarios
 * - Include resize/fit churn sensitivity
 * - Keep scenarios Termul-specific rather than generic
 */

function generateHeavyOutput(lineCount: number): string {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    const prefix = `\u001b[32m[${String(i).padStart(4, '0')}]\u001b[0m `
    const content = `Build step ${i}: ${'='.repeat(60)} ${Math.random().toString(36).slice(2, 10)}`
    lines.push(prefix + content)
  }
  return lines.join('\r\n')
}

function generateWideLines(lineCount: number, width: number): string {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    lines.push(`Line ${i}: ${'x'.repeat(width)}`)
  }
  return lines.join('\r\n')
}

function createTerminal(): { terminal: Terminal; fitAddon: FitAddon; container: HTMLDivElement } {
  const container = document.createElement('div')
  container.style.width = '800px'
  container.style.height = '600px'
  document.body.appendChild(container)

  const terminal = new Terminal({ rows: 24, cols: 80 })
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(container)

  return { terminal, fitAddon, container }
}

interface BenchmarkResult {
  name: string
  durationMs: number
  lineCount: number
  charCount: number
  linesPerSecond: number
  charsPerSecond: number
}

function runBenchmark(name: string, lineCount: number, content: string): BenchmarkResult {
  const { terminal, container } = createTerminal()
  const start = performance.now()
  terminal.write(content)
  const end = performance.now()
  const durationMs = end - start
  terminal.dispose()
  container.remove()

  return {
    name,
    durationMs: Math.round(durationMs * 100) / 100,
    lineCount,
    charCount: content.length,
    linesPerSecond: Math.round((lineCount / durationMs) * 1000),
    charsPerSecond: Math.round((content.length / durationMs) * 1000),
  }
}

describe('Terminal performance baseline (xterm 5.5)', () => {
  const results: BenchmarkResult[] = []

  afterAll(() => {
    // Print summary table after all benchmarks run
    console.log('\n=== Termul xterm 5.5 Baseline Benchmark Results ===\n')
    console.log('| Benchmark | Lines | Chars | Duration (ms) | Lines/sec | Chars/sec |')
    console.log('|-----------|------:|------:|--------------:|----------:|----------:|')
    for (const r of results) {
      console.log(
        `| ${r.name.padEnd(39)} | ${r.lineCount.toString().padStart(5)} | ${r.charCount.toString().padStart(5)} | ${r.durationMs.toString().padStart(13)} | ${r.linesPerSecond.toString().padStart(9)} | ${r.charsPerSecond.toString().padStart(9)} |`
      )
    }
    console.log('\n=== Benchmark complete ===')
  })

  it('benchmark: heavy streaming output (1k ANSI lines)', () => {
    const content = generateHeavyOutput(1000)
    const result = runBenchmark('Heavy streaming (1k ANSI)', 1000, content)
    results.push(result)
    // Sanity: should complete in under 2 seconds for baseline health
    expect(result.durationMs).toBeLessThan(2000)
  })

  it('benchmark: large block output (5k lines)', () => {
    const content = generateHeavyOutput(5000)
    const result = runBenchmark('Large block (5k lines)', 5000, content)
    results.push(result)
    expect(result.durationMs).toBeLessThan(10000)
  })

  it('benchmark: resize-sensitive wide lines (1k x 120 chars)', () => {
    const content = generateWideLines(1000, 120)
    const result = runBenchmark('Wide lines (1k x 120)', 1000, content)
    results.push(result)
    expect(result.durationMs).toBeLessThan(3000)
  })

  it('benchmark: streaming with periodic fit churn', () => {
    const { terminal, fitAddon, container } = createTerminal()
    const chunks: string[] = []
    for (let i = 0; i < 10; i++) {
      chunks.push(generateHeavyOutput(100))
    }

    const start = performance.now()
    for (let i = 0; i < chunks.length; i++) {
      terminal.write(chunks[i])
      if (i % 3 === 0) {
        // Simulate fit churn every 3 chunks
        try {
          fitAddon.fit()
        } catch {
          /* ignore */
        }
      }
    }
    const end = performance.now()
    const durationMs = end - start

    terminal.dispose()
    container.remove()

    const lineCount = chunks.length * 100
    const charCount = chunks.reduce((sum, c) => sum + c.length, 0)

    results.push({
      name: 'Streaming + fit churn (1k lines)',
      durationMs: Math.round(durationMs * 100) / 100,
      lineCount,
      charCount,
      linesPerSecond: Math.round((lineCount / durationMs) * 1000),
      charsPerSecond: Math.round((charCount / durationMs) * 1000),
    })

    expect(durationMs).toBeLessThan(3000)
  })
})
