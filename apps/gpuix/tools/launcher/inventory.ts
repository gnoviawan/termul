/**
 * Count the Tauri-only capabilities the shared renderer still reaches.
 *
 * `bun tools/launcher/inventory.ts` scans `src/renderer` (no tests, `test-utils/`
 * or `tauri-stubs/`) and prints a markdown row per `CAPABILITIES` entry; `--json`
 * prints the counts as JSON and `--sites <id>` lists one capability's sites.
 *
 * - imports: runtime import / re-export statements of `modules`. A thin
 *   re-export facade such as `lib/tauri-window` counts as its package.
 * - binding refs: calls, member reads, generic calls and `new` of the names
 *   those imports bind, in the importing file, with strings and comments blanked.
 * - call sites: `patterns` matches in the comment-stripped source, for facades
 *   reached through the `lib/api` barrel and for DOM attributes.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

interface Capability {
  id: string
  label: string
  /** Call-site regexes, matched against the comment-stripped source. */
  patterns: readonly RegExp[]
  /** Package specifiers, or renderer-relative module paths without extension. */
  modules: readonly string[]
}

const cap = (
  id: string,
  label: string,
  patterns: RegExp[],
  modules: string[] = []
): Capability => ({
  id,
  label,
  patterns,
  modules
})
/** Calls of any of `names`, excluding their own `function name(` definitions. */
const calls = (names: string): RegExp => new RegExp(`(?<!function\\s)\\b(?:${names})\\(`, 'g')
const BROWSER_TAB =
  'browserTab(?:Create|Navigate|Resize|Show|Hide|Destroy|GoBack|GoForward|Reload|OpenDevtools|InjectAgentation)'
const UPDATER =
  'checkForUpdates|downloadUpdate|installAndRestart|getUpdaterState|setAutoUpdateEnabled|getAutoUpdateEnabled|registerUpdateEventHandlers|clearPendingUpdate'

