import type { GitCommit } from '@shared/types/ipc.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getLog, toastError, mobileRef } = vi.hoisted(() => ({
  getLog: vi.fn(),
  toastError: vi.fn(),
  // Mutable so each describe block can flip the mobile branch on/off.
  mobileRef: { current: false as boolean }
}))

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/git-api', () => ({ gitApi: { getLog } }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

import { useGitHistoryStore } from '@/stores/git-history-store'
import { GitHistoryPanel } from './GitHistoryPanel'

const CWD = '/work'

const hoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

const fullHash = (short: string): string => short.padEnd(40, '0')

/**
 * Four commits, two lanes: a merge on lane 0 branches into lane 0 (feature A)
 * and lane 1 (feature B), and both feature commits rejoin the base on lane 0.
 * Newest first, as `git log` returns them.
 */
const MERGE = 'a1b2c3d'
const FEATURE_A = 'b2c3d4e'
const FEATURE_B = 'c3d4e5f'
const BASE = 'd4e5f6a'

function makeCommits(): GitCommit[] {
  return [
    {
      hash: fullHash(MERGE),
      shortHash: MERGE,
      parents: [fullHash(FEATURE_A), fullHash(FEATURE_B)],
      refs: ['HEAD -> refs/heads/main', 'refs/remotes/origin/main'],
      author: 'Ada Lovelace',
      date: hoursAgo(1),
      subject: 'Merge branch feature/login'
    },
    {
      hash: fullHash(FEATURE_A),
      shortHash: FEATURE_A,
      parents: [fullHash(BASE)],
      refs: ['tag: refs/tags/v1.0.0'],
      author: 'Grace Hopper',
      date: hoursAgo(3),
      subject: 'Add login form'
    },
    {
      hash: fullHash(FEATURE_B),
      shortHash: FEATURE_B,
      parents: [fullHash(BASE)],
      refs: [],
      author: 'Linus Torvalds',
      date: hoursAgo(48),
      subject: 'Fix typo in README'
    },
    {
      hash: fullHash(BASE),
      shortHash: BASE,
      parents: [],
      refs: [],
      author: 'Ada Lovelace',
      date: hoursAgo(21 * 24),
      subject: 'Initial commit'
    }
  ]
}

function seed(
  state: { commits?: GitCommit[]; loading?: boolean; error?: string | null } = {}
): void {
  useGitHistoryStore.setState({
    commits: state.commits ? { [CWD]: state.commits } : {},
    loading: state.loading ? { [CWD]: true } : {},
    error: state.error ? { [CWD]: state.error } : {}
  })
}

/**
 * One merge commit with six parents: six lanes, the widest graph the phone
 * geometry is sized for (88px of a 390px viewport, 116px on desktop geometry).
 */
function makeOctopus(): GitCommit[] {
  const tips = ['1111111', '2222222', '3333333', '4444444', '5555555', '6666666']
  return [
    {
      hash: fullHash('fffffff'),
      shortHash: 'fffffff',
      parents: tips.map(fullHash),
      refs: [],
      author: 'Ada Lovelace',
      date: hoursAgo(1),
      subject: 'Octopus merge'
    },
    ...tips.map((tip) => ({
      hash: fullHash(tip),
      shortHash: tip,
      parents: [],
      refs: [],
      author: 'Ada Lovelace',
      date: hoursAgo(2),
      subject: `Tip ${tip}`
    }))
  ]
}

/**
 * Two commits on one lane whose oldest parent lies beyond the fetch limit (it is
 * not in the list): the normal shape of any truncated history. The dangling edge
 * runs to the bottom of the graph.
 */
function makeTruncated(): GitCommit[] {
  return [
    {
      hash: fullHash('1111111'),
      shortHash: '1111111',
      parents: [fullHash('2222222')],
      refs: [],
      author: 'Ada Lovelace',
      date: hoursAgo(1),
      subject: 'Newest'
    },
    {
      hash: fullHash('2222222'),
      shortHash: '2222222',
      parents: [fullHash('9999999')],
      refs: [],
      author: 'Ada Lovelace',
      date: hoursAgo(2),
      subject: 'Oldest in the window'
    }
  ]
}

