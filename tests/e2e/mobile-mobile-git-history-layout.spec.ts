import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile Git History layout E2E (spec-mobile-git-history-layout): a phone-sized
 * browser opens the Git History tab of a REAL git repository through the web
 * client's mobile shell and checks what jsdom cannot compute: the measured
 * 44px two-line rows, single-line truncation through the flex chain, the lane
 * graph lined up with the rows in real layout, the 44px controls, the 16px
 * filter and the plain vertical scroller. The desktop shell gets one
 * regression test (30px single-line rows, `w-44` filter, 32px refresh).
 *
 * Fixture: a throwaway repository with a merge (two lanes), tags, a branch
 * with a very long name, a very long subject and a very long author name.
 * Every test registers its own project (a copy of the fixture) so no layout
 * or history state is shared with another test or suite.
 *
 * Not observable in a browser: the iOS focus-zoom behaviour itself (covered
 * through the computed 16px filter font size) and the landscape pass (V-06).
 */

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
})

test.setTimeout(90_000)

// ---------------------------------------------------------------------------
// Fixture repository
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000
const FEATURE_BRANCH = 'feature/phone-history-layout-with-a-deliberately-long-branch-name'
const LONG_AUTHOR = 'Maximilian Alexander Montgomery-Wellington III'
const LONG_SUBJECT =
  'feat(git): two-line 44px rows, a narrower lane graph, a full-width 16px filter and a 44px refresh so nothing overflows a 390px phone viewport'
const MERGE_SUBJECT = `Merge branch '${FEATURE_BRANCH}'`
const FILLER_COUNT = 14

/** Subjects of the fixture commits that the tests address by name. */
const SUBJECT = {
  root: 'chore: initial scaffold',
  base: 'feat: ship the v1.0 core',
  featureOne: LONG_SUBJECT,
  featureTwo: 'test(git): pin every row, ref and lane on the phone layout',
  mainFix: 'fix(git): trim the filter query',
  merge: MERGE_SUBJECT
} as const

/** The relative time each addressed commit renders (ages sit mid-bucket). */
const TIME_LABEL = {
  [SUBJECT.merge]: '2h',
  [SUBJECT.featureTwo]: '3h',
  [SUBJECT.mainFix]: '2d',
  [SUBJECT.featureOne]: '5d',
  [SUBJECT.base]: '6d'
} as const

function runGit(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })
}

function commitAs(cwd: string, subject: string, author: string, ageHours: number): void {
  const date = new Date(Date.now() - ageHours * HOUR_MS).toISOString()
  const email = `${author.split(' ')[0].toLowerCase()}@example.test`
  runGit(cwd, ['commit', '-q', '--allow-empty', '-m', subject], {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date
  })
}

/**
 * Oldest first: a root (70 days old, so its time renders as a locale date),
 * fourteen ref-less filler commits (1w-7w), a tagged base, a feature branch
 * (a very long subject; a very long author carrying the branch plus three
 * tags), one commit on main, then the --no-ff merge. 20 commits, 2 lanes.
 */
function buildHistoryRepo(dir: string): void {
  runGit(dir, ['init', '-q', '-b', 'main'])
  commitAs(dir, SUBJECT.root, 'Ada Lovelace', 70 * 24)
  for (let i = 1; i <= FILLER_COUNT; i++) {
    const ageDays = 53.5 - (i - 1) * 3.5 // 53.5d ... 8d
    commitAs(dir, `docs: reading note ${String(i).padStart(2, '0')}`, 'Grace Hopper', ageDays * 24)
  }
  commitAs(dir, SUBJECT.base, 'Ada Lovelace', 6 * 24)
  runGit(dir, ['tag', 'v1.0'])
  runGit(dir, ['checkout', '-q', '-b', FEATURE_BRANCH])
  commitAs(dir, SUBJECT.featureOne, 'Ada Lovelace', 5 * 24)
  commitAs(dir, SUBJECT.featureTwo, LONG_AUTHOR, 3.5)
  for (const tag of ['v1.1-rc1', 'v1.1-rc2', 'v1.1-rc3']) runGit(dir, ['tag', tag])
  runGit(dir, ['checkout', '-q', 'main'])
  commitAs(dir, SUBJECT.mainFix, 'Grace Hopper', 2.5 * 24)
  const mergeDate = new Date(Date.now() - 2.5 * HOUR_MS).toISOString()
  runGit(dir, ['merge', '--no-ff', '-q', '-m', MERGE_SUBJECT, FEATURE_BRANCH], {
    GIT_AUTHOR_NAME: 'Ada Lovelace',
    GIT_AUTHOR_EMAIL: 'ada@example.test',
    GIT_AUTHOR_DATE: mergeDate,
    GIT_COMMITTER_NAME: 'Ada Lovelace',
    GIT_COMMITTER_EMAIL: 'ada@example.test',
    GIT_COMMITTER_DATE: mergeDate
  })
}

