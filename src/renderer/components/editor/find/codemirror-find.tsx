import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  gotoLine,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  searchKeymap,
  searchPanelOpen,
  setSearchQuery
} from '@codemirror/search'
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Text
} from '@codemirror/state'
import {
  type Command,
  EditorView,
  type KeyBinding,
  type Panel,
  runScopeHandlers,
  showPanel,
  type ViewUpdate
} from '@codemirror/view'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { type FindOptions, type FindStatus, FindWidget } from '@/components/find/FindWidget'
import { TooltipProvider } from '@/components/ui/tooltip'
import { logFrontendError } from '@/lib/log-api'
import { GoToLineWidget } from './GoToLineWidget'

/** Same cap as CodeMirror's select-all-matches; past it the count reads "1000+". */
export const MATCH_LIMIT = 1000

export interface MatchRange {
  from: number
  to: number
}

interface MatchList {
  ranges: MatchRange[]
  capped: boolean
}

/** Non-empty matches of `query` in document order, up to {@link MATCH_LIMIT}. */
export function collectMatches(state: EditorState, query: SearchQuery): MatchList {
  const ranges: MatchRange[] = []
  if (!query.valid) return { ranges, capped: false }
  const cursor = query.getCursor(state)
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    const { from, to } = step.value
    if (from === to) continue
    if (ranges.length === MATCH_LIMIT) return { ranges, capped: true }
    ranges.push({ from, to })
  }
  return { ranges, capped: false }
}

/** 1-based position of the match `from`–`to` in `ranges`, or 0 when it is not one of them. */
export function matchIndex(ranges: readonly MatchRange[], from: number, to: number): number {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = ranges[mid]
    if (range.from < from) low = mid + 1
    else if (range.from > from) high = mid - 1
    else return range.to === to ? mid + 1 : 0
  }
  return 0
}

/** First non-empty match at or after `from`, wrapping around to the top. */
function matchFrom(state: EditorState, query: SearchQuery, from: number): MatchRange | null {
  const passes = [
    [from, state.doc.length],
    [0, from]
  ] as const
  for (const [start, end] of passes) {
    const cursor = query.getCursor(state, start, end)
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      if (step.value.to > step.value.from) return { from: step.value.from, to: step.value.to }
    }
  }
  return null
}

/**
 * Document position for a go-to-line entry, or null when it is not one. Same
 * grammar as CodeMirror's `gotoLine` (`12`, `+5`, `-5`, `50%`, `12:4`), with
 * 1-based columns like the status bar.
 */
export function resolveGoToLine(state: EditorState, input: string): number | null {
  const match = /^([+-])?(\d+)?(:\d+)?(%)?$/.exec(input.trim())
  if (!match || (!match[2] && !match[3])) return null
  const [, sign, lineText, columnText, percent] = match
  const { doc } = state
  const current = doc.lineAt(state.selection.main.head).number
  let line = lineText ? Number(lineText) : current
  if (lineText && percent) {
    const fraction = line / 100
    line = Math.round(
      doc.lines * (sign ? fraction * (sign === '-' ? -1 : 1) + current / doc.lines : fraction)
    )
  } else if (lineText && sign) {
    line = current + (sign === '-' ? -line : line)
  }
  const target = doc.line(Math.min(Math.max(line, 1), doc.lines))
  const column = columnText ? Number(columnText.slice(1)) : 1
  return target.from + Math.min(Math.max(column - 1, 0), target.length)
}

const setReplaceOpen = StateEffect.define<boolean>()

/** Whether find shows its replace row. Outlives the widget, like VS Code's. */
const replaceOpenField = StateField.define<boolean>({
  create: () => false,
  update(open, tr) {
    let next = open
    for (const effect of tr.effects) if (effect.is(setReplaceOpen)) next = effect.value
    return next
  }
})

/** Focus a find field with its text selected, so typing replaces it (VS Code's Ctrl+F / Ctrl+H). */
function focusField(root: ParentNode, field: 'search' | 'replace'): void {
  const input = root.querySelector<HTMLInputElement>(`[data-find-field="${field}"]`)
  input?.focus()
  input?.select()
}

/**
 * CodeMirror's find-next selects the whole query in the find field. Keep the
 * caret where it was instead, so typing carries on as in VS Code.
 */
