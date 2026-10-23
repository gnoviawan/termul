/**
 * The scripted chat the scenario agent plays back, one turn per prompt. Paths
 * resolve against the session cwd (the seed tool points it at the repo root),
 * so tool locations and the bare path in the prose open real files.
 */

import path from 'node:path'

export type ToolKind = 'read' | 'edit' | 'execute' | 'search'

export type ToolContent =
  | { type: 'diff'; path: string; oldText: string; newText: string }
  | { type: 'content'; content: { type: 'text'; text: string } }

export interface ToolStep {
  step: 'tool'
  id: string
  title: string
  kind: ToolKind
  locations: Array<{ path: string; line?: number }>
  rawInput: Record<string, string>
  /** Content shown while the call is open (an edit's diff rides here). */
  content?: ToolContent[]
  /** What the completing `tool_call_update` carries. */
  output?: string
}

export type Step = { step: 'thought'; text: string } | { step: 'say'; text: string } | ToolStep

export const SCRIPT_PROMPTS = [
  'How does the web client decide which routes render the pane workspace?',
  'Make isWorkspaceRoutePath reject a bare `/c/` with no session id, and run the tests.',
  'Where else is the chat route parsed?'
]

const fence = '```'

const ROUTE_FILE = 'src/renderer/lib/workspace-route.ts'

const OLD_PREDICATE = `export function isWorkspaceRoutePath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/c/')
}`

const NEW_PREDICATE = `const CHAT_ROUTE = /^\\/c\\/[^/]+$/

export function isWorkspaceRoutePath(pathname: string): boolean {
  return pathname === '/' || CHAT_ROUTE.test(pathname)
}`

function turnExplain(cwd: string): Step[] {
  const app = path.join(cwd, 'src/renderer/App.tsx')
  return [
    {
      step: 'thought',
      text: 'The user wants the routing rule. The hash router lives in App.tsx, and there is a small predicate module for workspace routes. I should read both before answering, then show the route table.'
    },
    {
      step: 'tool',
      id: 'read-app',
      title: 'Read src/renderer/App.tsx',
      kind: 'read',
      locations: [{ path: app, line: 211 }],
      rawInput: { path: app },
      output: "const router = createHashRouter([\n  { path: '/', element: <WorkspaceLayout />, children: [...] }\n])"
    },
    {
      step: 'say',
      text: `## How workspace routes are chosen

The browser client uses a **hash router**, so every route lives after the \`#\` and a reload never hits the server for a page. The router is built once in src/renderer/App.tsx with \`createHashRouter\`, and the *pane workspace* stays mounted for two of its routes.

- \`/\` renders the dashboard inside the workspace.
- \`/c/:sessionId\` renders \`ChatRoute\`, which opens that chat in its own project.
- \`/snapshots\` swaps the pane area for the router outlet.

The decision itself is one pure function, so the layout and the mobile shell can never disagree:

${fence}typescript
export function isWorkspaceRoutePath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/c/')
}
${fence}

`
    },
    {
      step: 'tool',
      id: 'grep-callers',
      title: 'Run rg -n "isWorkspaceRoutePath" src/renderer',
      kind: 'execute',
      locations: [],
      rawInput: { command: 'rg -n "isWorkspaceRoutePath" src/renderer', cwd },
      output:
        'src/renderer/layouts/WorkspaceLayout.tsx:164:  const isWorkspaceRoute = isWorkspaceRoutePath(location.pathname)\nsrc/renderer/components/shell/ShellFrame.tsx:133:    : projects.length === 0 || !isWorkspaceRoutePath(pathname)\nsrc/renderer/lib/workspace-route.ts:25:  if (isWorkspaceRoutePath(pathname)) return false'
    },
    {
      step: 'say',
      text: `Three call sites depend on it, and they read it for different reasons:

1. \`WorkspaceLayout\` decides whether to mount the panes at all.
2. \`ShellFrame\` hides the project chrome on routes outside the workspace.
3. \`returnToWorkspaceRoute\` wraps the check and navigates to \`/\` when it fails.

| Route | Component | Panes mounted |
| --- | --- | :---: |
| \`/\` | \`WorkspaceDashboard\` | yes |
| \`/c/:sessionId\` | \`ChatRoute\` | yes |
| \`/snapshots\` | \`WorkspaceSnapshots\` | no |
| anything else | \`NotFound\` | no |

> The chat route is a *restore* mechanism, not a view. On reload the session reopens from the URL before the workspace record loads, which avoids the "no active chat" race.

${fence}mermaid
flowchart LR
  URL[hash URL] --> Router{createHashRouter}
  Router -->|/| Dashboard
  Router -->|/c/:sessionId| ChatRoute
  ChatRoute --> Open[openHistorySession]
  Router -->|/snapshots| Snapshots
${fence}

The router docs cover the hash variant in more depth: [createHashRouter](https://reactrouter.com/en/main/routers/create-hash-router).
`
    }
  ]
}