interface OracleCommit {
  hash: string
  shortHash: string
  author: string
  subject: string
}

/** What `git log` itself says, newest first in topological order. */
function readOracle(dir: string): OracleCommit[] {
  const out = runGit(dir, ['log', '--topo-order', '--format=%H%x09%h%x09%an%x09%s'])
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, shortHash, author, subject] = line.split('\t')
      return { hash, shortHash, author, subject }
    })
}

let templateRepo = ''
let oracle: OracleCommit[] = []

test.beforeAll(async () => {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  templateRepo = join(root, `ghist-template-${randomUUID().slice(0, 8)}`)
  await mkdir(templateRepo, { recursive: true })
  buildHistoryRepo(templateRepo)
  oracle = readOracle(templateRepo)
  expect(oracle).toHaveLength(FILLER_COUNT + 6)
})

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

interface HistoryProject {
  name: string
  path: string
}

/** A fresh project (its own directory) the web client boots straight into. */
async function registerActiveProject(options: { withHistory: boolean }): Promise<HistoryProject> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-ghist-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  if (options.withHistory) {
    await cp(templateRepo, path, { recursive: true })
  } else {
    await mkdir(path, { recursive: true })
    runGit(path, ['init', '-q', '-b', 'main'])
  }
  const api = await request.newContext()
  try {
    const res = await api.post(`${E2E_BASE_URL}/projects`, {
      headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'content-type': 'application/json' },
      data: { id, name, path, color: 'blue' }
    })
    if (!res.ok()) throw new Error(`project registration failed: ${res.status()}`)
  } finally {
    await api.dispose()
  }
  await wsRequest(E2E_BASE_URL, 'store_write', {
    key: 'web-active-project',
    value: { _version: 1, data: id }
  })
  return { name, path }
}

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session, and that session
 * creation re-activates the pane. A tab opened BEFORE it lands is swapped out
 * from under the test (a test-only race: a person needs seconds to reach the
 * drawer). An agent that fails to start also ends the warm-up.
 */
function watchAgentWarmup(page: Page): Promise<void> {
  return new Promise<void>((resolve) => {
    page.on('websocket', (socket) => {
      if (socket.url().endsWith('/terminal/ws')) return
      const watched = new Map<string, string>()
      socket.on('framesent', (frame) => {
        const message = JSON.parse(String(frame.payload)) as { id?: string; type?: string }
        if (message.id && (message.type === 'create_session' || message.type === 'spawn_agent')) {
          watched.set(message.id, message.type)
        }
      })
      socket.on('framereceived', (frame) => {
        const reply = JSON.parse(String(frame.payload)) as { id?: string; ok?: boolean }
        const kind = reply.id ? watched.get(reply.id) : undefined
        if (kind === 'create_session' || (kind === 'spawn_agent' && reply.ok === false)) resolve()
      })
    })
  })
}

/** Land on the workspace of the freshly registered project, agent warmed up. */
async function bootInto(
  page: Page,
  project: HistoryProject,
  shell: 'phone' | 'desktop' = 'phone'
): Promise<void> {
  const warmedUp = watchAgentWarmup(page)
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  // The phone shell names the active project in its header; the desktop shell
  // lists it in the project sidebar. Seeing it proves we booted into our project.
  if (shell === 'phone') {
    await expect(
      page.getByRole('button', { name: new RegExp(`^${project.name}.*switch project$`) })
    ).toBeVisible()
  } else {
    await expect(page.getByLabel(`Project: ${project.name}`).first()).toBeVisible()
  }
  await warmedUp
}