function keepFieldCaret(command: Command): Command {
  return (view) => {
    const field = view.root.activeElement
    if (!(field instanceof HTMLInputElement) || !view.dom.contains(field)) return command(view)
    const { selectionStart, selectionEnd, selectionDirection } = field
    const handled = command(view)
    if (selectionStart !== null && selectionEnd !== null) {
      field.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined)
    }
    return handled
  }
}

const findNextKeepingCaret = keepFieldCaret(findNext)
const findPreviousKeepingCaret = keepFieldCaret(findPrevious)

/**
 * A CodeMirror panel drawn by React. The panel itself has no height: its
 * widget floats over the top of the editor instead of pushing the text down.
 */
abstract class ReactPanel implements Panel {
  readonly dom = document.createElement('div')
  readonly top = true
  protected readonly view: EditorView
  private readonly root: Root
  private readonly context: string

  /** `context` names the panel in ErrorBoundary logs. */
  constructor(view: EditorView, context: string) {
    this.view = view
    this.context = context
    this.root = createRoot(this.dom)
  }

  /** The widget to draw, read fresh from the editor state on every render. */
  protected abstract content(): ReactNode

  /**
   * `sync` renders before returning, because CodeMirror reads the fields right
   * after it opens a panel. Only user commands pass it: React effects never
   * open a panel, and flushSync cannot run inside one.
   */
  protected render(sync = false): void {
    // Its own root: wrap what the app root would otherwise provide.
    const tree = (
      <ErrorBoundary context={this.context} fallback={() => null}>
        <TooltipProvider delayDuration={400}>{this.content()}</TooltipProvider>
      </ErrorBoundary>
    )
    if (sync) flushSync(() => this.root.render(tree))
    else this.root.render(tree)
  }

  /**
   * Unmounts on a microtask: editors are destroyed in React effect cleanup,
   * where unmounting another root synchronously warns.
   */
  destroy(): void {
    const { root } = this
    queueMicrotask(() => root.unmount())
  }
}

/** CodeMirror's search panel, replaced by {@link FindWidget} through `search({ createPanel })`. */
class FindPanel extends ReactPanel {
  private query: SearchQuery
  private matches: { doc: Text; query: SearchQuery; list: MatchList } | null = null

  /** Starts from the query CodeMirror already holds, seeded from the selection on Ctrl+F. */
  constructor(view: EditorView) {
    super(view, 'Editor find')
    this.query = getSearchQuery(view.state)
    this.render(true)
  }

  /** CodeMirror calls this once the panel is in the DOM: focus the field like VS Code. */
  mount(): void {
    focusField(this.dom, 'search')
  }