export const CAPABILITIES: readonly Capability[] = [
  cap('tauri-context', 'isTauriContext() gates', [calls('isTauriContext')]),
  cap('web-unsupported', 'explicit WEB_UNSUPPORTED / NOT_TAURI results', [
    /code:\s*'(?:WEB_UNSUPPORTED|NOT_TAURI)'/g
  ]),
  cap('core-invoke', 'core invoke', [], ['@tauri-apps/api/core', 'lib/ipc/tauri']),
  cap('event-listen', 'event listen', [], ['@tauri-apps/api/event', 'lib/tauri-event']),
  cap(
    'window',
    'window controls / state / focus',
    [/\b(?:windowApi|visibilityApi)\.\w+/g, calls('onWindowFocus|hasAppCloseOwner')],
    ['@tauri-apps/api/window', 'lib/tauri-window']
  ),
  cap('drag-region', 'titlebar drag regions', [/data-tauri-drag-region/g]),
  cap(
    'webview-browser',
    'webviews and browser panes',
    [calls(`${BROWSER_TAB}|onBrowserTab\\w+|useBrowserWebview`)],
    ['@tauri-apps/api/webview', 'lib/tauri-webview']
  ),
  cap(
    'updater',
    'updater',
    [calls(UPDATER), /\btauriUpdaterApi\.\w+/g],
    ['@tauri-apps/plugin-updater']
  ),
  cap('process', 'process relaunch / exit', [], ['@tauri-apps/plugin-process']),
  cap('app-info', 'app version', [], ['@tauri-apps/api/app']),
  cap(
    'dialog',
    'dialogs / file pickers',
    [/\bdialogApi\.\w+\(/g, calls('registerWebDirectoryPicker')],
    ['@tauri-apps/plugin-dialog', 'lib/tauri-dialog']
  ),
  cap('opener', 'opener / reveal', [/\bopenerApi\.\w+\(/g], ['@tauri-apps/plugin-opener']),
  cap(
    'notification',
    'notifications',
    [calls('sendDesktopNotification|initNotificationPermissions')],
    ['@tauri-apps/plugin-notification']
  ),
  cap(
    'clipboard',
    'clipboard',
    [/\bclipboardApi\.\w+\(/g, calls('copyText'), /\bnavigator\.clipboard\.\w+\(/g],
    ['@tauri-apps/plugin-clipboard-manager']
  ),
  cap('os-info', 'os info', [/\bsystemApi\.\w+/g], ['@tauri-apps/plugin-os', 'lib/tauri-os']),
  cap('global-shortcuts', 'global shortcuts', [/\bkeyboardApi\.\w+/g, /plugin-global-shortcut/g]),
  cap('fs', 'plugin-fs', [], ['@tauri-apps/plugin-fs']),
  cap('path', 'api/path', [], ['@tauri-apps/api/path']),
  cap('store', 'plugin-store', [], ['@tauri-apps/plugin-store']),
  cap('ssh-sessions', 'SSH sessions', [
    /\bsshApi\.(?:openSession|respondHostKey|cancelSession|closeSession|listSessions|onSession\w+)\(/g
  ]),
  cap('ssh-sftp', 'SFTP', [/\bsshApi\.(?:sftp\w+|onTransferProgress)\(/g]),
  cap('ssh-port-forward', 'SSH port forwarding', [
    /\bsshApi\.(?:startPortForward|stopPortForward|onPortForwardStatusChanged)\(/g
  ]),
  cap('ssh-keys-import', 'SSH config import / keys / duplicate', [
    /\bsshApi\.(?:importConfig|duplicateProfile|inspectKey|listKeys)\(/g
  ]),
  cap('claude-accounts-manage', 'Claude account management', [
    /\bclaudeAccountsApi\.(?:add|login|cancelLogin|rename|remove|canManageAccounts)\(/g
  ]),
  cap('fs-stream-search', 'streaming content search', [
    /\bfilesystemApi\.(?:searchContentStream(?:Start|Cancel)|onSearchContent(?:Batch|Done))\(/g
  ])
]

const RENDERER_DIR = path.resolve(import.meta.dir, '../../../../src/renderer')
const SKIP_DIR = /(^|\/)(__tests__|test-utils|tauri-stubs)\//
const SKIP_FILE = /\.test\.tsx?$/

interface Site {
  file: string
  line: number
  what: string
}

interface Count {
  cap: Capability
  imports: number
  importFiles: number
  bindingRefs: Record<string, number>
  callSites: number
  callSiteFiles: number
  /** Call sites keyed by the matched text, whitespace collapsed. */
  matches: Record<string, number>
  sites: Site[]
}

const blank = (text: string): string => text.replace(/[^\n]/g, ' ')

/** Blank comments (and, with `strings`, string literals) keeping every offset. */
function strip(source: string, strings: boolean): string {
  return source.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, literal: string | undefined) =>
      literal !== undefined && !strings ? match : blank(match)
  )
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length

const IMPORT_RE =
  /(^|[\n;])[ \t]*(import|export)\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+[\w$]+|\*|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*['"]([^'"]+)['"]/g

function localBindings(keyword: string, clause: string): string[] {
  if (keyword === 'export') return []
  const names: string[] = []
  const namespace = /\*\s+as\s+([\w$]+)/.exec(clause)
  if (namespace?.[1]) names.push(namespace[1])
  const head = /^([\w$]+)/.exec(clause)
  if (head?.[1]) names.push(head[1])
  const braces = /\{([^}]*)\}/.exec(clause)
  for (const part of braces?.[1]?.split(',') ?? []) {
    const spec = part.trim()
    if (!spec || spec.startsWith('type ')) continue
    const alias = /\bas\s+([\w$]+)$/.exec(spec)
    names.push(alias?.[1] ?? spec)
  }
  return names
}

function moduleKey(specifier: string, file: string): string {
  if (specifier.startsWith('@/')) return specifier.slice(2)
  if (!specifier.startsWith('.')) return specifier
  return path.relative(
    RENDERER_DIR,
    path.resolve(path.dirname(path.join(RENDERER_DIR, file)), specifier)
  )
}

function scanFile(file: string, counts: Count[]): void {
  const source = readFileSync(path.join(RENDERER_DIR, file), 'utf8')
  const code = strip(source, false)
  let refsText = code
  const bound = new Map<string, string[]>()
  for (const m of code.matchAll(IMPORT_RE)) {
    const [whole, lead = '', keyword = '', typeOnly, clause = '', specifier = ''] = m
    const start = (m.index ?? 0) + lead.length
    refsText =
      refsText.slice(0, start) +
      blank(whole.slice(lead.length)) +
      refsText.slice(start + whole.length - lead.length)
    if (typeOnly) continue
    const key = moduleKey(specifier, file)
    for (const count of counts) {
      const { cap } = count
      if (!cap.modules.includes(key)) continue
      count.imports += 1
      count.sites.push({ file, line: lineAt(code, start), what: `import ${specifier}` })
      bound.set(cap.id, [...(bound.get(cap.id) ?? []), ...localBindings(keyword, clause)])
    }
  }
  refsText = strip(refsText, true)
  for (const count of counts) {
    const { cap } = count
    if (bound.has(cap.id)) count.importFiles += 1
    for (const name of new Set(bound.get(cap.id) ?? [])) {
      const re = new RegExp(`(?<![.\\w$])(?:new\\s+)?${name.replace(/\$/g, '\\$')}\\s*[(.<]`, 'g')
      for (const m of refsText.matchAll(re)) {
        count.bindingRefs[name] = (count.bindingRefs[name] ?? 0) + 1
        count.sites.push({ file, line: lineAt(refsText, m.index ?? 0), what: name })
      }
    }
    let hit = false
    for (const pattern of cap.patterns) {
      for (const m of code.matchAll(pattern)) {
        hit = true
        count.callSites += 1
        const what = m[0].replace(/\s+/g, ' ')
        count.matches[what] = (count.matches[what] ?? 0) + 1
        count.sites.push({ file, line: lineAt(code, m.index ?? 0), what })
      }
    }
    if (hit) count.callSiteFiles += 1
  }
}

function inventory(): { commit: string; files: number; counts: Count[] } {
  const counts = CAPABILITIES.map((cap): Count => {
    const empty = { imports: 0, importFiles: 0, callSites: 0, callSiteFiles: 0 }
    return { cap, ...empty, bindingRefs: {}, matches: {}, sites: [] }
  })
  const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: RENDERER_DIR })]
    .filter((file) => !SKIP_DIR.test(file) && !SKIP_FILE.test(file))
    .sort()
  for (const file of files) scanFile(file, counts)
  const git = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: RENDERER_DIR })
  return { commit: git.stdout.toString().trim(), files: files.length, counts }
}

const sum = (record: Record<string, number>): number =>
  Object.values(record).reduce((a, b) => a + b, 0)
const top = (record: Record<string, number>): string =>
  Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(', ')

const args = process.argv.slice(2)
const result = inventory()
const sitesFor = args[args.indexOf('--sites') + 1]

if (args.includes('--sites') && sitesFor) {
  const count = result.counts.find((c) => c.cap.id === sitesFor)
  if (!count) throw new Error(`unknown capability ${sitesFor}`)
  const sites = [...count.sites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  for (const site of sites) console.log(`src/renderer/${site.file}:${site.line}  ${site.what}`)
} else if (args.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        ...result,
        counts: result.counts.map(({ cap, sites: _, ...rest }) => ({
          id: cap.id,
          label: cap.label,
          ...rest
        }))
      },
      null,
      2
    )
  )
} else {
  console.log(`Scanned ${result.files} files under src/renderer at ${result.commit}.\n`)
  console.log(
    '| id | capability | imports | import files | binding refs | call sites | call-site files | detail |'
  )
  console.log('|---|---|---|---|---|---|---|---|')
  for (const c of result.counts) {
    const detail = [top(c.bindingRefs), top(c.matches)].filter(Boolean).join('; ')
    console.log(
      `| ${c.cap.id} | ${c.cap.label} | ${c.imports} | ${c.importFiles} | ${sum(c.bindingRefs)} | ${c.callSites} | ${c.callSiteFiles} | ${detail} |`
    )
  }
}