function renderPanel() {
  return render(<GitHistoryPanel cwd={CWD} isVisible />)
}

/** The commit-row element for a commit (rows carry `title="<short> — <subject>"`). */
function rowFor(commit: GitCommit): HTMLElement {
  return screen.getByTitle(`${commit.shortHash} — ${commit.subject}`)
}

/** The lane graph svg: the only svg pinned to the top-left corner. */
function graphSvg(container: HTMLElement): SVGSVGElement | null {
  return container.querySelector('svg.left-0.top-0')
}

const LANE_BLUE = 'oklch(var(--project-blue))'
const LANE_GREEN = 'oklch(var(--project-green))'

/**
 * Paint of the shared lane graph, identical on both shells (only the geometry
 * differs): the svg is decorative and pinned top-left, every edge is an unfilled
 * 1.5px stroke, every node is filled with its lane colour and ringed in the page
 * background. A bend takes the colour of the lane it lands on (`edge.toLane`), not
 * the lane it leaves, so the merge -> feature B bend (lane 0 to 1) is green and the
 * feature B -> base bend (lane 1 to 0) is blue. The `d` strings are the geometry
 * specific bends of the `makeCommits()` fixture.
 */
function expectLanePaint(
  svg: SVGSVGElement,
  bends: { toLaneOne: string; toLaneZero: string; straight: string }
): void {
  expect(svg.getAttribute('class')).toBe('absolute left-0 top-0 pointer-events-none')
  expect(svg.getAttribute('aria-hidden')).toBe('true')

  const circles = Array.from(svg.querySelectorAll('circle'))
  // Merge, feature A and base sit on lane 0 (blue); feature B on lane 1 (green).
  expect(circles.map((c) => c.getAttribute('fill'))).toEqual([
    LANE_BLUE,
    LANE_BLUE,
    LANE_GREEN,
    LANE_BLUE
  ])
  for (const circle of circles) {
    expect(circle.getAttribute('stroke')).toBe('oklch(var(--background))')
    expect(circle.getAttribute('stroke-width')).toBe('1.5')
  }

  const paths = Array.from(svg.querySelectorAll('path'))
  for (const path of paths) {
    expect(path.getAttribute('fill')).toBe('none')
    expect(path.getAttribute('stroke-width')).toBe('1.5')
  }
  const strokeOf = (d: string): string | null =>
    paths.find((path) => path.getAttribute('d') === d)?.getAttribute('stroke') ?? null
  expect(strokeOf(bends.toLaneOne)).toBe(LANE_GREEN)
  expect(strokeOf(bends.toLaneZero)).toBe(LANE_BLUE)
  expect(strokeOf(bends.straight)).toBe(LANE_BLUE)
}

function resetState(): void {
  vi.clearAllMocks()
  getLog.mockResolvedValue([])
  seed({ commits: makeCommits() })
}

