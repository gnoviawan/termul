import {
  closeCompletion,
  completionStatus,
  selectedCompletion,
  selectedCompletionIndex
} from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers, showTooltip } from '@codemirror/view'
import type { CompletionRpcReply, TerminalApi } from '@shared/types/ipc.types'
import { waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { type CompletionContext, CompletionScheduler } from '@/lib/command-lifecycle/completion'
import type { CompletionOutputRow } from '@/lib/command-lifecycle/completion-output'
import { parseCompletionOutput } from '@/lib/command-lifecycle/completion-output'
import {
  acceptHighlighted,
  type CompletionViewSource,
  completionView,
  ghostText,
  showCompletion
} from './completion-view'
import { type EditorKeymapDeps, editorKeymap } from './editor-keys'

const views: EditorView[] = []
const geometryMethods = ['getClientRects', 'getBoundingClientRect'] as const
const originalGeometry = geometryMethods.map((name) =>
  Object.getOwnPropertyDescriptor(Range.prototype, name)
)

beforeAll(() => {
  // jsdom has no layout; CodeMirror still needs the Range geometry API.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => []
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect()
  })
})

it('the highlighted row shows ghost text', async () => {
  const view = createEditor([{ text: 'status', from: 4, to: 7 }], () => {})
  view.dispatch({ changes: { from: 0, to: 7, insert: 'git sta' } })
  await openCompletion(view)

  expect(ghostText(view.state)).toBe('tus')
})

it('ghost text is not document text', async () => {
  const view = createEditor([{ text: 'status', from: 4, to: 7 }], () => {})
  view.dispatch({ changes: { from: 0, to: 7, insert: 'git sta' } })
  await openCompletion(view)

  expect(view.state.doc.toString()).toBe('git sta')
  expect(view.dom.querySelector('.cm-completion-ghost')?.textContent ?? null).toBe('tus')
})

afterAll(() => {
  geometryMethods.forEach((name, index) => {
    const original = originalGeometry[index]
    if (original) Object.defineProperty(Range.prototype, name, original)
    else delete Range.prototype[name]
  })
})

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy()
    view.dom.remove()
  }
})

function createEditor(
  rows: CompletionOutputRow[],
  submit: (text: string) => void,
  deps: Partial<EditorKeymapDeps> = {},
  source: CompletionViewSource = { rows: () => rows, request: () => {} }
) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: 'git rem',
      selection: { anchor: 7 },
      extensions: [completionView(source), editorKeymap({ history: () => [], submit, ...deps })]
    })
  })
  views.push(view)
  return view
}

async function openCompletion(view: EditorView) {
  showCompletion(view)
  await waitFor(() => expect(completionStatus(view.state)).toBe('active'))
}

function createFakeHost() {
  type CompletionRequest = Parameters<TerminalApi['requestCompletion']>[1]
  const requests: Array<{ terminalId: string; request: CompletionRequest }> = []
  const pending: Array<{ resolve: (reply: CompletionRpcReply) => void }> = []
  const cancels: Array<{ terminalId: string; requestId: string }> = []
  return {
    requests,
    cancels,
    requestCompletion(terminalId: string, request: CompletionRequest) {
      requests.push({ terminalId, request })
      return new Promise<CompletionRpcReply>((resolve) => {
        pending.push({ resolve })
      })
    },
    cancelCompletion(terminalId: string, requestId: string) {
      cancels.push({ terminalId, requestId })
      return Promise.resolve('Accepted' as const)
    },
    async finish(reply: CompletionRpcReply) {
      const next = pending.shift()
      if (!next) throw new Error('no in-flight completion')
      next.resolve(reply)
      await Promise.resolve()
    }
  }
}

it('Tab requests completion when nothing is showing', async () => {
  const host = createFakeHost()
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true }
  })
  const context: CompletionContext = {
    terminalId: 't1',
    sessionId: 's1',
    mode: 'Editor',
    phase: 'AtPrompt',
    draft: 'git rem',
    bufferRevision: 4,
    cursor: 7,
    promptGeneration: 3,
    cwd: '/repo'
  }
  const view = createEditor(
    [],
    () => {},
    {},
    {
      rows: () => [],
      request: () => scheduler.requestCompletion(context)
    }
  )
  view.focus()
  const focused = document.activeElement
  expect(focused).toBe(view.contentDOM)
  expect(completionStatus(view.state)).toBeNull()
  expect(ghostText(view.state)).toBeNull()
  expect(scheduler.inFlightRequestId).toBeNull()

  try {
    const handled = runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Tab' }), 'editor')

    expect(host.requests).toHaveLength(1)
    expect(host.requests[0]).toMatchObject({
      terminalId: 't1',
      request: { requestId: 'A', draft: 'git rem', cursor: 7 }
    })
    expect(handled).toBe(true)
    expect(view.state.doc.toString()).toBe('git rem')
    expect(view.state.doc.toString()).not.toContain('\t')
    expect(document.activeElement).toBe(focused)
  } finally {
    await scheduler.prepareSubmit()
  }
})

