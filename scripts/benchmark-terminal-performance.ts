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

type BenchmarkPayload = string | (() => string);

async function runBenchmark(
  name: string,
  setup: (
    terminal: Terminal,
    fitAddon: FitAddon,
    output: string
  ) => void | boolean | Promise<void | boolean>,
  payload: BenchmarkPayload,
  iterations = 3
): Promise<BenchmarkResult> {
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

    const output = typeof payload === 'function' ? payload() : payload;
    totalLines = output.split(/\r\n|\r|\n/).length;
    totalChars = output.length;

    await new Promise<void>((resolve, reject) => {
      const start = performance.now();
      const finish = () => {
        const end = performance.now();
        durations.push(end - start);
        resolve();
      };

      Promise.resolve(setup(terminal, fitAddon, output))
        .then((handled) => {
          if (handled === true) {
            finish();
            return;
          }

          terminal.write(output, finish);
        })
        .catch(reject);
    });

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

function generateWideLines(lineCount: number, width: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(`Resize-churn line ${i}: ${'x'.repeat(width)}`);
  }
  return lines.join('\r\n');
}

async function main(): Promise<void> {
  console.log('=== Termul xterm 5.5 Baseline Benchmark ===\n');

  const results: BenchmarkResult[] = [];
  const baselinePayload = () => generateHeavyOutput(1000);
  const fitChurnPayload = () => generateHeavyOutput(1000);
  const tenKLinesPayload = () => generateHeavyOutput(10000);
  const wideLinesPayload = () => generateWideLines(1000, 100);

  // Scenario 1: Heavy streaming output
  results.push(
    await runBenchmark('Heavy streaming output (1k lines ANSI)', (terminal) => {
      // baseline — just write
    }, baselinePayload)
  );

  // Scenario 2: Output with periodic fit calls
  results.push(
    await runBenchmark(
      'Streaming + fit churn (fit every 100 lines)',
      async (terminal, fitAddon, output) => {
        const chunks = output.split('\r\n');
        const linesPerChunk = 100;

        for (let i = 0; i < chunks.length; i += linesPerChunk) {
          const chunk = chunks.slice(i, i + linesPerChunk).join('\r\n');
          await new Promise<void>((resolve) => {
            terminal.write(`${chunk}\r\n`, resolve);
          });

          try {
            fitAddon.fit();
          } catch {
            // Ignore fit errors if the container is not fully measurable yet.
          }
        }

        return true;
      },
      fitChurnPayload
    )
  );

  // Scenario 3: Large block output
  results.push(
    await runBenchmark('Large block output (10k lines)', () => {
      // large block payload is generated per run to match the benchmark label
    }, tenKLinesPayload)
  );

  // Scenario 4: Resize-sensitive output
  results.push(
    await runBenchmark('Resize-sensitive wide lines (1k lines x100 chars)', () => {
      // wide line payload is generated per run to match the benchmark label
    }, wideLinesPayload)
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

void main();