describe('GitHistoryPanel desktop shell (characterization)', () => {
  beforeEach(() => {
    resetState()
    mobileRef.current = false
  })

  it('renders 30px single-line rows in the original column order', () => {
    renderPanel()
    const commits = makeCommits()

    for (const commit of commits) {
      const row = rowFor(commit)
      expect(row.style.height).toBe('30px')
      expect(row.className).toBe(
        'flex items-center gap-3 pr-3 border-b border-border/40 hover:bg-secondary/40 transition-colors'
      )
      expect(row.children).toHaveLength(5)
      const [refs, subject, author, time, hash] = Array.from(row.children) as HTMLElement[]

      // Order: refs, subject, author, relative time, short hash.
      expect(refs.className).toBe('flex items-center gap-1.5 shrink-0')
      expect(refs.children).toHaveLength(commit.refs.length)
      expect(subject.textContent).toBe(commit.subject)
      expect(subject.className).toBe('text-xs text-foreground truncate flex-1 min-w-0')
      expect(author.textContent).toBe(commit.author)
      expect(author.className).toBe(
        'text-3xs text-muted-foreground truncate max-w-[120px] shrink-0'
      )
      expect(time.className).toBe(
        'text-3xs tabular-nums text-muted-foreground/70 shrink-0 w-10 text-right'
      )
      expect(hash.textContent).toBe(commit.shortHash)
      expect(hash.className).toBe('font-mono text-3xs text-muted-foreground/60 shrink-0 w-14')
    }

    expect(Array.from(rowFor(commits[0]).children).map((el) => el.textContent)).toEqual([
      'mainorigin/main',
      'Merge branch feature/login',
      'Ada Lovelace',
      '1h',
      MERGE
    ])
  })

  it('keeps the w-44 text-xs filter and the h-8 w-8 refresh in the header', () => {
    renderPanel()

    const filter = screen.getByLabelText('Filter commits')
    expect(filter.getAttribute('type')).toBe('text')
    expect(filter.getAttribute('placeholder')).toBe('Filter commits...')
    expect(filter.className).toContain('w-44')
    expect(filter.className).toContain('text-xs')
    expect(filter.className).not.toContain('h-11')
    expect(filter.className).not.toContain('text-base')

    const refresh = screen.getByRole('button', { name: 'Refresh history' })
    expect(refresh.className).toContain('h-8 w-8')
    expect(refresh.className).not.toContain('h-11')
    expect(refresh.getAttribute('title')).toBe('Refresh history')
    expect(screen.getByText('Git History')).toBeInTheDocument()
  })

  it('calls refreshLog(cwd) on refresh click and disables the button with a spinner while loading', () => {
    // Never resolves, so the store stays in its loading state for the assertions.
    getLog.mockReturnValue(new Promise(() => {}))
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }))
    expect(getLog).toHaveBeenCalledTimes(1)
    expect(getLog.mock.calls[0][0]).toBe(CWD)

    // The click set loading in the store; the button now reflects it.
    const refresh = screen.getByRole('button', { name: 'Refresh history' })
    expect(refresh).toBeDisabled()
    expect(refresh.querySelector('.tm-comet')).not.toBeNull()
  })

  it('draws the lane graph with 20 + 16 * lanes by 30 * rows and a 30px row pitch', () => {
    const { container } = renderPanel()

    const svg = graphSvg(container)
    expect(svg).not.toBeNull()
    // Two lanes, four rows.
    expect(svg?.getAttribute('width')).toBe(String(20 + 16 * 2))
    expect(svg?.getAttribute('height')).toBe(String(30 * 4))

    const circles = Array.from(svg?.querySelectorAll('circle') ?? [])
    expect(
      circles.map((c) => [c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r')])
    ).toEqual([
      ['10', '15', '4'],
      ['10', '45', '4'],
      ['26', '75', '4'],
      ['10', '105', '4']
    ])

    // Lane 1 -> lane 0 bend (feature B to the base) is a curve between row pitches.
    const paths = Array.from(svg?.querySelectorAll('path') ?? []).map((p) => p.getAttribute('d'))
    expect(paths).toContain('M 26 75 C 26 90, 10 90, 10 105')
    expect(paths).toContain('M 10 15 L 10 45')

    // Edge and node paint (moved into the shared LaneGraph, so pinned here).
    expectLanePaint(svg as SVGSVGElement, {
      toLaneOne: 'M 10 15 C 10 45, 26 45, 26 75',
      toLaneZero: 'M 26 75 C 26 90, 10 90, 10 105',
      straight: 'M 10 15 L 10 45'
    })

    // Rows are offset right by the graph width.
    expect(rowFor(makeCommits()[0]).parentElement?.style.paddingLeft).toBe('52px')
  })

  it('runs an edge to the bottom of the graph when the parent is outside the fetched window', () => {
    seed({ commits: makeTruncated() })
    const { container } = renderPanel()

    const svg = graphSvg(container)
    expect(svg?.getAttribute('height')).toBe(String(30 * 2))
    const paths = Array.from(svg?.querySelectorAll('path') ?? []).map((p) => p.getAttribute('d'))
    expect(paths).toEqual(['M 10 15 L 10 45', 'M 10 45 L 10 60'])
  })

  it('wraps the list in the Radix ScrollArea', () => {
    const { container } = renderPanel()

    expect(container.querySelector('[data-radix-scroll-area-viewport]')).not.toBeNull()
  })

  it('floors the graph at one lane (max(1, laneCount))', () => {
    // One commit, one lane: width = 20 + 16 * 1, height = 30 * 1.
    const [only] = makeCommits().slice(3)
    seed({ commits: [only] })
    const { container } = renderPanel()

    const svg = graphSvg(container)
    expect(svg?.getAttribute('width')).toBe('36')
    expect(svg?.getAttribute('height')).toBe('30')
  })

  it('hides the graph and drops the row offset while filtering, matching subject, author, hash and refs', () => {
    const { container } = renderPanel()
    const commits = makeCommits()
    const filter = screen.getByLabelText('Filter commits')

    const expectOnly = (visible: GitCommit[]): void => {
      for (const commit of commits) {
        const query = screen.queryByTitle(`${commit.shortHash} — ${commit.subject}`)
        if (visible.includes(commit)) expect(query).not.toBeNull()
        else expect(query).toBeNull()
      }
    }

    fireEvent.change(filter, { target: { value: 'grace' } })
    expect(graphSvg(container)).toBeNull()
    expectOnly([commits[1]])
    expect(rowFor(commits[1]).parentElement?.style.paddingLeft).toBe('')

    fireEvent.change(filter, { target: { value: 'typo' } })
    expectOnly([commits[2]])

    fireEvent.change(filter, { target: { value: FEATURE_B } })
    expectOnly([commits[2]])

    fireEvent.change(filter, { target: { value: fullHash(BASE) } })
    expectOnly([commits[3]])

    fireEvent.change(filter, { target: { value: 'v1.0.0' } })
    expectOnly([commits[1]])

    fireEvent.change(filter, { target: { value: 'ada' } })
    expectOnly([commits[0], commits[3]])

    fireEvent.change(filter, { target: { value: '' } })
    expect(graphSvg(container)).not.toBeNull()
  })

  it('shows the verbatim no-match message', () => {
    renderPanel()

    fireEvent.change(screen.getByLabelText('Filter commits'), { target: { value: 'zzz' } })
    expect(screen.getByText('No commits match "zzz"')).toBeInTheDocument()
  })

  it('shows the loading line before the first load resolves', () => {
    seed({ loading: true })
    render(<GitHistoryPanel cwd={CWD} isVisible={false} />)

    const loading = screen.getByText('Loading history...')
    // Fills the area under the header and centres the line.
    expect(loading.className).toBe('flex-1 flex items-center justify-center text-muted-foreground')
    expect(getLog).not.toHaveBeenCalled()
  })

  it('keeps the EmptyState strings with and without a store error', () => {
    seed({ commits: [] })
    const { unmount } = renderPanel()
    expect(screen.getByText('No commit history')).toBeInTheDocument()
    expect(
      screen.getByText('There are no commits to show yet. Make your first commit to see it here.')
    ).toBeInTheDocument()
    unmount()

    seed({ commits: [], error: 'boom' })
    renderPanel()
    expect(
      screen.getByText('This folder may not be a Git repository, or git is unavailable.')
    ).toBeInTheDocument()
  })
})