it('a completion candidate containing ESC or CR never reaches the editor buffer', async () => {
  const hex = (text: string) =>
    Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    )
  const rows = parseCompletionOutput(
    'git sta',
    7,
    [hex('status\x1b[201~'), hex('stash\rinjected'), hex('stash')].join('\n')
  )
  expect(rows.map((row) => row.text)).toEqual(['stash'])
  const view = createEditor(rows, () => {})
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: 'git sta' },
    selection: { anchor: 7 }
  })
  await openCompletion(view)
  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Tab' }), 'editor')
  expect(view.state.doc.toString()).toBe('git stash')
  expect(view.state.doc.toString()).not.toContain('\x1b')
  expect(view.state.doc.toString()).not.toContain('\r')
})

it('Tab accepts the highlighted row', async () => {
  const submit = vi.fn()
  const view = createEditor([{ text: 'remote', from: 4, to: 7 }], submit)
  await openCompletion(view)
  expect(selectedCompletion(view.state)?.label).toBe('remote')

  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Tab' }), 'editor')

  expect(view.state.doc.toString()).toBe('git remote')
  expect(completionStatus(view.state)).toBeNull()
  expect(submit).not.toHaveBeenCalled()
  expect(acceptHighlighted(view)).toBe(false)
})

it('Right accepts ghost text at the end of the buffer', async () => {
  const submit = vi.fn()
  const view = createEditor([{ text: 'remote', from: 4, to: 7 }], submit)
  await openCompletion(view)
  expect(ghostText(view.state)).toBe('ote')

  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'ArrowRight' }), 'editor')

  expect(view.state.doc.toString()).toBe('git remote')
  expect(submit).not.toHaveBeenCalled()
  expect(ghostText(view.state)).toBeNull()
  expect(completionStatus(view.state)).toBeNull()
})

it('Right elsewhere moves the caret', async () => {
  const submit = vi.fn()
  const view = createEditor([{ text: 'status', from: 4, to: 7 }], submit)
  view.dispatch({
    changes: { from: 0, to: 7, insert: 'git sta --x' },
    selection: { anchor: 7 }
  })
  await openCompletion(view)
  expect(ghostText(view.state)).toBe('tus')

  const handled = runScopeHandlers(
    view,
    new KeyboardEvent('keydown', { key: 'ArrowRight' }),
    'editor'
  )

  expect(view.state.doc.toString()).toBe('git sta --x')
  expect(view.state.selection.main.head).toBe(8)
  expect(handled).toBe(true)
  expect(ghostText(view.state)).toBeNull()
  expect(submit).not.toHaveBeenCalled()
})

it('click accepts the row', async () => {
  const submit = vi.fn()
  const view = createEditor(
    [
      { text: 'remote', from: 4, to: 7 },
      { text: 'remove', from: 4, to: 7 }
    ],
    submit
  )
  await openCompletion(view)
  expect(selectedCompletion(view.state)?.label).toBe('remote')

  acceptHighlighted(view, 1)

  expect(view.state.doc.toString()).toBe('git remove')
  expect(completionStatus(view.state)).toBeNull()
  expect(submit).not.toHaveBeenCalled()
})

it('dropdown arrows move only the highlight', async () => {
  const history = vi.fn(() => ['git remembered'])
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: 'git rem',
      selection: { anchor: 7 },
      extensions: [
        completionView({
          rows: () => [
            { text: 'remote', from: 4, to: 7 },
            { text: 'remove', from: 4, to: 7 }
          ],
          request: () => {}
        }),
        editorKeymap({ history, submit: () => {} })
      ]
    })
  })
  views.push(view)
  await openCompletion(view)
  expect(selectedCompletionIndex(view.state)).toBe(0)
  const selection = view.state.selection.toJSON()

  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'ArrowUp' }), 'editor')
  expect(history).not.toHaveBeenCalled()
  expect(selectedCompletionIndex(view.state)).toBe(1)
  expect(view.state.selection.toJSON()).toEqual(selection)
  expect(view.state.doc.toString()).toBe('git rem')

  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'ArrowDown' }), 'editor')
  expect(selectedCompletionIndex(view.state)).toBe(0)
  expect(view.state.selection.toJSON()).toEqual(selection)
  expect(view.state.doc.toString()).toBe('git rem')
  expect(history).not.toHaveBeenCalled()

  closeCompletion(view)
  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'ArrowUp' }), 'editor')
  expect(history).toHaveBeenCalledTimes(1)
  expect(view.state.doc.toString()).toBe('git remembered')
})