interface HistoryPanel {
  project: HistoryProject
  filter: Locator
  refresh: Locator
  /** Every commit row (titled `<shortHash> — <subject>`), in on-screen order. */
  rows: Locator
  /** The row of the commit with this subject. */
  row: (subject: string) => Locator
}

function panelFor(page: Page, project: HistoryProject): HistoryPanel {
  const rows = page.getByTitle(/^[0-9a-f]{7,40} — /)
  return {
    project,
    filter: page.getByRole('textbox', { name: 'Filter commits' }),
    refresh: page.getByRole('button', { name: 'Refresh history' }),
    rows,
    row: (subject) => rows.filter({ has: page.getByText(subject, { exact: true }) })
  }
}

/** Phone: open the drawer and its "Git history" entry. */
async function openHistoryOnPhone(
  page: Page,
  options: { withHistory?: boolean } = {}
): Promise<HistoryPanel> {
  const project = await registerActiveProject({ withHistory: options.withHistory ?? true })
  await bootInto(page, project)
  await page.getByRole('button', { name: 'Open menu' }).tap()
  await page.getByRole('button', { name: 'Git history', exact: true }).tap()
  return panelFor(page, project)
}

/** Waits until the whole fixture history is on screen (in the DOM). */
async function expectFullHistory(panel: HistoryPanel): Promise<void> {
  await expect(panel.rows).toHaveCount(oracle.length)
}

// ---------------------------------------------------------------------------
// Measurement helpers (real layout, CSS px)
// ---------------------------------------------------------------------------

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no layout box (not rendered)')
  return box
}

/** The nearest vertically scrolling ancestor of a row (the plain list). */
function scrollerOf(row: Locator): Locator {
  return row.locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]')
}

/** The lane graph: the absolutely pinned, pointer-transparent svg of the list. */
function graphOf(scroller: Locator): Locator {
  return scroller.locator('svg.pointer-events-none')
}

/** [subject line, meta line] of a phone row. */
function linesOf(row: Locator): { subject: Locator; meta: Locator } {
  return { subject: row.locator(':scope > div').nth(0), meta: row.locator(':scope > div').nth(1) }
}

function shortHashOf(subject: string): string {
  const commit = oracle.find((c) => c.subject === subject)
  if (!commit) throw new Error(`fixture has no commit "${subject}"`)
  return commit.shortHash
}

// ---------------------------------------------------------------------------
// Mobile tests
// ---------------------------------------------------------------------------

test('every row is 44px with the subject over a meta line of refs, author, time and short hash in that order', async ({
  page
}) => {
  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)

  // Row order is what git itself reports.
  const titles = await panel.rows.evaluateAll((els) => els.map((el) => el.getAttribute('title')))
  expect(titles).toEqual(oracle.map((c) => `${c.shortHash} — ${c.subject}`))

  // Every row is exactly 44px tall in real layout.
  const heights = await panel.rows.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().height)
  )
  expect(heights).toEqual(oracle.map(() => 44))

  // The merge row: subject over the meta line; refs, author, time, hash in order.
  const merge = panel.row(SUBJECT.merge)
  const { subject, meta } = linesOf(merge)
  await expect(subject).toHaveText(SUBJECT.merge)
  const cells = await meta
    .locator(':scope > *')
    .evaluateAll((els) => els.map((el) => el.textContent?.trim()))
  expect(cells).toEqual([
    'main',
    'Ada Lovelace',
    TIME_LABEL[SUBJECT.merge],
    shortHashOf(SUBJECT.merge)
  ])

  const subjectBox = await boxOf(subject)
  const metaBox = await boxOf(meta)
  expect(subjectBox.y + subjectBox.height).toBeLessThanOrEqual(metaBox.y + 0.5)
  // Left to right on screen: refs, author, time, short hash.
  const xs = await meta
    .locator(':scope > *')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x))
  expect(xs).toEqual([...xs].sort((a, b) => a - b))

  // Two lines fit in 44px: 20px subject line + 16px meta line.
  expect(subjectBox.height).toBeCloseTo(20, 1)
  expect(metaBox.height).toBeCloseTo(16, 1)

  // Relative times of the addressed commits (the 70-day-old root shows a date).
  for (const [subjectText, label] of Object.entries(TIME_LABEL)) {
    const time = linesOf(panel.row(subjectText)).meta.locator(':scope > span').nth(1)
    await expect(time).toHaveText(label)
  }
  const rootTime = linesOf(panel.row(SUBJECT.root)).meta.locator(':scope > span').nth(1)
  await expect(rootTime).toHaveText(/\d{4}/)
})

