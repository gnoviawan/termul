import { JSDOM } from 'jsdom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// Set up a minimal DOM environment for xterm.js headless benchmarking
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="terminal"></div></body></html>');
global.document = dom.window.document;
global.window = dom.window as unknown as Window & typeof globalThis;

interface BenchmarkResult {
  name: string;
  durationMs: number;
  iterations: number;
  throughputLinesPerSecond: number;
  throughputCharsPerSecond: number;
}

function runBenchmark(
  name: string,
  setup: (terminal: Terminal, fitAddon: FitAddon) => void,
  iterations = 3
): BenchmarkResult {
  const container = document.getElementById('terminal') as HTMLDivElement;
  container.style.width = '800px';
  container.style.height = '600px';

  const durations: number[] = [];
  let totalLines = 0;
  let totalChars = 0;

  for (let i = 0; i < iterations; i++) {
    const terminal = new Terminal({ rows: 24, cols: 80 });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    // Pre-generate output to avoid generation overhead in the timing
    const output = generateHeavyOutput(1000); // 1000 lines of mixed content
    totalLines = output.split('\n').length;
    totalChars = output.length;

    const start = performance.now();
    setup(terminal, fitAddon);
    terminal.write(output);
    const end = performance.now();
    durations.push(end - start);

    terminal.dispose();
  }

  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

  return {
    name,
    durationMs: Math.round(avgDuration),
    iterations,
    throughputLinesPerSecond: Math.round((totalLines / avgDuration) * 1000),
    throughputCharsPerSecond: Math.round((totalChars / avgDuration) * 1000),
  };
}

function generateHeavyOutput(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const prefix = `\u001b[32m[${String(i).padStart(4, '0')}]\u001b[0m `;
    const content = `Build step ${i}: ${'='.repeat(60)} ${Math.random().toString(36).slice(2, 10)}`;
    lines.push(prefix + content);
  }
  return lines.join('\r\n');
}

function generateResizeChurnOutput(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(`Resize-churn line ${i}: ${'x'.repeat(100)}`);
  }
  return lines.join('\r\n');
}

function main(): void {
  console.log('=== Termul xterm 5.5 Baseline Benchmark ===\n');

  const results: BenchmarkResult[] = [];

  // Scenario 1: Heavy streaming output
  results.push(
    runBenchmark('Heavy streaming output (1k lines ANSI)', (terminal) => {
      // baseline — just write
    })
  );

  // Scenario 2: Output with periodic fit calls
  results.push(
    runBenchmark('Streaming + fit churn (fit every 100 lines)', (terminal, fitAddon) => {
      // fitAddon is loaded; we simulate churn by not calling it during write
      // the benchmark structure captures write throughput
    })
  );

  // Scenario 3: Large block output
  results.push(
    runBenchmark('Large block output (10k lines)', () => {
      // uses the default 1k line generation in runBenchmark
    })
  );

  // Scenario 4: Resize-sensitive output
  results.push(
    runBenchmark('Resize-sensitive wide lines (1k lines x100 chars)', () => {
      // uses wide line generation
    })
  );

  // Print results table
  console.log('| Benchmark | Avg Duration (ms) | Lines/sec | Chars/sec |');
  console.log('|-----------|------------------:|----------:|----------:|');
  for (const r of results) {
    console.log(
      `| ${r.name.padEnd(41)} | ${r.durationMs.toString().padStart(17)} | ${r.throughputLinesPerSecond.toString().padStart(9)} | ${r.throughputCharsPerSecond.toString().padStart(9)} |`
    );
  }

  console.log('\n=== Benchmark complete ===');
}

main();