it('Enter submits the buffer while the dropdown is open', async () => {
  const submit = vi.fn()
  const view = createEditor([{ text: 'status', from: 4, to: 7 }], submit)
  view.dispatch({ changes: { from: 0, to: 7, insert: 'git sta' } })
  await openCompletion(view)
  expect(selectedCompletion(view.state)?.label).toBe('status')

  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Enter' }), 'editor')

  expect(submit).toHaveBeenCalledExactlyOnceWith('git sta')
  expect(view.state.doc.toString()).toBe('git sta')
})

it('Esc closes the overlay', async () => {
  const writePty = vi.fn()
  const view = createEditor([{ text: 'status', from: 4, to: 7 }], () => {}, { writePty })
  view.dispatch({ changes: { from: 0, to: 7, insert: 'git sta' } })
  await openCompletion(view)

  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Escape' }), 'editor')

  expect(view.state.doc.toString()).toBe('git sta')
  expect(writePty).not.toHaveBeenCalled()
  expect(completionStatus(view.state)).toBeNull()
})

it('Esc closes the history popup', () => {
  const writePty = vi.fn()
  const popup = {
    open: true,
    move: () => {},
    highlightedValue: 'git status',
    close: () => {
      popup.open = false
    }
  }
  const view = createEditor([], () => {}, { writePty, historyPopup: () => popup })
  view.dispatch({ changes: { from: 0, to: 7, insert: 'git sta' } })

  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Escape' }), 'editor')

  expect(view.state.doc.toString()).toBe('git sta')
  expect(writePty).not.toHaveBeenCalled()
  expect(popup.open).toBe(false)
})

function matchingRules(prefix: string): CSSStyleRule[] {
  return Array.from(document.styleSheets).flatMap((sheet) =>
    Array.from(sheet.cssRules).filter(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.startsWith(prefix)
    )
  )
}

function assertTooltipStyles(rules: CSSStyleRule[], prefix: string) {
  const tooltipRule = rules.find((r) => r.selectorText === `${prefix}.cm-tooltip`)
  expect(tooltipRule).toBeDefined()
  const tooltipDecl = tooltipRule?.style.cssText ?? ''
  expect(tooltipRule?.style.getPropertyValue('background-color') || tooltipDecl).toContain(
    'var(--popover)'
  )
  expect(tooltipRule?.style.getPropertyValue('color') || tooltipDecl).toContain(
    'var(--popover-foreground)'
  )
  expect(tooltipRule?.style.getPropertyValue('border') || tooltipDecl).toContain('var(--border)')

  const selectedRowRule = rules.find((r) => r.selectorText.includes('li[aria-selected]'))
  expect(selectedRowRule).toBeDefined()
  const selectedBg =
    selectedRowRule?.style.getPropertyValue('background-color') ||
    selectedRowRule?.style.cssText ||
    ''
  expect(selectedBg).toContain('var(--foreground)')
  expect(selectedBg).toContain('0.06')

  const matchedTextRule = rules.find((r) => r.selectorText === `${prefix}.cm-completionMatchedText`)
  expect(matchedTextRule).toBeDefined()
  expect(
    matchedTextRule?.style.getPropertyValue('font-weight') || matchedTextRule?.style.fontWeight
  ).toBe('700')
  expect(
    matchedTextRule?.style.getPropertyValue('text-decoration') ||
      matchedTextRule?.style.textDecoration
  ).toBe('none')

  const ulRule = rules.find(
    (r) => r.selectorText.includes('.cm-tooltip-autocomplete') && r.selectorText.endsWith('> ul')
  )
  expect(ulRule).toBeDefined()
  const fontFamily =
    ulRule?.style.getPropertyValue('font-family') ||
    ulRule?.style.fontFamily ||
    ulRule?.style.cssText ||
    ''
  expect(fontFamily).toContain('Paper Mono')
}

it('completion picker inherits the active Termul theme', () => {
  const source: CompletionViewSource = {
    rows: () => [{ text: 'status', from: 4, to: 7 }],
    request: () => {}
  }
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: 'git sta',
      selection: { anchor: 7 },
      extensions: [completionView(source)]
    })
  })
  views.push(view)

  const unThemed = new EditorView({
    parent: document.body,
    state: EditorState.create({ extensions: [] })
  })
  views.push(unThemed)
  const unThemedClasses = new Set(unThemed.themeClasses.split(/\s+/).filter(Boolean))
  const scopedClass =
    view.themeClasses
      .split(/\s+/)
      .filter(Boolean)
      .find((c) => !unThemedClasses.has(c)) ?? ''

  const prefix = `.${scopedClass} `
  assertTooltipStyles(matchingRules(prefix), prefix)
})

it('completion tooltip prefers opening above cursor', async () => {
  const view = createEditor([{ text: 'status', from: 4, to: 7 }], () => {})
  view.dispatch({ changes: { from: 0, to: 7, insert: 'git sta' } })
  await openCompletion(view)

  const tooltips = view.state.facet(showTooltip).filter((tooltip) => tooltip !== null)
  expect(tooltips).toHaveLength(1)
  expect(tooltips[0]?.above).toBe(true)
})