test('a commit without refs starts its meta line with the author', async ({ page }) => {
  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)

  const { meta } = linesOf(panel.row('docs: reading note 07'))
  const cells = await meta
    .locator(':scope > *')
    .evaluateAll((els) => els.map((el) => el.textContent?.trim()))
  expect(cells).toEqual([
    'Grace Hopper',
    expect.stringMatching(/^\d+w$/),
    shortHashOf('docs: reading note 07')
  ])
})

test('a long subject, author and several refs stay on one line each while time and short hash stay whole', async ({
  page
}) => {
  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')

  // featureTwo carries the long author, the long branch and three tags.
  const row = panel.row(SUBJECT.featureTwo)
  const { meta } = linesOf(row)
  const rowBox = await boxOf(row)
  expect(rowBox.height).toBeCloseTo(44, 1)
  expect((await boxOf(meta)).height).toBeCloseTo(16, 1)

  const cells = meta.locator(':scope > *')
  await expect(cells).toHaveCount(4)
  const [refs, author, time, hash] = [cells.nth(0), cells.nth(1), cells.nth(2), cells.nth(3)]
  for (const tag of ['v1.1-rc1', 'v1.1-rc2', 'v1.1-rc3']) {
    await expect(refs).toContainText(tag)
  }
  await expect(author).toHaveText(LONG_AUTHOR)

  // The author is cut with an ellipsis on a single line (no wrapping).
  const authorState = await author.evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth,
    overflow: getComputedStyle(el).textOverflow,
    whiteSpace: getComputedStyle(el).whiteSpace,
    height: el.getBoundingClientRect().height
  }))
  expect(authorState).toEqual({
    clipped: true,
    overflow: 'ellipsis',
    whiteSpace: 'nowrap',
    height: expect.closeTo(16, 1)
  })

  // The refs are capped at half the meta line and clipped, not wrapped.
  const metaBox = await boxOf(meta)
  const refsBox = await boxOf(refs)
  expect(refsBox.width).toBeLessThanOrEqual(metaBox.width / 2 + 1)
  expect(refsBox.height).toBeLessThanOrEqual(16.5)
  expect(await refs.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

  // Time and short hash are never cut: whole text, inside the row, on screen.
  for (const [cell, text] of [
    [time, TIME_LABEL[SUBJECT.featureTwo]],
    [hash, shortHashOf(SUBJECT.featureTwo)]
  ] as const) {
    await expect(cell).toHaveText(text)
    expect(await cell.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const box = await boxOf(cell)
    expect(box.x).toBeGreaterThanOrEqual(rowBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.height).toBeCloseTo(16, 1)
  }

  // The very long subject of the feature commit is cut with an ellipsis on one line.
  const longSubject = linesOf(panel.row(SUBJECT.featureOne)).subject
  const subjectState = await longSubject.evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth,
    overflow: getComputedStyle(el).textOverflow,
    whiteSpace: getComputedStyle(el).whiteSpace,
    height: el.getBoundingClientRect().height
  }))
  expect(subjectState).toEqual({
    clipped: true,
    overflow: 'ellipsis',
    whiteSpace: 'nowrap',
    height: expect.closeTo(20, 1)
  })
  expect((await boxOf(panel.row(SUBJECT.featureOne))).height).toBeCloseTo(44, 1)
  // A short subject is shown whole: nothing is clipped without need.
  const shortSubject = linesOf(panel.row(SUBJECT.mainFix)).subject
  expect(await shortSubject.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
})