function turnEdit(cwd: string): Step[] {
  const file = path.join(cwd, ROUTE_FILE)
  return [
    {
      step: 'thought',
      text: '`startsWith("/c/")` also accepts `/c/` with nothing after it, and `/c/a/b`. A single anchored pattern rejects both. Run the lib tests after the edit.'
    },
    {
      step: 'tool',
      id: 'read-route',
      title: `Read ${ROUTE_FILE}`,
      kind: 'read',
      locations: [{ path: file, line: 10 }],
      rawInput: { path: file },
      output: OLD_PREDICATE
    },
    {
      step: 'tool',
      id: 'edit-route',
      title: `Edit ${ROUTE_FILE}`,
      kind: 'edit',
      locations: [{ path: file, line: 10 }],
      rawInput: { path: file },
      content: [{ type: 'diff', path: file, oldText: OLD_PREDICATE, newText: NEW_PREDICATE }]
    },
    {
      step: 'say',
      text: `I replaced the prefix check with an anchored pattern. A chat route now needs exactly one non-empty segment after \`/c/\`, so \`/c/\` and \`/c/a/b\` fall through to the router outlet.

`
    },
    {
      step: 'tool',
      id: 'run-tests',
      title: 'Run bun vitest run src/renderer/lib',
      kind: 'execute',
      locations: [],
      rawInput: { command: 'bun vitest run src/renderer/lib', cwd },
      output:
        ' ✓ src/renderer/lib/workspace-route.test.ts (6 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n   Duration  812ms'
    },
    {
      step: 'say',
      text: `### Result

All **6** route tests pass. To check it yourself:

${fence}bash
bun vitest run src/renderer/lib
rg -n "CHAT_ROUTE" src/renderer/lib
${fence}

- [x] Reject \`/c/\` with no id
- [x] Reject nested paths under \`/c/\`
- [ ] Add a test for a percent-encoded session id
`
    }
  ]
}

function turnFollowUp(cwd: string): Step[] {
  return [
    {
      step: 'thought',
      text: 'Search for the other place that matches the chat path, ChatRoute itself.'
    },
    {
      step: 'tool',
      id: 'search-route',
      title: 'Search "/c/" in src/renderer/components',
      kind: 'search',
      locations: [{ path: path.join(cwd, 'src/renderer/components/ChatRoute.tsx'), line: 111 }],
      rawInput: { pattern: '/c/', path: path.join(cwd, 'src/renderer/components') },
      output: "src/renderer/components/ChatRoute.tsx:111:    const match = location.pathname.match(/^\\/c\\/(.+)$/)"
    },
    {
      step: 'say',
      text: `One more place parses it: src/renderer/components/ChatRoute.tsx reads the id with \`/^\\/c\\/(.+)$/\`. That pattern still accepts \`/c/a/b\` and would hand \`a/b\` to \`openHistorySession\`. *Worth aligning* with the new \`CHAT_ROUTE\` constant in a follow-up.
`
    }
  ]
}

const TURNS = [turnExplain, turnEdit, turnFollowUp]

/** The scripted turn for the `index`-th prompt of a session (wraps around). */
export function scriptedTurn(index: number, cwd: string): Step[] {
  return TURNS[index % TURNS.length](cwd)
}