  /**
   * Re-render when the count or the fields can change: text, selection, an
   * outside query or the replace row. Opening replace renders synchronously so
   * {@link openReplacePanel} can focus the new field right away.
   */
  update(update: ViewUpdate): void {
    let changed = update.docChanged || update.selectionSet
    let sync = false
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery)) {
          // Edits from this widget are already in this.query; adopt the rest
          // (Ctrl+F on a selection).
          if (!effect.value.eq(this.query)) this.query = effect.value
          changed = true
        } else if (effect.is(setReplaceOpen)) {
          changed = true
          sync = true
        }
      }
    }
    if (changed) this.render(sync)
  }

  /** The find widget, pinned to the top right, without replace in read-only editors. */
  protected content(): ReactNode {
    const { view, query } = this
    const { state } = view
    return (
      <FindWidget
        className="absolute right-5 top-2"
        search={query.search}
        onSearchChange={(value) => this.commit({ search: value })}
        options={{
          caseSensitive: query.caseSensitive,
          wholeWord: query.wholeWord,
          regexp: query.regexp
        }}
        onOptionsChange={(options) => this.commit(options)}
        status={this.status()}
        onNext={() => findNextKeepingCaret(view)}
        onPrevious={() => findPreviousKeepingCaret(view)}
        onClose={() => closeSearchPanel(view)}
        onKeyDown={(event) => runScopeHandlers(view, event, 'search-panel')}
        replace={
          state.readOnly
            ? undefined
            : {
                open: state.field(replaceOpenField),
                onOpenChange: (open) => this.setReplaceOpen(open),
                value: query.replace,
                onValueChange: (value) => this.commit({ replace: value }),
                onReplace: () => replaceNext(view),
                onReplaceAll: () => this.replaceAllMatches()
              }
        }
      />
    )
  }

  /**
   * Push a field or option change into CodeMirror's query. `this.query` is set
   * before dispatching so {@link update} recognises the effect as its own.
   */
  private commit(change: Partial<FindOptions> & { search?: string; replace?: string }): void {
    const previous = this.query
    const next = new SearchQuery({
      search: change.search ?? previous.search,
      replace: change.replace ?? previous.replace,
      caseSensitive: change.caseSensitive ?? previous.caseSensitive,
      wholeWord: change.wholeWord ?? previous.wholeWord,
      regexp: change.regexp ?? previous.regexp,
      literal: previous.literal
    })
    if (next.eq(previous)) return
    this.query = next
    const patternChanged =
      next.search !== previous.search ||
      next.caseSensitive !== previous.caseSensitive ||
      next.wholeWord !== previous.wholeWord ||
      next.regexp !== previous.regexp
    // Find as you type: the match under the cursor stays put while it still
    // matches, otherwise the next one is selected.
    const { state } = this.view
    const match =
      patternChanged && next.valid ? matchFrom(state, next, state.selection.main.from) : null
    this.view.dispatch({
      effects: match
        ? [setSearchQuery.of(next), EditorView.scrollIntoView(match.from)]
        : setSearchQuery.of(next),
      selection: match ? { anchor: match.from, head: match.to } : undefined,
      userEvent: match ? 'select.search' : undefined
    })
  }

  /** What the count slot shows. Invalid regexes are caught here: their cursor would throw. */
  private status(): FindStatus {
    const { state } = this.view
    const { query } = this
    if (!query.search) return { kind: 'empty' }
    if (!query.valid) return { kind: 'invalid' }
    // Recount only when the text or the query changed; moving between matches reuses the list.
    let cache = this.matches
    if (!cache || cache.doc !== state.doc || cache.query !== query) {
      cache = { doc: state.doc, query, list: collectMatches(state, query) }
      this.matches = cache
    }
    const { ranges, capped } = cache.list
    const { from, to } = state.selection.main
    return { kind: 'matches', current: matchIndex(ranges, from, to), total: ranges.length, capped }
  }

  /** Show or hide the replace row. Hiding it while it has focus moves focus to the find field, not the page. */
  private setReplaceOpen(open: boolean): void {
    const focused = this.view.root.activeElement
    const replaceFocused = focused?.getAttribute('data-find-field') === 'replace'
    this.view.dispatch({ effects: setReplaceOpen.of(open) })
    if (!open && replaceFocused) focusField(this.dom, 'search')
  }

  /** Replace every match as one undo step. Logs the count only: the query may hold secrets. */
  private replaceAllMatches(): void {
    const status = this.status()
    if (!replaceAll(this.view) || status.kind !== 'matches') return
    void logFrontendError({
      level: 'info',
      source: 'editor-find',
      message: `replace all: ${status.total}${status.capped ? '+' : ''} matches`
    })
  }
}

const setGoToLineOpen = StateEffect.define<boolean>()

/** The Ctrl+G panel: {@link GoToLineWidget} at the top centre of the editor. */
class GoToLinePanel extends ReactPanel {
  /** Blur also asks to close, sometimes during the closing update itself. */
  private closed = false

  /** Renders synchronously so {@link mount} finds the field. */
  constructor(view: EditorView) {
    super(view, 'Editor go to line')
    this.render(true)
  }

  /** Focus the field as soon as CodeMirror has inserted the panel. */
  mount(): void {
    this.dom.querySelector<HTMLInputElement>('[data-go-to-line]')?.focus()
  }

