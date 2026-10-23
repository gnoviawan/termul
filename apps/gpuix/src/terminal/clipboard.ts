/**
 * GPUIX 0.11 exposes no clipboard API to JS, so text goes through the first
 * clipboard tool on PATH. Absent tools degrade to an in-process buffer so
 * copy then paste still round-trips inside the app.
 */
import { terminalLog } from './log'

type Tool = { copy: string[]; paste: string[] }

const TOOLS: Tool[] = [
  { copy: ['wl-copy'], paste: ['wl-paste', '--no-newline'] },
  {
    copy: ['xclip', '-selection', 'clipboard', '-in'],
    paste: ['xclip', '-selection', 'clipboard', '-out']
  },
  { copy: ['xsel', '--clipboard', '--input'], paste: ['xsel', '--clipboard', '--output'] },
  { copy: ['pbcopy'], paste: ['pbpaste'] }
]

let memory = ''
let resolved: Tool | null | undefined

function tool(): Tool | null {
  if (resolved !== undefined) return resolved
  resolved = TOOLS.find((candidate) => Bun.which(candidate.copy[0]!) !== null) ?? null
  if (!resolved)
    terminalLog('warn', 'clipboard.no-tool', { tried: TOOLS.map((t) => t.copy[0]).join(',') })
  return resolved
}

export async function copyText(text: string): Promise<void> {
  memory = text
  const found = tool()
  if (!found) return
  const proc = Bun.spawn(found.copy, {
    stdin: new TextEncoder().encode(text),
    stdout: 'ignore',
    stderr: 'ignore'
  })
  await proc.exited
}

export async function pasteText(): Promise<string> {
  const found = tool()
  if (!found) return memory
  const proc = Bun.spawn(found.paste, { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return proc.exitCode === 0 ? text : memory
}