test('the list is a plain vertical scroller: rows clear the graph column and nothing scrolls sideways', async ({
  page
}) => {
  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')

  const row = panel.row(SUBJECT.merge)
  const scroller = scrollerOf(row)
  const state = await scroller.evaluate((el) => ({
    overflowY: getComputedStyle(el).overflowY,
    overflowX: getComputedStyle(el).overflowX,
    overscroll: getComputedStyle(el).overscrollBehaviorY,
    scrollsVertically: el.scrollHeight > el.clientHeight,
    scrollsSideways: el.scrollWidth > el.clientWidth,
    isRadixViewport: el.hasAttribute('data-radix-scroll-area-viewport')
  }))
  expect(state).toEqual({
    overflowY: 'auto',
    overflowX: 'hidden',
    overscroll: 'contain',
    scrollsVertically: true,
    scrollsSideways: false,
    isRadixViewport: false
  })
  await expect(page.locator('[data-radix-scroll-area-viewport]')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBeLessThanOrEqual(0)

  // Unfiltered rows start after the graph column (2 lanes: 16 + 12 * 2 = 40px)
  // and run to the list's right edge.
  const scrollerBox = await boxOf(scroller)
  const rowBox = await boxOf(row)
  expect(rowBox.x - scrollerBox.x).toBeCloseTo(40, 1)
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(viewport.width + 0.5)
  expect(scrollerBox.x).toBeGreaterThanOrEqual(0)
  expect(scrollerBox.x + scrollerBox.width).toBeLessThanOrEqual(viewport.width + 0.5)
})

test('the lane graph is drawn at the 44px pitch with 12px lanes and lines up with every row, scrolled or not', async ({
  page
}) => {
  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)

  const scroller = scrollerOf(panel.row(SUBJECT.merge))
  const graph = graphOf(scroller)
  await expect(graph).toHaveCount(1)

  // svg size: width = 16 + 12 * lanes (two lanes), height = 44 * rows.
  const rowCount = oracle.length
  await expect(graph).toHaveAttribute('width', '40')
  await expect(graph).toHaveAttribute('height', String(44 * rowCount))
  await expect(graph).toHaveAttribute('aria-hidden', 'true')
  const graphBox = await boxOf(graph)
  expect(graphBox.width).toBeCloseTo(40, 1)
  expect(graphBox.height).toBeCloseTo(44 * rowCount, 1)

  // Nodes: 8px padding + 12px per lane, centred on each 44px row, radius 4.
  const nodes = await graph.locator('circle').evaluateAll((els) =>
    els.map((el) => ({
      cx: Number(el.getAttribute('cx')),
      cy: Number(el.getAttribute('cy')),
      r: Number(el.getAttribute('r'))
    }))
  )
  expect(nodes).toHaveLength(rowCount)
  nodes.forEach((node, index) => {
    expect(node.cy, `node ${index} cy`).toBe(44 * index + 22)
    expect(node.r, `node ${index} r`).toBe(4)
    expect([8, 20], `node ${index} cx`).toContain(node.cx)
  })
  // Both lanes are used: the merge forks the history into two lanes.
  expect(new Set(nodes.map((node) => node.cx))).toEqual(new Set([8, 20]))
  // Edges are drawn between nodes.
  expect(await graph.locator('path').count()).toBeGreaterThanOrEqual(rowCount - 1)

  // Real layout: each node's centre sits on its row's centre line.
  const alignment = async () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll('[title]')].filter((el) =>
        /^[0-9a-f]{7,40} — /.test(el.getAttribute('title') ?? '')
      )
      const circles = [...document.querySelectorAll('svg.pointer-events-none > circle')]
      return rows.map((row, index) => {
        const r = row.getBoundingClientRect()
        const c = circles[index].getBoundingClientRect()
        return Math.abs(r.top + r.height / 2 - (c.top + c.height / 2))
      })
    })
  for (const offset of await alignment()) expect(offset).toBeLessThanOrEqual(0.5)

  // The graph lives inside the scroller: it scrolls with the rows and stays aligned.
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await expect(panel.row(SUBJECT.root)).toBeInViewport()
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  for (const offset of await alignment()) expect(offset).toBeLessThanOrEqual(0.5)
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false)
})

