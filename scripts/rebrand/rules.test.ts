import { describe, expect, it } from 'vitest'
import { rewrite } from './engine'
import type { Rule } from './rules'

const off = { repoRenamed: false }

function out(path: string, text: string, opts = off): string {
  return rewrite(path, text, opts).output
}

// Many keep patterns guard text no real rule reaches today. A case-insensitive
// catch-all proves each keep pattern still covers its documented examples.
const catchAll: Rule = {
  id: 'catch-all',
  category: 'display',
  description: 'test only',
  pattern: /termul/gi,
  replacement: 'X',
  include: ['**'],
  exclude: [],
  skipCode: false
}

describe('display rules', () => {
  it('collapses the long product name', () => {
    expect(rewrite('src/a.ts', 'Termul Manager is fast', off)).toEqual({
      output: 'Troupe is fast',
      hits: [{ ruleId: 'display-termul-manager', line: 1 }],
      kept: {}
    })
  })

  it('renames the capitalised word, possessives included', () => {
    expect(out('src/a.tsx', "Termul's panel")).toBe("Troupe's panel")
    expect(out('src-tauri/src/a.rs', '.title("Termul cannot start")')).toBe(
      '.title("Troupe cannot start")'
    )
  })

  it('leaves compound code identifiers alone', () => {
    expect(out('src/a.tsx', '<TermulIcon /> <TermulMark /> Termul_x')).toBe(
      '<TermulIcon /> <TermulMark /> Termul_x'
    )
  })

  it('still applies inside Markdown code fences', () => {
    expect(out('docs/a.md', '```\nTermul v1\n```\n')).toBe('```\nTroupe v1\n```\n')
  })
})

describe('URL rules', () => {
  it('moves docs paths under usetroupe.dev/docs', () => {
    expect(out('docs/a.md', 'https://docs.termul.dev/docs/getting-started')).toBe(
      'https://usetroupe.dev/docs/getting-started'
    )
  })

  it('sends the bare docs host to the docs root', () => {
    expect(out('docs/a.md', 'https://docs.termul.dev')).toBe('https://usetroupe.dev/docs')
  })

  it('renames the site host with and without www', () => {
    expect(out('landing/index.html', 'https://termul.dev/privacy/')).toBe(
      'https://usetroupe.dev/privacy/'
    )
    expect(out('landing/index.html', 'https://www.termul.dev/')).toBe('https://usetroupe.dev/')
  })

  it('does not read the storage key termul.deviceId as the site host', () => {
    expect(out('src/a.ts', "localStorage.getItem('termul.deviceId')")).toBe(
      "localStorage.getItem('termul.deviceId')"
    )
    expect(out('docs/a.md', 'The termul.deviceId key.')).toBe('The termul.deviceId key.')
  })

  it('renames repo links only once the repo is renamed', () => {
    const text = 'https://github.com/gnoviawan/termul/releases'
    expect(out('README.md', text)).toBe(text)
    expect(out('README.md', text, { repoRenamed: true })).toBe(
      'https://github.com/gnoviawan/troupe/releases'
    )
  })

  it('leaves repos that only share the prefix', () => {
    const text = 'https://github.com/gnoviawan/termul-docs'
    expect(out('README.md', text, { repoRenamed: true })).toBe(text)
  })
  it('leaves hosts and paths that only contain the old host', () => {
    const text =
      'https://my-docs.termul.dev https://termul.dev.example.com https://docs.termul.dev.evil.io'
    expect(out('docs/a.md', text)).toBe(text)
    expect(out('docs/a.md', 'https://docs.termul.dev/docs-extra')).toBe(
      'https://usetroupe.dev/docs/docs-extra'
    )
    expect(out('docs/a.md', 'See https://docs.termul.dev/docs. Or termul.dev.')).toBe(
      'See https://usetroupe.dev/docs. Or usetroupe.dev.'
    )
  })

  it('renames the .git clone URL but not a dotted sibling repo', () => {
    const on = { repoRenamed: true }
    expect(out('README.md', 'github.com/gnoviawan/termul.git', on)).toBe(
      'github.com/gnoviawan/troupe.git'
    )
    expect(out('README.md', 'github.com/gnoviawan/termul.wiki', on)).toBe(
      'github.com/gnoviawan/termul.wiki'
    )
    expect(out('README.md', 'https://example.com/github.com/gnoviawan/termul', on)).toBe(
      'https://example.com/github.com/gnoviawan/termul'
    )
    expect(out('README.md', 'git@github.com:x and https://github.com/gnoviawan/termul', on)).toBe(
      'git@github.com:x and https://github.com/gnoviawan/troupe'
    )
  })
})