describe('GitHistoryPanel mobile shell', () => {
  beforeEach(() => {
    resetState()
    mobileRef.current = true
  })

  /** Titles of every commit row (the refresh button's title has no " — "). */
  const visibleTitles = (container: HTMLElement): Array<string | null> =>
    Array.from(container.querySelectorAll('[title*=" — "]')).map((el) => el.getAttribute('title'))

  // Matrix: Rows and graph.
  it('renders two-line 44px rows: subject over refs, author, time, short hash', () => {
    renderPanel()
    const commits = makeCommits()

    for (const commit of commits) {
      const row = rowFor(commit)
      expect(row.style.height).toBe('44px')
      expect(row.children).toHaveLength(2)
      const [subject, meta] = Array.from(row.children) as HTMLElement[]

      // Line one: the subject alone.
      expect(subject.textContent).toBe(commit.subject)
      expect(subject.className).toContain('text-sm')
      expect(subject.className).toContain('leading-5')

      // Line two, in DOM order: refs (when present), author, time, short hash.
      expect(meta.className).toContain('leading-4')
      const cells = Array.from(meta.children) as HTMLElement[]
      const texts = cells.map((el) => el.textContent)
      const offset = commit.refs.length > 0 ? 1 : 0
      expect(cells).toHaveLength(3 + offset)
      expect(texts[offset]).toBe(commit.author)
      expect(texts[offset + 2]).toBe(commit.shortHash)
    }

    // Relative time sits between the author and the short hash.
    const meta = rowFor(commits[0]).children[1]
    expect(Array.from(meta.children).map((el) => el.textContent)).toEqual([
      'mainorigin/main',
      'Ada Lovelace',
      '1h',
      MERGE
    ])
  })

  it('draws the lane graph at a 44px pitch with 12px lanes, 16 + 12 * lanes wide', () => {
    const { container } = renderPanel()

    const svg = graphSvg(container)
    expect(svg).not.toBeNull()
    // Two lanes (width 40), four rows (height 176).
    expect(svg?.getAttribute('width')).toBe(String(16 + 12 * 2))
    expect(svg?.getAttribute('height')).toBe(String(44 * 4))

    const circles = Array.from(svg?.querySelectorAll('circle') ?? [])
    expect(
      circles.map((c) => [c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r')])
    ).toEqual([
      ['8', '22', '4'],
      ['8', '66', '4'],
      ['20', '110', '4'],
      ['8', '154', '4']
    ])

    const paths = Array.from(svg?.querySelectorAll('path') ?? []).map((p) => p.getAttribute('d'))
    expect(paths).toContain('M 20 110 C 20 132, 8 132, 8 154')
    expect(paths).toContain('M 8 22 L 8 66')

    // Same edge and node paint as the desktop shell.
    expectLanePaint(svg as SVGSVGElement, {
      toLaneOne: 'M 8 22 C 8 66, 20 66, 20 110',
      toLaneZero: 'M 20 110 C 20 132, 8 132, 8 154',
      straight: 'M 8 22 L 8 66'
    })

    // Unfiltered rows clear the graph column.
    expect(rowFor(makeCommits()[0]).parentElement?.style.paddingLeft).toBe('40px')
  })

  it('runs an edge to the bottom of the graph when the parent is outside the fetched window', () => {
    seed({ commits: makeTruncated() })
    const { container } = renderPanel()

    const svg = graphSvg(container)
    expect(svg?.getAttribute('height')).toBe(String(44 * 2))
    const paths = Array.from(svg?.querySelectorAll('path') ?? []).map((p) => p.getAttribute('d'))
    expect(paths).toEqual(['M 8 22 L 8 66', 'M 8 66 L 8 88'])
  })

  it('keeps a six-lane graph at 88px (116px on the desktop geometry)', () => {
    seed({ commits: makeOctopus() })
    const mobile = renderPanel()
    expect(graphSvg(mobile.container)?.getAttribute('width')).toBe('88')
    expect(graphSvg(mobile.container)?.getAttribute('height')).toBe(String(44 * 7))
    mobile.unmount()

    mobileRef.current = false
    const desktop = renderPanel()
    expect(graphSvg(desktop.container)?.getAttribute('width')).toBe('116')
  })

  // Matrix: No refs.
  it('omits the refs container for a commit without refs, so the meta line starts with the author', () => {
    renderPanel()
    const featureB = makeCommits()[2]

    const meta = rowFor(featureB).children[1] as HTMLElement
    expect(meta.children).toHaveLength(3)
    expect((meta.children[0] as HTMLElement).textContent).toBe(featureB.author)
    expect(meta.querySelector('[class*="max-w-"]')).toBeNull()
  })

  // Matrix: Overflow text.
  it('keeps every line single-line for long text: subject and author truncate, time and hash never shrink, refs clip at half', () => {
    const long: GitCommit = {
      hash: fullHash('eeeeeee'),
      shortHash: 'eeeeeee',
      parents: [],
      refs: [
        'HEAD -> refs/heads/feature/an-extremely-long-branch-name-that-keeps-going',
        'refs/remotes/origin/feature/an-extremely-long-branch-name-that-keeps-going',
        'tag: refs/tags/v10.20.30-release-candidate-with-a-long-suffix',
        'refs/heads/another/long/branch/name'
      ],
      author: 'A Very Long Author Name That Will Not Fit On A Phone Screen At All',
      date: hoursAgo(5),
      subject: 'x'.repeat(240)
    }
    seed({ commits: [long] })
    const { container } = renderPanel()

    const row = rowFor(long)
    expect(row.style.height).toBe('44px')
    const [subject, meta] = Array.from(row.children) as HTMLElement[]
    expect(subject.className).toContain('min-w-0')
    expect(subject.className).toContain('truncate')

    const [refs, author, time, hash] = Array.from(meta.children) as HTMLElement[]
    expect(refs.children).toHaveLength(4)
    expect(refs.className).toContain('max-w-[50%]')
    expect(refs.className).toContain('overflow-hidden')
    expect(refs.className).toContain('whitespace-nowrap')
    // Chips keep their own width and clip at the container edge; the container
    // itself may shrink (it is not `shrink-0`), so on a very narrow line the refs
    // give way before the time or the short hash is ever cut.
    expect(refs.className).toContain('min-w-0')
    expect(refs.className).toContain('[&>*]:shrink-0')
    expect(refs.className).not.toMatch(/(^|\s)shrink-0(\s|$)/)
    expect(author.className).toContain('min-w-0')
    expect(author.className).toContain('flex-1')
    expect(author.className).toContain('truncate')
    expect(time.className).toContain('shrink-0')
    expect(time.className).not.toContain('truncate')
    expect(hash.className).toContain('shrink-0')
    expect(hash.className).not.toContain('truncate')

    // Nothing in the list may wrap or scroll sideways.
    expect(container.querySelector('.flex-wrap')).toBeNull()
    expect(row.className).toContain('overflow-hidden')
    expect(row.className).not.toContain('whitespace-normal')
  })

  it('centres the two lines inside the 44px row the graph nodes align to', () => {
    renderPanel()

    const row = rowFor(makeCommits()[0])
    expect(row.style.height).toBe('44px')
    for (const token of ['flex', 'flex-col', 'justify-center', 'border-b']) {
      expect(row.className).toContain(token)
    }
    const meta = row.children[1] as HTMLElement
    for (const token of ['flex', 'min-w-0', 'items-center']) {
      expect(meta.className).toContain(token)
    }
  })

  it('keeps the 20px subject line for an empty subject so the meta line does not shift', () => {
    const blank: GitCommit = { ...makeCommits()[2], subject: '' }
    seed({ commits: [blank] })
    const { container } = renderPanel()

    // The title is "<short> — " with the subject empty; match it by prefix.
    const row = container.querySelector(`[title^="${blank.shortHash}"]`) as HTMLElement
    expect(row.style.height).toBe('44px')
    const [subject, meta] = Array.from(row.children) as HTMLElement[]
    expect(subject.textContent).toBe('')
    expect(subject.className).toContain('min-h-5')
    expect(meta.textContent).toContain(blank.author)
  })

  it('keeps meta text at full muted-foreground contrast (no opacity modifier)', () => {
    renderPanel()

    const meta = rowFor(makeCommits()[2]).children[1] as HTMLElement
    expect(meta.className).toContain('text-muted-foreground')
    for (const el of [meta, ...Array.from(meta.children)]) {
      expect(el.className).not.toMatch(/text-muted-foreground\//)
      expect(el.className).not.toMatch(/\bopacity-/)
    }
  })

  it('lists rows in a plain overflow-y-auto scroller, not the Radix ScrollArea', () => {
    const { container } = renderPanel()

    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement
    expect(scroller).not.toBeNull()
    for (const token of ['flex-1', 'overflow-y-auto', 'overflow-x-hidden', 'overscroll-contain']) {
      expect(scroller.className).toContain(token)
    }
    expect(scroller.contains(rowFor(makeCommits()[0]))).toBe(true)
    expect(container.querySelector('[data-radix-scroll-area-viewport]')).toBeNull()
  })

  // Matrix: Filtering and No match.
  it('hides the graph and insets full-width rows with pl-3 while filtering', () => {
    const { container } = renderPanel()
    const commits = makeCommits()

    fireEvent.change(screen.getByLabelText('Filter commits'), { target: { value: 'grace' } })

    expect(graphSvg(container)).toBeNull()
    expect(visibleTitles(container)).toEqual([`${commits[1].shortHash} — ${commits[1].subject}`])
    const rows = rowFor(commits[1]).parentElement as HTMLElement
    expect(rows.className).toContain('pl-3')
    expect(rows.style.paddingLeft).toBe('')

    fireEvent.change(screen.getByLabelText('Filter commits'), { target: { value: '' } })
    expect(graphSvg(container)).not.toBeNull()
    expect(rowFor(commits[0]).parentElement?.className ?? '').not.toContain('pl-3')
  })

  it('shows the same filtered subset as the desktop shell for every matcher', () => {
    const queries = [
      'grace',
      'typo',
      FEATURE_B,
      fullHash(BASE),
      'v1.0.0',
      'origin/main',
      'ada',
      'ZZZ'
    ]

    for (const query of queries) {
      mobileRef.current = true
      const mobile = renderPanel()
      fireEvent.change(screen.getByLabelText('Filter commits'), { target: { value: query } })
      const mobileTitles = visibleTitles(mobile.container)
      mobile.unmount()

      mobileRef.current = false
      const desktop = renderPanel()
      fireEvent.change(screen.getByLabelText('Filter commits'), { target: { value: query } })
      const desktopTitles = visibleTitles(desktop.container)
      desktop.unmount()

      expect(mobileTitles).toEqual(desktopTitles)
    }
  })

  it('shows the verbatim no-match message when nothing matches', () => {
    renderPanel()

    fireEvent.change(screen.getByLabelText('Filter commits'), { target: { value: 'zzz' } })
    expect(screen.getByText('No commits match "zzz"')).toBeInTheDocument()
  })

  it('lets a long unbroken query wrap in the no-match message instead of clipping sideways', () => {
    renderPanel()

    // The scroller is overflow-x-hidden, so an unbreakable word must wrap.
    const query = `${fullHash('f')}${fullHash('e')}`
    fireEvent.change(screen.getByLabelText('Filter commits'), { target: { value: query } })

    const message = screen.getByText(`No commits match "${query}"`)
    expect(message.className).toContain('break-words')
  })

  // Matrix: Header.
  it('puts the title row (with the refresh at its end) above a full-width 16px filter row', () => {
    renderPanel()

    const title = screen.getByText('Git History')
    const refresh = screen.getByRole('button', { name: 'Refresh history' })
    const filter = screen.getByLabelText('Filter commits')

    // Title and refresh share one row; the filter sits on its own row below.
    const titleRow = refresh.parentElement as HTMLElement
    expect(titleRow.contains(title)).toBe(true)
    expect(titleRow.lastElementChild).toBe(refresh)
    expect(titleRow.contains(filter)).toBe(false)
    expect(titleRow.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(filter.getAttribute('type')).toBe('text')
    expect(filter.getAttribute('placeholder')).toBe('Filter commits...')
    for (const token of ['h-11', 'w-full', 'text-base', 'pl-9']) {
      expect(filter.className).toContain(token)
    }
    // `text-base` replaces the shared field constant's `text-xs`.
    expect(filter.className).not.toContain('text-xs')
    expect(filter.className).not.toContain('w-44')

    // Glyph from the shared field constant.
    const glyph = filter.previousElementSibling as Element
    expect(glyph.getAttribute('class')).toContain('pointer-events-none')
    expect(glyph.getAttribute('class')).toContain('left-2.5')
  })

  // Matrix: Refresh.
  it('refreshes at 44x44, calls refreshLog(cwd), and disables with a spinner while loading', () => {
    // Never resolves, so the store stays in its loading state for the assertions.
    getLog.mockReturnValue(new Promise(() => {}))
    renderPanel()

    const refresh = screen.getByRole('button', { name: 'Refresh history' })
    expect(refresh.className).toContain('h-11')
    expect(refresh.className).toContain('w-11')
    expect(refresh.className).not.toContain('h-8')
    expect(refresh.getAttribute('title')).toBe('Refresh history')
    expect(refresh).not.toBeDisabled()
    expect(refresh.querySelector('.tm-comet')).toBeNull()

    fireEvent.click(refresh)
    expect(getLog).toHaveBeenCalledTimes(1)
    expect(getLog.mock.calls[0][0]).toBe(CWD)

    const loading = screen.getByRole('button', { name: 'Refresh history' })
    expect(loading).toBeDisabled()
    expect(loading.querySelector('.tm-comet')).not.toBeNull()
  })

  it('surfaces a failed refresh through the store error and toast, as on desktop', async () => {
    getLog.mockRejectedValue(new Error('boom'))
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0][0]).toContain('Failed to load git history')
    expect(useGitHistoryStore.getState().error[CWD]).toContain('boom')
    // Previously loaded commits stay on screen.
    expect(rowFor(makeCommits()[0])).toBeInTheDocument()
  })

  // Matrix: First load, Empty or error.
  it('shows the loading line under the mobile header before the first load resolves', () => {
    seed({ loading: true })
    render(<GitHistoryPanel cwd={CWD} isVisible={false} />)

    const loading = screen.getByText('Loading history...')
    // Same shared line as desktop: fills the area under the header, centred.
    for (const token of ['flex-1', 'items-center', 'justify-center']) {
      expect(loading.className).toContain(token)
    }
    expect(screen.getByText('Git History')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter commits').className).toContain('h-11')
  })

  it('keeps the EmptyState strings with and without a store error', () => {
    seed({ commits: [] })
    const { unmount } = renderPanel()
    expect(screen.getByText('No commit history')).toBeInTheDocument()
    expect(
      screen.getByText('There are no commits to show yet. Make your first commit to see it here.')
    ).toBeInTheDocument()
    unmount()

    seed({ commits: [], error: 'boom' })
    renderPanel()
    expect(
      screen.getByText('This folder may not be a Git repository, or git is unavailable.')
    ).toBeInTheDocument()
  })

  // Shared data flow.
  it('fetches on first reveal like the desktop shell, and only when visible', () => {
    seed()
    const { rerender } = render(<GitHistoryPanel cwd={CWD} isVisible={false} />)
    expect(getLog).not.toHaveBeenCalled()

    rerender(<GitHistoryPanel cwd={CWD} isVisible />)
    expect(getLog).toHaveBeenCalledTimes(1)
    expect(getLog.mock.calls[0][0]).toBe(CWD)
  })

  it('keeps the query and the data when the shell flips between phone and desktop layouts', () => {
    const { container, rerender } = renderPanel()
    fireEvent.change(screen.getByLabelText('Filter commits'), { target: { value: 'grace' } })
    expect(screen.getByLabelText('Filter commits').className).toContain('h-11')

    // All hooks sit above the early return, so flipping the layout is safe.
    mobileRef.current = false
    rerender(<GitHistoryPanel cwd={CWD} isVisible />)
    const desktopFilter = screen.getByLabelText('Filter commits') as HTMLInputElement
    expect(desktopFilter.className).toContain('w-44')
    expect(desktopFilter.value).toBe('grace')
    expect(visibleTitles(container)).toHaveLength(1)
    expect(container.querySelector('[data-radix-scroll-area-viewport]')).not.toBeNull()

    mobileRef.current = true
    rerender(<GitHistoryPanel cwd={CWD} isVisible />)
    expect((screen.getByLabelText('Filter commits') as HTMLInputElement).value).toBe('grace')
    expect(container.querySelector('[data-radix-scroll-area-viewport]')).toBeNull()
    expect(getLog).not.toHaveBeenCalled()
  })
})
