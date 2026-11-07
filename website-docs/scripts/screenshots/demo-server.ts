import { execSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEMO_PORT = Number(process.env.DEMO_PORT ?? 8199)
process.env.E2E_PORT = String(DEMO_PORT)
const { E2E_TOKEN, storeWrite } = await import('../../../tests/e2e/helpers')
export const DEMO_TOKEN = E2E_TOKEN
// Screenshots show project paths, so the demo lives at a readable fixed path.
export const DEMO_WORKSPACE_ROOT = process.env.DEMO_WORKSPACE ?? '/home/demo/projects'
const MARKER = '.termul-docs-demo'
export const DEMO_BASE_URL = `http://127.0.0.1:${DEMO_PORT}`

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

type Files = Record<string, string>

const shopFiles: Files = {
  'README.md': `# Acme Shop

A small storefront used to show off Troupe.

\`\`\`mermaid
flowchart LR
  Browser --> API[API server]
  API --> DB[(Postgres)]
  API --> Stripe
\`\`\`

## Getting started

\`\`\`bash
bun install
bun run dev
\`\`\`
`,
  'package.json': `{
  "name": "acme-shop",
  "private": true,
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest" }
}
`,
  'src/main.ts': `import { renderCart } from './cart'

const root = document.querySelector('#app')
if (root) renderCart(root, [])
`,
  'src/cart.ts': `export interface CartItem {
  sku: string
  name: string
  price: number
  quantity: number
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

export function renderCart(root: Element, items: CartItem[]): void {
  root.textContent = \`Total: $\${cartTotal(items).toFixed(2)}\`
}
`,
  'src/checkout.ts': `import { cartTotal, type CartItem } from './cart'

export async function checkout(items: CartItem[]): Promise<string> {
  const total = cartTotal(items)
  const res = await fetch('/api/checkout', { method: 'POST', body: JSON.stringify({ total }) })
  return (await res.json()).orderId
}
`,
  'docs/roadmap.md': `---
title: Roadmap
status: draft
owner: nadia
---

# Roadmap

- [x] Cart
- [ ] Discount codes
- [ ] Guest checkout
`
}

function git(cwd: string, cmd: string): void {
  execSync(`git -c user.email=dev@acme.test -c user.name="Acme Dev" ${cmd}`, {
    cwd,
    stdio: 'ignore'
  })
}

async function writeFiles(root: string, files: Files): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), body)
  }
}

async function makeShop(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  git(root, 'init -q -b main')
  await writeFiles(root, {
    'README.md': shopFiles['README.md'],
    'package.json': shopFiles['package.json']
  })
  git(root, 'add -A')
  git(root, 'commit -q -m "chore: scaffold project"')
  await writeFiles(root, {
    'src/cart.ts': shopFiles['src/cart.ts'],
    'src/main.ts': shopFiles['src/main.ts']
  })
  git(root, 'add -A')
  git(root, 'commit -q -m "feat(cart): add cart total"')
  await writeFiles(root, { 'src/checkout.ts': shopFiles['src/checkout.ts'] })
  git(root, 'add -A')
  git(root, 'commit -q -m "feat(checkout): post order to the API"')
  await writeFiles(root, { 'docs/roadmap.md': shopFiles['docs/roadmap.md'] })
  git(root, 'add -A')
  git(root, 'commit -q -m "docs: add roadmap"')
  git(root, 'branch feature/discounts')
  await writeFile(
    join(root, 'src/cart.ts'),
    shopFiles['src/cart.ts'].replace(
      'export function cartTotal',
      `export function applyDiscount(total: number, percent: number): number {
  return total * (1 - percent / 100)
}

export function cartTotal`
    )
  )
  await writeFile(
    join(root, 'src/discount.test.ts'),
    `import { expect, test } from 'vitest'
import { applyDiscount } from './cart'

test('applies a percentage discount', () => {
  expect(applyDiscount(100, 10)).toBe(90)
})
`
  )
}

async function makePlain(root: string, files: Files): Promise<void> {
  await writeFiles(root, files)
  git(root, 'init -q -b main')
  git(root, 'add -A')
  git(root, 'commit -q -m "initial commit"')
}