describe('prose rule', () => {
  it('renames running text but not a bash fence in MDX', () => {
    const input = 'Install termul today.\n\n```bash\ntermul --help\n```\n'
    expect(out('website-docs/content/docs/install.mdx', input)).toBe(
      'Install troupe today.\n\n```bash\ntermul --help\n```\n'
    )
  })

  it('leaves inline code spans alone', () => {
    expect(out('docs/a.md', 'Run `termul` or termul.')).toBe('Run `termul` or troupe.')
    expect(out('docs/a.md', 'Run ``a ` termul`` here.')).toBe('Run ``a ` termul`` here.')
  })

  it('treats a backtick with no partner in its paragraph as text', () => {
    expect(out('docs/a.md', 'Use ` then termul.\n\nMore termul `here.')).toBe(
      'Use ` then troupe.\n\nMore troupe `here.'
    )
  })

  it('renames the word before punctuation and possessives', () => {
    expect(out('docs/a.md', "the termul app. termul's panel, termul.")).toBe(
      "the troupe app. troupe's panel, troupe."
    )
  })

  it('leaves paths and identifiers in prose', () => {
    const text =
      'termul-server, .termul/, termul.webAuthToken, src/termul, termul::web, termul_x, @termul, $termul'
    expect(out('docs/a.md', text)).toBe(text)
  })

  it('skips tilde fences, indented fences and an unclosed fence to EOF', () => {
    expect(out('docs/a.md', '~~~\ntermul\n~~~\ntermul')).toBe('~~~\ntermul\n~~~\ntroupe')
    expect(out('docs/a.md', '- step\n  ```sh\n  termul up\n  ```\n')).toBe(
      '- step\n  ```sh\n  termul up\n  ```\n'
    )
    expect(out('docs/a.md', 'termul\n```\ntermul\n')).toBe('troupe\n```\ntermul\n')
  })

  it('skips link destinations, autolinks and bare URLs', () => {
    expect(out('docs/a.md', '[termul](https://x.dev/?q=termul)')).toBe(
      '[troupe](https://x.dev/?q=termul)'
    )
    expect(out('docs/a.md', '<https://x.dev/?q=termul> and https://x.dev/?q=termul now')).toBe(
      '<https://x.dev/?q=termul> and https://x.dev/?q=termul now'
    )
  })

  it('skips MDX import and export lines but not the same line in plain Markdown', () => {
    expect(out('docs/a.mdx', 'import termul from "x"\n\ntermul')).toBe(
      'import termul from "x"\n\ntroupe'
    )
    expect(out('docs/a.md', 'import termul from "x"')).toBe('import troupe from "x"')
  })

  it('skips fences behind blockquote and list markers', () => {
    expect(out('docs/a.md', '> ```sh\n> termul up\n> ```\ntermul')).toBe(
      '> ```sh\n> termul up\n> ```\ntroupe'
    )
    expect(out('docs/a.md', '1. ```sh\n   termul up\n   ```\n')).toBe(
      '1. ```sh\n   termul up\n   ```\n'
    )
  })

  it('skips indented code blocks and raw HTML tags', () => {
    expect(out('docs/a.md', 'Run:\n\n    termul up\n\ntermul')).toBe(
      'Run:\n\n    termul up\n\ntroupe'
    )
    expect(out('docs/a.md', '<div id="termul">termul</div>')).toBe('<div id="termul">troupe</div>')
  })

  it('does not touch lowercase termul outside Markdown', () => {
    expect(out('src/a.ts', 'const name = "termul" // the termul app')).toBe(
      'const name = "termul" // the termul app'
    )
  })
})