test('the header is a title row with a 44x44 refresh at its end over a full-width 44px, 16px filter', async ({
  page
}) => {
  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)

  // Existing strings and labels, verbatim.
  await expect(panel.filter).toHaveAttribute('placeholder', 'Filter commits...')
  await expect(panel.filter).toHaveAttribute('type', 'text')
  await expect(panel.refresh).toHaveAttribute('title', 'Refresh history')
  await expect(panel.refresh).toBeEnabled()

  const titleRow = panel.refresh.locator('xpath=..')
  await expect(titleRow).toContainText('Git History')

  const refreshBox = await boxOf(panel.refresh)
  const titleRowBox = await boxOf(titleRow)
  const filterBox = await boxOf(panel.filter)

  // 44x44 refresh, flush with the end of the title row.
  expect(refreshBox.width).toBeCloseTo(44, 1)
  expect(refreshBox.height).toBeCloseTo(44, 1)
  expect(refreshBox.x + refreshBox.width).toBeCloseTo(titleRowBox.x + titleRowBox.width, 1)

  // The title sits at the start of the same row, left of the refresh.
  const titleBox = await boxOf(titleRow.getByText('Git History', { exact: true }))
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(refreshBox.x)
  expect(titleBox.y).toBeGreaterThanOrEqual(titleRowBox.y)
  expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(titleRowBox.y + titleRowBox.height)

  // The filter is on its own row below, as wide as the title row, 44px tall.
  expect(filterBox.y).toBeGreaterThanOrEqual(titleRowBox.y + titleRowBox.height - 0.5)
  expect(filterBox.height).toBeCloseTo(44, 1)
  expect(filterBox.x).toBeCloseTo(titleRowBox.x, 1)
  expect(filterBox.width).toBeCloseTo(titleRowBox.width, 1)

  // 16px text: iOS does not zoom the page when the field takes focus.
  expect(await panel.filter.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  await panel.filter.tap()
  await expect(panel.filter).toBeFocused()
})

test('meta text (author, time, short hash) meets 4.5:1 contrast against the panel', async ({
  page
}) => {
  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)

  const { meta } = linesOf(panel.row(SUBJECT.merge))
  const cells = meta.locator(':scope > *')
  const ratios = await cells.evaluateAll((els) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no 2d canvas')
    const toRgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3] / 255]
    }
    const luminance = ([r, g, b]: number[]): number => {
      const lin = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }
    // The effective backdrop: the first ancestor with an opaque background.
    const backdropOf = (el: Element): number[] => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        const [r, g, b, a] = toRgba(getComputedStyle(node).backgroundColor)
        if (a >= 0.99) return [r, g, b]
      }
      return [0, 0, 0]
    }
    return els
      .slice(1) // author, time, short hash (the refs chips carry their own colours)
      .map((el) => {
        const [r, g, b, a] = toRgba(getComputedStyle(el).color)
        const bg = backdropOf(el)
        // Composite a translucent colour (an opacity modifier) over the backdrop.
        const fg = [r, g, b].map((channel, i) => channel * a + bg[i] * (1 - a))
        const l1 = luminance(fg)
        const l2 = luminance(bg)
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      })
  })
  expect(ratios).toHaveLength(3)
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5)
})

test('filtering hides the graph and lists the matching commits full width with a left inset', async ({
  page
}) => {
  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)
  // Addressed through the first visible row: the merge row itself is filtered out below.
  const scroller = scrollerOf(panel.rows.first())
  await expect(graphOf(scroller)).toHaveCount(1)

  // Case-insensitive author match: only the long-named author's commit.
  await panel.filter.fill('MAXIMILIAN')
  await expect(graphOf(scroller)).toHaveCount(0)
  await expect(panel.rows).toHaveCount(1)
  await expect(panel.row(SUBJECT.featureTwo)).toBeVisible()
  const row = panel.row(SUBJECT.featureTwo)
  const scrollerBox = await boxOf(scroller)
  const rowBox = await boxOf(row)
  // No graph column: the row starts at the left inset (pl-3 = 12px) and keeps its 44px.
  expect(rowBox.x - scrollerBox.x).toBeCloseTo(12, 1)
  expect(rowBox.x + rowBox.width).toBeCloseTo(scrollerBox.x + scrollerBox.width, 1)
  expect(rowBox.height).toBeCloseTo(44, 1)

  // A ref (tag) match.
  await panel.filter.fill('v1.1-rc2')
  await expect(panel.rows).toHaveCount(1)
  await expect(panel.row(SUBJECT.featureTwo)).toBeVisible()

  // A short hash and a full hash each match their own commit.
  const base = oracle.find((c) => c.subject === SUBJECT.base)
  if (!base) throw new Error('fixture has no base commit')
  await panel.filter.fill(base.shortHash)
  await expect(panel.rows).toHaveCount(1)
  await expect(panel.row(SUBJECT.base)).toBeVisible()
  await panel.filter.fill(base.hash)
  await expect(panel.rows).toHaveCount(1)
  await expect(panel.row(SUBJECT.base)).toBeVisible()

  // Subject and branch-name matches: the merge and the feature head, newest first.
  await panel.filter.fill('feature/phone')
  await expect(panel.rows).toHaveCount(2)
  const titles = await panel.rows.evaluateAll((els) => els.map((el) => el.getAttribute('title')))
  expect(titles).toEqual([
    `${shortHashOf(SUBJECT.merge)} — ${SUBJECT.merge}`,
    `${shortHashOf(SUBJECT.featureTwo)} — ${SUBJECT.featureTwo}`
  ])

  // Clearing the filter brings the graph and every row back.
  await panel.filter.fill('')
  await expect(graphOf(scroller)).toHaveCount(1)
  await expectFullHistory(panel)
})