// The server, its agents and its terminals see a demo home folder and no
// secrets, so screenshots never show the real user's accounts, skills or env.
async function demoEnv(home: string): Promise<NodeJS.ProcessEnv> {
  await writeFile(
    join(home, '.bashrc'),
    "PS1='\\[\\e[32m\\]demo\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]$ '\n"
  )
  await writeFile(join(home, '.bash_profile'), '. ~/.bashrc\n')
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Acme Dev\n\temail = dev@acme.test\n')
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/TOKEN|KEY|SECRET|PASSWORD|CLAUDE|ANTHROPIC|OPENAI|GITHUB|^XDG_|^SSH_/i.test(key))
      env[key] = value
  }
  // Terminals outlive each shot's browser, so a section can open more than
  // the default 10 per project.
  return {
    ...env,
    HOME: home,
    SHELL: '/bin/bash',
    USER: 'demo',
    TERMUL_MAX_TERMINALS_PER_PROJECT: '30'
  }
}

export interface DemoServer {
  workspaceRoot: string
  stateDir: string
  stop: () => Promise<void>
}

async function resetWorkspace(root: string): Promise<void> {
  if (existsSync(root)) {
    if (!existsSync(join(root, MARKER)))
      throw new Error(`${root} exists and is not a docs demo workspace`)
    await rm(root, { recursive: true, force: true })
  }
  await mkdir(root, { recursive: true })
  await writeFile(join(root, MARKER), '')
}

export async function startDemoServer(): Promise<DemoServer> {
  const workspaceRoot = DEMO_WORKSPACE_ROOT
  await resetWorkspace(workspaceRoot)
  const stateDir = await mkdtemp(join(tmpdir(), 'termul-docs-state-'))
  const projects = [
    { id: 'demo-shop', name: 'acme-shop', color: 'blue' },
    { id: 'demo-api', name: 'payments-api', color: 'green' },
    { id: 'demo-blog', name: 'blog', color: 'purple' }
  ]
  await makeShop(join(workspaceRoot, 'acme-shop'))
  await makePlain(join(workspaceRoot, 'payments-api'), {
    'README.md': '# Payments API\n',
    'src/server.ts': 'export const port = 3000\n'
  })
  await makePlain(join(workspaceRoot, 'blog'), {
    'README.md': '# Blog\n',
    'posts/hello.md': '# Hello\n'
  })

  const binary =
    process.env.TERMUL_SERVER_BIN ?? join(repoRoot, 'src-tauri/target/release/troupe-server')
  const child = spawn(
    binary,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(DEMO_PORT),
      '--state-dir',
      stateDir,
      '--sessions-dir',
      join(stateDir, 'sessions'),
      '--projects-file',
      join(stateDir, 'projects.json')
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(await demoEnv(dirname(workspaceRoot))), TERMUL_WEB_AUTH_TOKEN: DEMO_TOKEN }
    }
  )
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: unknown) => {
      if (String(chunk).includes('ACP web server listening')) resolve()
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`troupe-server exited with ${code}`)))
  })
  const auth = { Authorization: `Bearer ${DEMO_TOKEN}`, 'content-type': 'application/json' }
  for (const p of projects) {
    const res = await fetch(`${DEMO_BASE_URL}/projects`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...p, path: join(workspaceRoot, p.name) })
    })
    if (!res.ok) throw new Error(`project ${p.name} registration failed: ${res.status}`)
  }
  // WebGL terminals render blank in 2x screenshots. The DOM renderer is a
  // setting users can pick, and it looks the same.
  await storeWrite('settings/app', { terminalRenderer: 'dom' })
  await storeWrite('acp/agents', [
    {
      id: 'demo-agent',
      templateId: 'demo-agent',
      configId: 'demo-agent',
      name: 'Demo Agent',
      command: 'bun',
      args: [join(dirname(fileURLToPath(import.meta.url)), 'demo-agent.ts')],
      env: {},
      allowTerminal: false
    }
  ])
  return {
    workspaceRoot,
    stateDir,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill('SIGTERM')
        await exited
      }
      await rm(stateDir, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  const server = await startDemoServer()
  console.log(`demo server on ${DEMO_BASE_URL}/#token=${DEMO_TOKEN}`)
  console.log(`workspace ${server.workspaceRoot}`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      await server.stop()
      process.exit(0)
    })
  }
}