describe('keep patterns block rules that would otherwise fire', () => {
  it.each([
    ['tauri-identifier', 'com.termul-manager.app.dev'],
    ['keychain-manager', 'com.termul.manager'],
    ['keychain-ssh', 'termul-ssh'],
    ['env-vars', 'TERMUL_WEB_AUTH_TOKEN'],
    ['binary-names', 'termul-server'],
    ['binary-names', 'termul_manager_lib'],
    ['mcp-name', 'mcp__termul__plan'],
    ['project-dir', '.termul/worktrees/abc'],
    ['storage-and-log-prefixes', 'termul.webAuthToken'],
    ['storage-and-log-prefixes', 'termul::web::relay']
  ])('%s protects %s', (id, text) => {
    expect(rewrite('src/a.ts', text, off, [catchAll])).toEqual({
      output: text,
      hits: [],
      kept: { [id]: 1 }
    })
  })

  it('does not mistake the docs host for the project dir', () => {
    expect(rewrite('docs/a.md', 'see docs.termul.dev', off, [catchAll]).output).toBe(
      'see docs.X.dev'
    )
  })

  it('keeps identifiers and keys under the real rules', () => {
    for (const text of [
      'TERMUL_WEB_AUTH_TOKEN',
      "localStorage.getItem('termul.webAuthToken')",
      'com.termul-manager.app'
    ]) {
      expect(out('src/a.ts', text)).toBe(text)
    }
  })

  it('mcp-name keeps "termul MCP" in prose', () => {
    expect(rewrite('docs/a.md', 'Use the termul MCP server.', off)).toEqual({
      output: 'Use the termul MCP server.',
      hits: [],
      kept: { 'mcp-name': 1 }
    })
  })

  it('product-name-field keeps productName', () => {
    const text = '{ "productName": "Termul Manager", "title": "Termul Manager" }'
    expect(rewrite('src-tauri/tauri.conf.json', text, off)).toEqual({
      output: '{ "productName": "Termul Manager", "title": "Troupe" }',
      hits: [{ ruleId: 'display-termul-manager', line: 1 }],
      kept: { 'product-name-field': 2 }
    })
  })

  it.each([
    ['Termul Manager.app', 2],
    ['Termul.Manager_1.2.3_x64.dmg', 1],
    ['Termul-1.0.0.AppImage', 1],
    ['Termul.exe', 1]
  ])('artifact-names keeps %s', (text, blocked) => {
    expect(rewrite('docs/a.md', text, off)).toEqual({
      output: text,
      hits: [],
      kept: { 'artifact-names': blocked }
    })
  })

  it.each([
    ['%LOCALAPPDATA%\\Termul\\sessions', 1],
    ['%LOCALAPPDATA%/Termul/projects.json', 1],
    ['base.join("Termul").join("sessions")', 1],
    ['C:\\Users\\me\\AppData\\Local\\Termul Manager', 2],
    ['AppData/Roaming/Termul', 1]
  ])('windows-state-dir keeps %s', (text, blocked) => {
    expect(rewrite('src-tauri/src/web/config.rs', text, off)).toEqual({
      output: text,
      hits: [],
      kept: { 'windows-state-dir': blocked }
    })
  })
})

describe('font-family keep', () => {
  it('keeps the bundled font family name in CSS and TS', () => {
    const css = 'font-family: "Termul Symbols";\n/* Termul icons */'
    expect(rewrite('src/renderer/index.css', css, off)).toEqual({
      output: 'font-family: "Termul Symbols";\n/* Troupe icons */',
      hits: [{ ruleId: 'display-termul', line: 2 }],
      kept: { 'font-family': 1 }
    })
  })
})

describe('keep paths', () => {
  it.each([
    'CHANGELOG.md',
    'website-docs/CHANGELOG.md',
    'bun.lock',
    'src-tauri/Cargo.lock',
    'scripts/rebrand/x.ts',
    'src-tauri/gen/x.json',
    'scripts/install.sh',
    'scripts/release/notes.md',
    '.github/workflows/release-nightly.yml',
    '_bmad-output/plan.md',
    'design.figcraft'
  ])('%s is returned unchanged', (path) => {
    expect(rewrite(path, 'Termul Manager and termul.dev', off)).toEqual({
      output: 'Termul Manager and termul.dev',
      hits: [],
      kept: {}
    })
  })

  it('the same text outside a keep path is rewritten', () => {
    expect(out('docs/notes.md', 'Termul Manager and termul.dev')).toBe('Troupe and usetroupe.dev')
  })
})
