import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { termulCaretThemeSpec } from '@/components/editor/codemirror-theme'
import { findThemeRuleValue } from './codemirror-cssom'

describe('findThemeRuleValue CSSOM helper', () => {
  const views: EditorView[] = []
  const containers: HTMLDivElement[] = []

  function createView(extensions: Extension[] = []): EditorView {
    const container = document.createElement('div')
    document.body.appendChild(container)
    containers.push(container)
    const view = new EditorView({ parent: container, extensions })
    views.push(view)
    return view
  }

  afterEach(() => {
    for (const v of views) v.destroy()
    views.length = 0
    for (const c of containers) c.remove()
    containers.length = 0
  })

  it('negative control: view A with no caret theme returns null while view B with shared prefix returns theme value', () => {
    // Mount view A with NO caret theme
    const viewA = createView([])

    // Advance CodeMirror theme IDs until the next generated theme ID has prefix ͼ1 (e.g. ͼ10)
    let found = false
    for (let i = 0; i < 64 && !found; i++) {
      const probeView = createView([EditorView.theme({})])
      const probeClasses = probeView.themeClasses.split(/\s+/).filter(Boolean)
      const customClass = probeClasses.find((c) => c !== 'ͼ1' && c !== 'ͼ2' && c !== 'ͼ3')
      if (customClass?.startsWith('ͼ1') && customClass.length > 2) {
        found = true
      }
    }
    expect(
      found,
      'Expected to advance CodeMirror theme IDs to prefix ͼ1 within 64 iterations'
    ).toBe(true)

    // Mount view B with termulCaretThemeSpec whose generated class starts with ͼ1 (e.g. ͼ11)
    const viewB = createView([EditorView.theme(termulCaretThemeSpec)])

    // View A has class 'ͼ1', and View B has a two-digit class starting with 'ͼ1' (e.g. 'ͼ11')
    expect(viewA.themeClasses).toContain('ͼ1')
    expect(viewB.themeClasses).toMatch(/ͼ1\w+/)

    // View A must NOT match view B's caret rule via substring
    expect(findThemeRuleValue(viewA, '.cm-content', 'caret-color')).toBe(null)

    // View B must match its own caret theme rule
    expect(findThemeRuleValue(viewB, '.cm-content', 'caret-color')).toBe('oklch(var(--primary))')

    // Cursor assertion targets .cm-cursor branch
    expect(findThemeRuleValue(viewB, '.cm-cursor', 'border-left-color')).toBe(
      'oklch(var(--primary))'
    )

    // Selection assertion targets .cm-selectionBackground branch
    expect(findThemeRuleValue(viewB, '.cm-selectionBackground', 'background-color')).toBe(
      'oklch(var(--foreground) / 0.14)'
    )

    // Pseudo-element branch (.cm-content ::selection) must NOT match query for .cm-content
    expect(findThemeRuleValue(viewB, '.cm-content', 'background-color')).toBe(null)
  })
})
