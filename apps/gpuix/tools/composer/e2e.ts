/**
 * `bun tools/composer/e2e.ts`: drives the real ChatInputBar on GPUIX against a
 * seeded termul-server and asserts on the prompts the agent received.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { seedComposerServer } from './seed'
import { type GpuixApp, withScene } from './scene/session'

interface AgentPrompt {
  sessionId: string
  prompt: unknown[]
}

function fail(message: string): never {
  throw new Error(`composer e2e: ${message}`)
}

/** JSON with object keys sorted, so key order does not count as a difference. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  )
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  const a = canonical(actual)
  const e = canonical(expected)
  if (a !== e) fail(`${label}\n  expected ${e}\n  actual   ${a}`)
  console.log(`ok   ${label}`)
}

async function keys(app: GpuixApp, sequence: string): Promise<void> {
  await app.call('keystrokes', { keys: sequence })
  await Bun.sleep(150)
}

interface EditorState {
  text: string
  display: string
  menuOpen: boolean
}

async function editorState(app: GpuixApp): Promise<EditorState> {
  return JSON.parse(await app.getByTestId('composer-editor-state').textContent()) as EditorState
}

async function editorText(app: GpuixApp): Promise<string> {
  return (await editorState(app)).text
}

async function until<T>(label: string, read: () => Promise<T> | T, ok: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() - started > timeoutMs) fail(`${label}: last value ${JSON.stringify(value)}`)
    await Bun.sleep(100)
  }
}

async function allText(app: GpuixApp): Promise<string[]> {
  return (await app.call('getAllText', {})).text
}

async function waitText(app: GpuixApp, exact: string): Promise<void> {
  await until(`text "${exact}" on screen`, () => allText(app), (texts) => texts.includes(exact))
}

function prompts(log: string): AgentPrompt[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentPrompt)
}

const FAIL_SHOT = '/tmp/gpuix-o3/e2e-failure.png'
const seeded = await seedComposerServer()
const root = seeded.root
try {
  await withScene(seeded, { x: 240, y: 560, width: 800 }, async ({ app, grab }) => {
   try {
    await app.getByTestId('composer-editor').click()
    await Bun.sleep(200)

    await keys(app, '@')
    await waitText(app, 'No files or folders match. Try another name.')
    console.log('ok   "@" opens the mention menu')
    await keys(app, 'a p p')
    await waitText(app, 'src/app.ts')
    await until('a menu with options takes the arrow and Enter keys', () => editorState(app), (s) => s.menuOpen && s.text === '@app')
    console.log('ok   typing "app" filters the menu to src/app.ts')
    await keys(app, 'enter')
    await until('picking the file leaves a pill label and a space', () => editorText(app), (t) => t === '@app.ts ')
    console.log('ok   Enter in the menu inserts the file pill')

    await Bun.sleep(300)
    await keys(app, 'p l e a s e space r e v i e w')
    await keys(app, 'shift-enter')
    await keys(app, 'n o w')
    expectEqual('typing after the pill, Shift+Enter is a newline', await editorText(app), '@app.ts please review\nnow')

    await keys(app, 'enter')
    const first = await until('the agent receives the first prompt', () => prompts(seeded.promptLog), (p) => p.length === 1)
    expectEqual('the agent got the exact prompt blocks', first[0].prompt, [
      { type: 'text', text: '(app.ts) please review\nnow' },
      {
        type: 'resource_link',
        uri: `file://${path.join(root, 'src/app.ts')}`,
        name: 'app.ts',
        mimeType: 'text/typescript'
      }
    ])
    await until('Enter clears the composer', () => editorText(app), (t) => t === '')

    await keys(app, 'o p e n space @')
    await keys(app, 'a p i')
    await waitText(app, 'src/api.ts')
    await keys(app, 'enter')
    await until('second pill', () => editorText(app), (t) => t === 'open @api.ts ')
    await Bun.sleep(300)
    await keys(app, 'backspace')
    await until('one Backspace after "pill " removes the pill and its space', () => editorText(app), (t) => t === 'open ')
    console.log('ok   Backspace after a pill removes the whole pill')
    await Bun.sleep(300)
    await keys(app, 'n o w')
    await until('typing after the removed pill', () => editorText(app), (t) => t === 'open now')
    await keys(app, 'enter')
    const second = await until('the agent receives the second prompt', () => prompts(seeded.promptLog), (p) => p.length === 2)
    expectEqual('no file reference survives the deleted pill', second[1].prompt, [{ type: 'text', text: 'open now' }])

    await Bun.sleep(300)
    await keys(app, 'q u i c k enter')
    const third = await until('the agent receives the third prompt', () => prompts(seeded.promptLog), (p) => p.length === 3)
    expectEqual('Enter in the same frame as the typing sends the typed text', third[2].prompt, [{ type: 'text', text: 'quick' }])

    await app.getByTestId('composer-scene-commands').waitFor({ timeoutMs: 10_000 })
    await Bun.sleep(300)
    await keys(app, '/ c o m')
    await until('"/com" opens the slash menu with its command row', () => editorState(app), (s) => s.menuOpen && s.text === '/com')
    await keys(app, 'enter')
    await until('picking the command leaves a command pill', () => editorText(app), (t) => t === '/compact ')
    await Bun.sleep(300)
    await keys(app, 'n o w')
    await until('typing after the command pill', () => editorText(app), (t) => t === '/compact now')
    await keys(app, 'enter')
    const fourth = await until('the agent receives the command prompt', () => prompts(seeded.promptLog), (p) => p.length === 4)
    expectEqual('the command pill reaches the agent as /compact', fourth[3].prompt, [{ type: 'text', text: '/compact now' }])
   } catch (error) {
    await grab(FAIL_SHOT)
    await Bun.write('/tmp/gpuix-o3/e2e-tree.json', JSON.stringify(await app.call('getTree', {}), null, 1))
    await Bun.write('/tmp/gpuix-o3/e2e-painted.json', JSON.stringify(await app.call('getAllText', {})))
    console.error(`editor text at failure: ${JSON.stringify(await editorText(app))}; frame ${FAIL_SHOT}`)
    throw error
   }
  })
  console.log('composer e2e passed')
} finally {
  await seeded.stop()
}