  /** Keep the "Line N of M" hint current. */
  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet) this.render()
  }

  /** A blur fired by the panel's removal must not dispatch into a destroyed editor. */
  destroy(): void {
    this.closed = true
    super.destroy()
  }

  /** The go-to-line field, centred over the top of the editor. */
  protected content(): ReactNode {
    const { state } = this.view
    return (
      <GoToLineWidget
        className="absolute inset-x-0 top-2 mx-auto"
        currentLine={state.doc.lineAt(state.selection.main.head).number}
        lineCount={state.doc.lines}
        onSubmit={(value) => this.go(value)}
        onClose={() => this.close(true)}
        onDismiss={() => this.close(false)}
      />
    )
  }

  /**
   * Jump to the entry and close. Returns false for an entry that is not a
   * line, so the widget can say so and stay open.
   */
  private go(value: string): boolean {
    const position = resolveGoToLine(this.view.state, value)
    if (position === null) return false
    this.closed = true
    this.view.focus()
    this.view.dispatch({
      selection: { anchor: position },
      effects: [setGoToLineOpen.of(false), EditorView.scrollIntoView(position, { y: 'center' })],
      userEvent: 'select'
    })
    return true
  }

  /** Close once. Escape hands focus back to the editor; a blur leaves it where the user put it. */
  private close(focusEditor: boolean): void {
    if (this.closed) return
    this.closed = true
    if (focusEditor) this.view.focus()
    this.view.dispatch({ effects: setGoToLineOpen.of(false) })
  }
}

/** One stable constructor: showPanel keeps a panel only while its constructor stays the same. */
const createGoToLinePanel = (view: EditorView): Panel => new GoToLinePanel(view)

/** Whether the go-to-line panel is open; provides the panel through showPanel. */
const goToLineField = StateField.define<boolean>({
  create: () => false,
  update(open, tr) {
    let next = open
    for (const effect of tr.effects) if (effect.is(setGoToLineOpen)) next = effect.value
    return next
  },
  provide: (field) => showPanel.from(field, (open) => (open ? createGoToLinePanel : null))
})

/** Ctrl+H (Cmd+Alt+F on macOS): find with the replace row open and focused. */
export const openReplacePanel: Command = (view) => {
  openSearchPanel(view)
  if (view.state.readOnly) return true
  if (!view.state.field(replaceOpenField, false)) {
    view.dispatch({ effects: setReplaceOpen.of(true) })
  }
  focusField(view.dom, 'replace')
  return true
}

/** Ctrl+G: the floating go-to-line field. */
export const openGoToLine: Command = (view) => {
  const open = view.state.field(goToLineField, false)
  if (open === undefined) return false
  if (open) view.dom.querySelector<HTMLInputElement>('[data-go-to-line]')?.focus()
  else view.dispatch({ effects: setGoToLineOpen.of(true) })
  return true
}

/**
 * CodeMirror's search keys plus VS Code's: Ctrl+G goes to a line (Cmd+G stays
 * find-next on macOS) and Ctrl+H / Cmd+Alt+F opens replace. List it ahead of
 * the default keymap.
 */
export const editorFindKeymap: readonly KeyBinding[] = [
  { key: 'Ctrl-g', run: openGoToLine, preventDefault: true },
  {
    key: 'Mod-h',
    mac: 'Mod-Alt-f',
    run: openReplacePanel,
    scope: 'editor search-panel',
    preventDefault: true
  },
  ...searchKeymap.map((binding): KeyBinding => {
    if (binding.run === findNext) {
      return { ...binding, run: findNextKeepingCaret, shift: findPreviousKeepingCaret }
    }
    if (binding.run === gotoLine) return { ...binding, run: openGoToLine }
    return binding
  })
]

/** The widgets cover the top of the editor: keep scrolled-to text below them. */
const overlayScrollMargins = EditorView.scrollMargins.of((view) => {
  if (!searchPanelOpen(view.state) && !view.state.field(goToLineField, false)) return null
  let bottom = 0
  for (const overlay of view.dom.querySelectorAll<HTMLElement>(
    '[data-find-widget], [data-go-to-line-widget]'
  )) {
    bottom = Math.max(bottom, overlay.offsetTop + overlay.offsetHeight)
  }
  return bottom > 0 ? { top: bottom + 8 } : null
})

/**
 * Find / replace and go to line as floating widgets over the top of the
 * editor. Pair with {@link editorFindKeymap}.
 */
export function editorFind(): Extension {
  return [
    search({ top: true, createPanel: (view) => new FindPanel(view) }),
    replaceOpenField,
    goToLineField,
    overlayScrollMargins
  ]
}