test('a filter that matches nothing shows the verbatim message, even for a long unbroken query', async ({
  page
}) => {
  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')

  await panel.filter.fill('zzz-no-such-commit')
  await expect(page.getByText('No commits match "zzz-no-such-commit"')).toBeVisible()
  await expect(panel.rows).toHaveCount(0)

  // A pasted 40-char hash stays inside the viewport instead of being clipped sideways.
  const longQuery = `${'f'.repeat(40)}x`
  await panel.filter.fill(longQuery)
  const message = page.getByText(`No commits match "${longQuery}"`)
  await expect(message).toBeVisible()
  const box = await boxOf(message)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5)
  expect(await message.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
})

test("refresh asks the server for this project's log again and is disabled with a spinner while loading", async ({
  page
}) => {
  // The first request (fetch on reveal) passes; the refresh request is held
  // until released, so the loading state is observable without a sleep.
  let requests = 0
  const bodies: unknown[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/git/log', async (route) => {
    requests += 1
    bodies.push(route.request().postDataJSON())
    if (requests >= 2) await gate
    await route.continue()
  })

  const panel = await openHistoryOnPhone(page)
  await expectFullHistory(panel)
  expect(requests).toBe(1)
  await expect(panel.refresh).toBeEnabled()

  await panel.refresh.tap()
  await expect(panel.refresh).toBeDisabled()
  // The icon swaps for the (decorative) spinner and the history stays on screen.
  expect(requests).toBe(2)
  await expect(panel.rows).toHaveCount(oracle.length)
  const refreshBox = await boxOf(panel.refresh)
  expect(refreshBox.width).toBeCloseTo(44, 1)
  expect(refreshBox.height).toBeCloseTo(44, 1)

  release()
  await expect(panel.refresh).toBeEnabled()
  await expectFullHistory(panel)
  expect(bodies).toEqual([
    expect.objectContaining({ cwd: expect.stringContaining(panel.project.name) }),
    expect.objectContaining({ cwd: expect.stringContaining(panel.project.name) })
  ])
})

test('the first load shows "Loading history..." under the mobile header until the log arrives', async ({
  page
}) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/git/log', async (route) => {
    await gate
    await route.continue()
  })

  const panel = await openHistoryOnPhone(page)
  const loading = page.getByText('Loading history...')
  await expect(loading).toBeVisible()
  await expect(panel.rows).toHaveCount(0)
  // The mobile header is already there: title row, disabled refresh, filter below.
  await expect(panel.refresh).toBeDisabled()
  const refreshBox = await boxOf(panel.refresh)
  const filterBox = await boxOf(panel.filter)
  const loadingBox = await boxOf(loading)
  expect(filterBox.y).toBeGreaterThanOrEqual(refreshBox.y + refreshBox.height - 0.5)
  expect(loadingBox.y).toBeGreaterThanOrEqual(filterBox.y + filterBox.height - 0.5)

  release()
  await expect(loading).toBeHidden()
  await expectFullHistory(panel)
})

