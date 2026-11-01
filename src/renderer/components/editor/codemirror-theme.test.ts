import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { MONO_STACK } from '@/lib/font-stacks'
import { findThemeRuleValue } from '@/test-utils/codemirror-cssom'
import { createTermulTheme, termulCaretThemeSpec } from './codemirror-theme'

describe('termulCaretThemeSpec', () => {
  it('exports caret color, cursor border, and selection wash rules', () => {
    expect(termulCaretThemeSpec['.cm-content']).toEqual({
      caretColor: 'oklch(var(--primary))'
    })
    expect(termulCaretThemeSpec['.cm-cursor, .cm-dropCursor']).toEqual({
      borderLeftColor: 'oklch(var(--primary))'
    })
    expect(
      termulCaretThemeSpec[
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection'
      ]
    ).toEqual({
      backgroundColor: 'oklch(var(--foreground) / 0.14)'
    })
  })
})

describe('createTermulTheme real EditorView theme CSSOM', () => {
  let view: EditorView | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    view?.destroy()
    view = null
    container?.remove()
    container = null
  })

  it('preserves caret color, selection wash, and typography properties on .cm-content', () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    view = new EditorView({
      parent: container,
      extensions: createTermulTheme(true)
    })

    // Caret and selection
    expect(findThemeRuleValue(view, '.cm-content', 'caret-color')).toBe('oklch(var(--primary))')
    expect(findThemeRuleValue(view, '.cm-cursor', 'border-left-color')).toBe(
      'oklch(var(--primary))'
    )
    expect(findThemeRuleValue(view, '.cm-selectionBackground', 'background-color')).toBe(
      'oklch(var(--foreground) / 0.14)'
    )

    // Typography properties that must not be overwritten
    expect(findThemeRuleValue(view, '.cm-content', 'font-family')).toBe(MONO_STACK)
    expect(findThemeRuleValue(view, '.cm-content', 'font-size')).toBe('0.8125rem')
    expect(findThemeRuleValue(view, '.cm-content', 'line-height')).toBe('1.6')
  })
})
