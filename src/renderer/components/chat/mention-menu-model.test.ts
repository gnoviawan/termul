import { describe, expect, it } from 'vitest'
import { commandToken, fileToken, SKILL_PAD_CHAR, skillToken } from '@/lib/skill-tokens'
import {
  activeMentionToken,
  buildMentionSections,
  type DirListing,
  isMentionTrigger,
  MAX_FOLDER_RESULTS,
  type MentionMatch,
  type MentionMenuInput,
  type MentionPanel,
  mentionPanelHeader,
  relativeDir,
  spliceMentionToken
} from './mention-menu-model'

describe('activeMentionToken', () => {
  it('opens on a bare @ at the start', () => {
    expect(activeMentionToken('@', 1)).toEqual({ at: 0, end: 1, query: '' })
  })

  it('opens on a leading @word with the caret at the end', () => {
    expect(activeMentionToken('@auth', 5)).toEqual({ at: 0, end: 5, query: 'auth' })
  })

  it('opens mid-text when @ is preceded by whitespace', () => {
    expect(activeMentionToken('look at @auth', 13)).toEqual({ at: 8, end: 13, query: 'auth' })
  })

  it('does NOT open when @ is preceded by a word char (email@host)', () => {
    expect(activeMentionToken('email@host', 10)).toBeNull()
  })

  it('does NOT open when there is no @', () => {
    expect(activeMentionToken('no mention here', 15)).toBeNull()
  })

  it('does NOT open on an empty input', () => {
    expect(activeMentionToken('', 0)).toBeNull()
  })

  it('closes the token at the first whitespace after @', () => {
    // caret right after `auth` (before the space) → still open
    expect(activeMentionToken('@auth foo', 5)).toEqual({ at: 0, end: 5, query: 'auth' })
    // caret after the space → closed
    expect(activeMentionToken('@auth foo', 6)).toBeNull()
    // caret at end of text → closed
    expect(activeMentionToken('@auth foo', 9)).toBeNull()
  })

  it('resolves to the nearest valid @ token when several exist', () => {
    expect(activeMentionToken('@a @b', 5)).toEqual({ at: 3, end: 5, query: 'b' })
    expect(activeMentionToken('@a @b', 2)).toEqual({ at: 0, end: 2, query: 'a' })
  })

  it('treats a second @ as a token boundary, not part of the query', () => {
    // @a@b with caret at end: the second @ is invalid (prev='a'), and the
    // first @'s word ends at the second @, so the caret is outside it → null.
    expect(activeMentionToken('@a@b', 4)).toBeNull()
  })

  it('uses the full @word as the query when the caret is mid-word', () => {
    // `@au|th` → the word is `auth`; splice will replace the whole word.
    expect(activeMentionToken('@auth', 3)).toEqual({ at: 0, end: 5, query: 'auth' })
  })

  it('rejects an out-of-range caret', () => {
    expect(activeMentionToken('@auth', -1)).toBeNull()
    expect(activeMentionToken('@auth', 99)).toBeNull()
  })

  it('opens when @ is glued to a pill', () => {
    const skill = skillToken('design', SKILL_PAD_CHAR)
    const skillValue = `${skill}@auth`
    expect(activeMentionToken(skillValue, skillValue.length)).toEqual({
      at: skill.length,
      end: skillValue.length,
      query: 'auth'
    })
    const command = commandToken('compact')
    const commandValue = `${command}@auth`
    expect(activeMentionToken(commandValue, commandValue.length)).toEqual({
      at: command.length,
      end: commandValue.length,
      query: 'auth'
    })
    const file = fileToken('a.ts', '/work/a.ts')
    const fileValue = `${file}@b`
    expect(activeMentionToken(fileValue, fileValue.length)).toEqual({
      at: file.length,
      end: fileValue.length,
      query: 'b'
    })
  })
})

describe('isMentionTrigger', () => {
  it('mirrors activeMentionToken presence', () => {
    expect(isMentionTrigger('@auth', 5)).toBe(true)
    expect(isMentionTrigger('email@host', 10)).toBe(false)
    expect(isMentionTrigger('', 0)).toBe(false)
  })
})

describe('spliceMentionToken', () => {
  it('removes the @token from a leading mention', () => {
    const token = activeMentionToken('@auth', 5)!
    expect(spliceMentionToken('@auth', token)).toBe('')
  })

  it('removes only the @token, preserving surrounding text', () => {
    // caret 13 = right after `@auth`, before the trailing space.
    const token = activeMentionToken('look at @auth now', 13)!
    expect(spliceMentionToken('look at @auth now', token)).toBe('look at  now')
  })

  it('removes the nearest token when several exist', () => {
    const token = activeMentionToken('@a @b', 5)!
    expect(spliceMentionToken('@a @b', token)).toBe('@a ')
  })

  it('removes the whole @word when the caret was mid-word', () => {
    const token = activeMentionToken('@auth', 3)!
    expect(spliceMentionToken('@auth', token)).toBe('')
  })
})