test('a repository without commits keeps the unchanged empty state under the mobile header', async ({
  page
}) => {
  const panel = await openHistoryOnPhone(page, { withHistory: false })

  await expect(page.getByRole('heading', { name: 'No commit history' })).toBeVisible()
  await expect(
    page.getByText('There are no commits to show yet. Make your first commit to see it here.')
  ).toBeVisible()
  await expect(panel.rows).toHaveCount(0)
  // The 44px refresh and the full-width filter are still the phone header.
  await expect(panel.refresh).toBeEnabled()
  expect((await boxOf(panel.refresh)).height).toBeCloseTo(44, 1)
  expect((await boxOf(panel.filter)).height).toBeCloseTo(44, 1)
})

test('a failed log request keeps the unchanged error empty state and raises the existing toast', async ({
  page
}) => {
  await page.route('**/git/log', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'boom (e2e)', code: 'GIT_LOG_ERROR' })
    })
  )

  const panel = await openHistoryOnPhone(page)

  await expect(page.getByRole('heading', { name: 'No commit history' })).toBeVisible()
  await expect(
    page.getByText('This folder may not be a Git repository, or git is unavailable.')
  ).toBeVisible()
  await expect(page.getByText(/^Failed to load git history: .*boom \(e2e\)/)).toBeVisible()
  await expect(panel.rows).toHaveCount(0)
  await expect(panel.refresh).toBeEnabled()
})

// ---------------------------------------------------------------------------
// Desktop shell regression (the matrix's "Desktop shell" row on the real surface)
// ---------------------------------------------------------------------------

test.describe('desktop shell', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  })

  test('keeps 30px single-line rows, the w-44 filter, the 32px refresh, the 16px-lane graph and ScrollArea', async ({
    page
  }) => {
    const project = await registerActiveProject({ withHistory: true })
    await bootInto(page, project, 'desktop')
    await page.getByRole('button', { name: 'Open git history' }).click()
    const panel = panelFor(page, project)
    await expectFullHistory(panel)

    // Rows: 30px, the original single-line column order (refs, subject, author, time, hash).
    const heights = await panel.rows.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height)
    )
    expect(heights).toEqual(oracle.map(() => 30))
    const merge = panel.row(SUBJECT.merge)
    const cells = merge.locator(':scope > *')
    await expect(cells).toHaveCount(5)
    const texts = await cells.evaluateAll((els) => els.map((el) => el.textContent?.trim()))
    expect(texts).toEqual([
      'main',
      SUBJECT.merge,
      'Ada Lovelace',
      TIME_LABEL[SUBJECT.merge],
      shortHashOf(SUBJECT.merge)
    ])
    const boxes = await cells.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, height: r.height }
      })
    )
    const rowBox = await boxOf(merge)
    for (const box of boxes) {
      // One line: every cell sits inside the 30px row, left to right.
      expect(box.y).toBeGreaterThanOrEqual(rowBox.y - 0.5)
      expect(box.y + box.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5)
    }
    expect(boxes.map((box) => box.x)).toEqual([...boxes.map((box) => box.x)].sort((a, b) => a - b))

    // Header: the w-44 (176px) filter and the 32px icon refresh on one row.
    expect((await boxOf(panel.filter)).width).toBeCloseTo(176, 1)
    const refreshBox = await boxOf(panel.refresh)
    expect(refreshBox.width).toBeCloseTo(32, 1)
    expect(refreshBox.height).toBeCloseTo(32, 1)
    expect(await panel.filter.evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px')

    // Graph: 20 + 16 * lanes (two) by 30 * rows, inside the Radix ScrollArea.
    const scroller = merge.locator('xpath=ancestor::*[@data-radix-scroll-area-viewport][1]')
    await expect(scroller).toHaveCount(1)
    const graph = graphOf(scroller)
    await expect(graph).toHaveAttribute('width', '52')
    await expect(graph).toHaveAttribute('height', String(30 * oracle.length))
    const nodes = await graph
      .locator('circle')
      .evaluateAll((els) => els.map((el) => [el.getAttribute('cx'), el.getAttribute('cy')]))
    expect(nodes[0]).toEqual(['10', '15'])
    expect(new Set(nodes.map(([cx]) => cx))).toEqual(new Set(['10', '26']))
  })
})
