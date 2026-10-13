import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { cn } from '@/lib/utils'
import {
  findRawTagStarts,
  findTextFieldTags,
  listSourceFiles,
  type RawFieldTag,
  toRootPath
} from './__tests__/raw-field-source'
import { Command, CommandInput } from './command'
import { Input } from './input'
import { PANEL_FIELD_CLASS } from './panel-styles'
import { Textarea } from './textarea'

window.HTMLElement.prototype.scrollIntoView = vi.fn()

/**
 * iOS Safari zooms the page when a text field with a computed font size under
 * 16px takes focus. The rule is keyed on pointer type (like `CHAT_ROW_*`), not
 * on viewport width, so a landscape phone (768px or wider) is covered too:
 * every text field carries `pointer-coarse:text-base`.
 */
const TOKEN = 'pointer-coarse:text-base'

const classes = (element: Element): string[] =>
  (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

describe('shared text fields keep 16px on a coarse pointer', () => {
  it('Input keeps text-base md:text-sm for a fine pointer and adds the coarse token', () => {
    render(<Input aria-label="Field" />)
    expect(classes(screen.getByLabelText('Field'))).toEqual(
      expect.arrayContaining(['text-base', 'md:text-sm', TOKEN])
    )
  })

  it.each(['text-xs', 'text-sm'])('Input keeps a caller %s and the coarse token', (size) => {
    render(<Input aria-label="Field" className={`h-8 font-mono ${size}`} />)
    const list = classes(screen.getByLabelText('Field'))
    expect(list).toContain(size)
    expect(list).toContain(TOKEN)
  })

  it('Textarea keeps text-sm for a fine pointer and adds the coarse token', () => {
    render(<Textarea aria-label="Field" />)
    expect(classes(screen.getByLabelText('Field'))).toEqual(
      expect.arrayContaining(['text-sm', TOKEN])
    )
  })

  it('Textarea keeps a caller text-xs and the coarse token', () => {
    render(<Textarea aria-label="Field" className="text-xs" />)
    const list = classes(screen.getByLabelText('Field'))
    expect(list).toContain('text-xs')
    expect(list).not.toContain('text-sm')
    expect(list).toContain(TOKEN)
  })

  it('CommandInput keeps text-sm for a fine pointer and adds the coarse token', () => {
    render(
      <Command>
        <CommandInput aria-label="Field" />
      </Command>
    )
    expect(classes(screen.getByLabelText('Field'))).toEqual(
      expect.arrayContaining(['text-sm', TOKEN])
    )
  })

  it.each([
    'text-xs',
    'text-base'
  ])('CommandInput keeps a caller %s and the coarse token', (size) => {
    render(
      <Command>
        <CommandInput aria-label="Field" className={size} />
      </Command>
    )
    const list = classes(screen.getByLabelText('Field'))
    expect(list).toContain(size)
    expect(list).toContain(TOKEN)
  })

  it('PANEL_FIELD_CLASS keeps text-xs for a fine pointer and survives a caller text-sm', () => {
    expect(PANEL_FIELD_CLASS.split(/\s+/)).toEqual(expect.arrayContaining(['text-xs', TOKEN]))
    const merged = cn(PANEL_FIELD_CLASS, 'w-full px-3 py-2 text-sm').split(/\s+/)
    expect(merged).toContain('text-sm')
    expect(merged).not.toContain('text-xs')
    expect(merged).toContain(TOKEN)
  })
})

interface AllowRule {
  /** Only tags whose source contains this text are exempt; omit to exempt every tag in the file. */
  tagIncludes?: string
}

const POINTER_TOKEN = /(?<![\w:-])pointer-coarse:text-base(?![\w-])/
const PLAIN_TEXT_BASE = /(?<![\w:-])text-base(?![\w-])/
/** A breakpoint that drops a `text-base` field back under 16px: a landscape phone hits `md:text-sm`. */
const BREAKPOINT_DOWNSIZE = /(?<![\w-])(?:sm|md|lg|xl|2xl):text-(?:xs|sm)(?![\w-])/

/**
 * 16px on a coarse pointer: the `pointer-coarse:text-base` token, a plain `text-base` that no
 * breakpoint drops again, or a helper that carries the size.
 */
function isSixteenPx(tag: string): boolean {
  return (
    POINTER_TOKEN.test(tag) ||
    (PLAIN_TEXT_BASE.test(tag) && !BREAKPOINT_DOWNSIZE.test(tag)) ||
    tag.includes('PANEL_FIELD_CLASS') ||
    tag.includes('pickerSearchTextClass(')
  )
}

/**
 * Raw `<input>`, `<textarea>` and `<select>` tags that would let iOS Safari zoom: a text-entry
 * tag with neither a 16px token nor an allowlist rule. Tags are matched at the start of a line or
 * after a JSX expression opener, so comments and strings never match; the uppercase primitives are
 * covered by the tests above.
 */
function findOffenders(source: string, allow: readonly AllowRule[] = []): RawFieldTag[] {
  return findTextFieldTags(source).filter(
    ({ tag }) =>
      !isSixteenPx(tag) &&
      !allow.some((rule) => rule.tagIncludes === undefined || tag.includes(rule.tagIncludes))
  )
}

describe('findOffenders', () => {
  it('flags a text field at 14px or 12px and reports its line', () => {
    const source = [
      'const a = 1',
      '<input className="w-full text-sm" />',
      '<select className="text-xs">'
    ].join('\n')
    expect(findOffenders(source).map((o) => o.line)).toEqual([2, 3])
  })

  it('accepts pointer-coarse:text-base, plain text-base, PANEL_FIELD_CLASS and pickerSearchTextClass', () => {
    expect(findOffenders('<input className="text-sm pointer-coarse:text-base" />')).toEqual([])
    expect(findOffenders('<input className="text-base" />')).toEqual([])
    expect(findOffenders("<input className={cn(PANEL_FIELD_CLASS, 'h-8')} />")).toEqual([])
    expect(
      findOffenders("<input className={cn('h-8', pickerSearchTextClass(isMobile))} />")
    ).toEqual([])
  })

  it('does not accept text-base that only applies under a breakpoint', () => {
    expect(findOffenders('<input className="text-sm md:text-base" />')).toHaveLength(1)
    expect(findOffenders('<input className="text-sm text-base-foreground" />')).toHaveLength(1)
  })

  it('does not accept plain text-base that a breakpoint drops again (a landscape phone)', () => {
    expect(findOffenders('<input className="text-base md:text-sm" />')).toHaveLength(1)
    expect(findOffenders('<input className="text-base lg:text-xs" />')).toHaveLength(1)
    expect(
      findOffenders('<input className="text-base md:text-sm pointer-coarse:text-base" />')
    ).toEqual([])
  })

  it('reads a tag that follows a JSX expression opener on the same line', () => {
    expect(findOffenders('{ready && <input className="text-sm" />}')).toHaveLength(1)
    expect(findOffenders('{ready ? <select className="text-xs"></select> : null}')).toHaveLength(1)
    expect(
      findOffenders('{ready && <input className="text-sm pointer-coarse:text-base" />}')
    ).toEqual([])
  })

  it.each([
    'checkbox',
    'radio',
    'range',
    'file',
    'hidden',
    'button',
    'submit',
    'reset',
    'image',
    'color'
  ])('skips a literal type of %s', (type) => {
    expect(findOffenders(`<input type="${type}" className="size-4" />`)).toEqual([])
    expect(findOffenders(`<input type={'${type}'} className="size-4" />`)).toEqual([])
  })

  it('still flags text-like types and a computed type', () => {
    expect(findOffenders('<input type="search" className="text-sm" />')).toHaveLength(1)
    expect(
      findOffenders("<input type={secret ? 'password' : 'text'} className=\"text-sm\" />")
    ).toHaveLength(1)
  })

  it('finds a tag after return or another tag, and ignores a type mentioned in another attribute', () => {
    expect(findOffenders('return <input className="text-sm" />')).toHaveLength(1)
    expect(findOffenders('<div><input className="text-sm" /></div>')).toHaveLength(1)
    expect(
      findOffenders(
        'return (\n  <div>\n    <p>Don\'t skip</p>\n    <input className="text-sm" />\n  </div>\n)'
      )
    ).toHaveLength(1)
    expect(findOffenders('const value = useState<string>("")')).toEqual([])
    expect(findOffenders('<input placeholder="type=checkbox" className="text-sm" />')).toHaveLength(
      1
    )
  })

  it('ignores commented-out tags', () => {
    expect(findOffenders('// <input className="text-sm" />')).toEqual([])
    expect(findOffenders('{/* <input className="text-sm" /> */}')).toEqual([])
    expect(findOffenders('const x = `<input className="text-sm" />`')).toEqual([])
  })

  it('reads a multi-line tag whose handler contains =>', () => {
    const offender = [
      '<input',
      '  value={value}',
      '  onChange={(event) => setValue(event.target.value)}',
      '  className="w-full text-sm"',
      '/>'
    ].join('\n')
    expect(findOffenders(offender)).toHaveLength(1)

    const compliant = [
      '<input',
      '  onChange={(event) => setValue(event.target.value)}',
      '  className="w-full text-sm pointer-coarse:text-base"',
      '/>'
    ].join('\n')
    expect(findOffenders(compliant)).toEqual([])
  })

  it('reads past quotes, comments and a > inside a string', () => {
    const source = [
      '<input',
      '  placeholder="a > b"',
      "  // don't stop at this apostrophe",
      '  className="text-sm pointer-coarse:text-base"',
      '/>'
    ].join('\n')
    expect(findOffenders(source)).toEqual([])
  })

  it('exempts only allowlisted tags', () => {
    const source = [
      '<input type="password" className="text-sm" />',
      '<input type="text" className="text-sm" />'
    ].join('\n')
    expect(findOffenders(source, [{ tagIncludes: 'type="password"' }]).map((o) => o.line)).toEqual([
      2
    ])
    expect(findOffenders(source, [{}])).toEqual([])
  })
})

/**
 * Text-entry fields that never mount on the mobile web shell, so they keep their desktop size
 * (the one phone-reachable exception names its owner). Paths are relative to `src/renderer`. Add a
 * field here only with a reason; otherwise append `pointer-coarse:text-base` to it.
 */
const DESKTOP_ONLY: ReadonlyArray<AllowRule & { file: string; reason: string }> = [
  {
    file: 'components/sidebar/project-item.tsx',
    reason: 'ProjectSidebar mounts only in the desktop return of WorkspaceLayout'
  },
  {
    file: 'components/sidebar/project-list.tsx',
    reason: 'ProjectSidebar mounts only in the desktop return of WorkspaceLayout'
  },
  {
    file: 'components/sidebar/project-settings-dialog.tsx',
    reason: 'reachable only from ProjectSidebar'
  },
  { file: 'components/NewGroupModal.tsx', reason: 'reachable only from ProjectSidebar' },
  { file: 'components/NewWorktreeModal.tsx', reason: 'reachable only from ProjectSidebar' },
  {
    file: 'components/file-explorer/explorer-inline-input.tsx',
    reason: 'desktop FileExplorer; phones use MobileFileExplorer with ui/Input'
  },
  {
    file: 'components/workspace/tabs/terminal-tab.tsx',
    reason: 'the tab strip mounts only in the desktop return'
  },
  {
    file: 'components/ssh/SSHFileEditor.tsx',
    reason: 'SSH entries are isTauriContext()-gated, and the shell never runs in Tauri'
  },
  {
    file: 'components/browser/BrowserControls.tsx',
    reason: 'browser tabs are Tauri-only'
  },
  {
    file: 'components/git/GitHistoryPanel.tsx',
    tagIncludes: 'Filter commits',
    reason:
      'the desktop branch of the git-history panel; the phone branch has its own 16px filter field (#973)'
  }
]

const RENDERER_ROOT = join(__dirname, '..', '..')

const toRendererPath = (path: string): string => toRootPath(RENDERER_ROOT, path)

describe('raw text fields in the renderer', () => {
  it('every allowlisted file exists', () => {
    for (const { file } of DESKTOP_ONLY) {
      expect(() => statSync(join(RENDERER_ROOT, file)), file).not.toThrow()
    }
  })

  it('every <input>, <textarea> and <select> is 16px on a coarse pointer or allowlisted', () => {
    const report: string[] = []
    let scanned = 0
    for (const path of listSourceFiles(RENDERER_ROOT)) {
      const file = toRendererPath(path)
      const source = readFileSync(path, 'utf8')
      const allow = DESKTOP_ONLY.filter((entry) => entry.file === file)
      scanned += findRawTagStarts(source).length
      for (const { line } of findOffenders(source, allow)) {
        report.push(`src/renderer/${file}:${line}`)
      }
    }
    // Guards against a walk or a pattern that silently matches nothing.
    expect(scanned).toBeGreaterThan(30)
    expect(
      report,
      `iOS Safari zooms into a text field under 16px. Add pointer-coarse:text-base to each field below, or add it to DESKTOP_ONLY with a reason if it never mounts on the phone shell:\n${report.join('\n')}`
    ).toEqual([])
  })
})