const ROOT = '/root/termul'

const match = (relPath: string, ignored = false): MentionMatch => ({
  relPath,
  absPath: `${ROOT}/${relPath}`,
  name: relPath.split('/').pop() ?? relPath,
  ignored
})

const dirMatch = (relPath: string, ignored = false): MentionMatch => ({
  relPath,
  absPath: `${ROOT}/${relPath}/`,
  name: relPath.split('/').pop() ?? relPath,
  ignored,
  kind: 'dir'
})

const ROOT_PANEL: MentionPanel = { kind: 'root' }
const explorer = (dir: string): MentionPanel => ({ kind: 'explorer', dir })

function sections(input: Partial<MentionMenuInput>) {
  return buildMentionSections({
    panel: ROOT_PANEL,
    root: ROOT,
    filter: '',
    matches: [],
    recents: [],
    conversations: [],
    ...input
  })
}

const conversation = (sessionId: string, title: string, agentName: string | null = 'Claude') => ({
  sessionId,
  title,
  agentName,
  lastActivityAt: 0,
  running: false
})

function shown(input: Partial<MentionMenuInput>) {
  return sections(input).map((s) => ({
    id: s.id,
    heading: s.heading,
    notice: s.notice,
    rows: s.items.map((i) => `${i.row.kind}:${i.label}`)
  }))
}

describe('buildMentionSections: root panel', () => {
  it('shows the Conversations and Explorer categories on a bare @, even with recents', () => {
    const [section] = sections({
      recents: [match('README.md')],
      conversations: [conversation('a', 'One'), conversation('b', 'Two')]
    })
    expect(section.items).toEqual([
      {
        key: 'category:conversations',
        label: 'Conversations',
        description: '2 in this project',
        ignored: false,
        row: { kind: 'category', target: 'conversations' }
      },
      {
        key: 'category:explorer',
        label: 'Explorer',
        description: 'Files and folders in termul/',
        ignored: false,
        row: { kind: 'category', target: 'explorer' }
      }
    ])
  })

  it('lists Files then Folders for a query, folder rows drilling', () => {
    expect(
      shown({ filter: 'comp', matches: [dirMatch('src/components'), match('src/comp.ts')] })
    ).toEqual([
      { id: 'files', heading: 'Files', notice: undefined, rows: ['file:comp.ts'] },
      { id: 'folders', heading: 'Folders', notice: undefined, rows: ['dir:components'] }
    ])
  })

  it('lists matching conversations (at most 5) above Files and Folders for a query', () => {
    const conversations = Array.from({ length: 7 }, (_, i) => conversation(`c${i}`, `comp ${i}`))
    expect(
      shown({
        filter: 'comp',
        conversations: [conversation('x', 'unrelated'), ...conversations],
        matches: [match('src/comp.ts')]
      })
    ).toEqual([
      {
        id: 'conversations',
        heading: 'Conversations',
        notice: undefined,
        rows: [0, 1, 2, 3, 4].map((i) => `conversation:comp ${i}`)
      },
      { id: 'files', heading: 'Files', notice: undefined, rows: ['file:comp.ts'] }
    ])
  })

  it('returns no sections when a query matches nothing', () => {
    expect(sections({ filter: 'zzz', recents: [match('a.ts')] })).toEqual([])
  })

  it('dedupes matches by absolute path and keeps a same-named folder and file apart', () => {
    expect(
      shown({
        filter: 'search',
        matches: [match('src/search'), match('src/search'), dirMatch('src/search')]
      }).flatMap((s) => s.rows)
    ).toEqual(['file:search', 'dir:search'])
  })

  it('caps the Folders section at MAX_FOLDER_RESULTS', () => {
    const matches = Array.from({ length: MAX_FOLDER_RESULTS + 10 }, (_, i) => dirMatch(`d/f${i}`))
    expect(sections({ filter: 'f', matches })[0].items).toHaveLength(MAX_FOLDER_RESULTS)
  })

  it('carries the relative path and ignored flag on search rows', () => {
    const item = sections({
      filter: 'index',
      matches: [match('node_modules/pkg/index.js', true)]
    })[0].items[0]
    expect(item).toMatchObject({
      key: `${ROOT}/node_modules/pkg/index.js`,
      label: 'index.js',
      description: 'node_modules/pkg/index.js',
      ignored: true
    })
  })
})

describe('buildMentionSections: explorer panel', () => {
  const listing = (entries: MentionMatch[]): DirListing => ({ status: 'ready', entries })

  it('puts Recent above the root listing, folders drilling and ignored rows dimmed', () => {
    const result = sections({
      panel: explorer(ROOT),
      recents: [match('AGENTS.md')],
      listing: listing([dirMatch('src'), dirMatch('node_modules', true), match('README.md')])
    })
    expect(result.map((s) => [s.id, s.heading])).toEqual([
      ['recents', 'Recent'],
      ['listing', 'termul/']
    ])
    expect(result[1].items.map((i) => [i.row.kind, i.label, i.ignored])).toEqual([
      ['dir', 'src', false],
      ['dir', 'node_modules', true],
      ['file', 'README.md', false]
    ])
  })

  it('offers "Use this folder" only below the root', () => {
    expect(shown({ panel: explorer(ROOT), listing: listing([]) })[0].rows).not.toContain(
      'use-folder:Use this folder'
    )
    const [useFolder] = sections({
      panel: explorer(`${ROOT}/src/renderer`),
      listing: listing([match('src/renderer/App.tsx')])
    })
    expect(useFolder.items).toEqual([
      {
        key: `use:${ROOT}/src/renderer/`,
        label: 'Use this folder',
        description: 'src/renderer/',
        ignored: false,
        row: {
          kind: 'use-folder',
          match: {
            relPath: 'src/renderer',
            absPath: `${ROOT}/src/renderer/`,
            name: 'renderer',
            ignored: false,
            kind: 'dir'
          }
        }
      }
    ])
  })

  it('shows a notice while loading, on failure, and for an empty folder', () => {
    const notice = (l: DirListing) =>
      shown({ panel: explorer(`${ROOT}/src`), listing: l }).find((s) => s.id === 'listing')?.notice
    expect(notice({ status: 'loading' })).toBe('Loading…')
    expect(notice({ status: 'error' })).toBe("Couldn't list this folder")
    expect(notice(listing([]))).toBe('This folder is empty')
    expect(notice(listing([match('src/a.ts')]))).toBeUndefined()
  })

  it('lists the first 200 entries and says how many more a search would find', () => {
    const entries = Array.from({ length: 250 }, (_, i) => match(`f${i}.ts`))
    const result = shown({ panel: explorer(ROOT), listing: listing(entries) })
    expect(result.map((s) => [s.id, s.rows.length, s.notice])).toEqual([
      ['listing', 200, undefined],
      ['listing-hidden', 0, '50 more not shown. Type a name to search.']
    ])
    expect(result[0].rows.at(-1)).toBe('file:f199.ts')
    expect(
      shown({ panel: explorer(ROOT), listing: listing(entries.slice(0, 200)) }).map((s) => s.id)
    ).toEqual(['listing'])
  })

  it('searches globally when a query is typed in the explorer', () => {
    expect(
      shown({ panel: explorer(`${ROOT}/src`), filter: 'a', matches: [match('lib/a.ts')] })
    ).toEqual([{ id: 'files', heading: 'Files', notice: undefined, rows: ['file:a.ts'] }])
  })
})

describe('buildMentionSections: conversations panel', () => {
  const conversations = [
    conversation('a', 'Fix web reconnect'),
    conversation('b', 'GPUIX parity', 'Gemini'),
    conversation('c', 'Status pill tabs', null)
  ]

  it('lists every conversation with no query and never searches files', () => {
    expect(
      shown({ panel: { kind: 'conversations' }, conversations, matches: [match('a.ts')] })
    ).toEqual([
      {
        id: 'conversations',
        heading: undefined,
        notice: undefined,
        rows: [
          'conversation:Fix web reconnect',
          'conversation:GPUIX parity',
          'conversation:Status pill tabs'
        ]
      }
    ])
  })

  it('filters by title or agent name', () => {
    const rows = (filter: string) =>
      shown({ panel: { kind: 'conversations' }, conversations, filter }).flatMap((s) => s.rows)
    expect(rows('pill')).toEqual(['conversation:Status pill tabs'])
    expect(rows('gemini')).toEqual(['conversation:GPUIX parity'])
    expect(rows('zzz')).toEqual([])
  })
})

describe('mentionPanelHeader / relativeDir', () => {
  it('has no header at the root and a crumb below the explorer root', () => {
    expect(mentionPanelHeader(ROOT_PANEL, ROOT)).toBeNull()
    expect(mentionPanelHeader({ kind: 'conversations' }, ROOT)).toEqual({
      title: 'Conversations',
      crumb: ''
    })
    expect(mentionPanelHeader(explorer(ROOT), ROOT)).toEqual({ title: 'Explorer', crumb: '' })
    expect(mentionPanelHeader(explorer(`${ROOT}/src/lib`), ROOT)).toEqual({
      title: 'Explorer',
      crumb: 'src/lib/'
    })
  })

  it('does not treat a sibling with a shared prefix as inside the root', () => {
    expect(relativeDir(ROOT, `${ROOT}-other/src`)).toBe('')
  })
})
