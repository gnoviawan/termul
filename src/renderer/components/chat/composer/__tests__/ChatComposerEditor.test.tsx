import { act, render, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILL_PAD_DEFAULT } from '@/lib/composer/doc-to-prompt'
import { skillToken } from '@/lib/skill-tokens'
import { ChatComposerEditor } from '../ChatComposerEditor'
import { getComposerValue, setComposerValue } from '../chat-composer-test-helpers'

/**
 * Focused editor tests: paste sentinel-token round-trip (spec I/O matrix row 5:
 * Paste), malformed-clipboard graceful fallback, and the keymap-ordering guard
 * (patch 13: `ComposerKeymap` runs before `StarterKit` so Enter→submit beats
 * splitBlock). These run against `ChatComposerEditor` standalone so the
 * full-host test file's ProseMirror/jsdom accumulation doesn't gate them.
 */

function mountEditor(
  props: Partial<Parameters<typeof ChatComposerEditor>[0]> & {
    onValueChange?: (v: string) => void
  } = {}
): { unmount: () => void; getByEditor: () => Editor } {
  const onValueChange = props.onValueChange ?? vi.fn()
  const result = render(
    <ChatComposerEditor
      value={props.value ?? ''}
      onValueChange={onValueChange}
      onBeforeEditorKeyDown={props.onBeforeEditorKeyDown}
      getSkillPaths={props.getSkillPaths}
      placeholder={props.placeholder ?? 'Type…'}
      ariaLabel="Test composer"
    />
  )
  return {
    unmount: result.unmount,
    getByEditor: () => {
      const el = document.querySelector('[data-composer-editor="true"]') as
        | (HTMLElement & { __composerEditor?: Editor | null })
        | null
      const editor = el?.__composerEditor
      if (!editor) throw new Error('editor not mounted')
      return editor
    }
  }
}

/** Build a paste `Event` whose `clipboardData.text/plain` payload is `plainText`.
 *
 *  jsdom does not expose a global `ClipboardEvent` constructor, so we dispatch a
 *  plain `Event('paste')` and define `clipboardData` on it (the property is
 *  undefined on a generic Event, so `defineProperty` works; ProseMirror's
 *  `editorProps.handlePaste` reads `event.clipboardData?.getData('text/plain')`
 *  and is called from the DOM `paste` listener regardless of the event's
 *  constructor). */
function pasteEvent(plainText: string, options: { types?: string[] } = {}): Event {
  const types = options.types ?? ['text/plain']
  const clipboardData = {
    types,
    getData: (type: string) => (type === 'text/plain' ? plainText : ''),
    setData: () => {},
    items: [],
    files: [] as File[]
  }
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', { value: clipboardData, configurable: true })
  return ev
}

afterEach(() => {
  // Destroy lingering editors so ProseMirror's MutationObserver/rAF don't
  // accumulate across tests in this file (same fix as the host test files).
  const els = document.querySelectorAll('[data-composer-editor="true"]')
  for (const el of Array.from(els)) {
    const handle = el as HTMLElement & {
      __composerEditor?: { destroy?: () => void; isDestroyed?: boolean } | null
    }
    const editor = handle.__composerEditor
    if (editor && typeof editor.destroy === 'function' && !editor.isDestroyed) {
      editor.destroy()
    }
  }
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ChatComposerEditor.handlePaste', () => {
  it('parses a sentinel-token clipboard into a pill node (matrix row 5: paste)', async () => {
    const onValueChange = vi.fn()
    const { getByEditor } = mountEditor({ onValueChange })

    // Wait for the editor to mount + the test handle to attach.
    await waitFor(() => expect(getByEditor()).toBeTruthy())

    // Place a caret mid-paragraph so the paste splices in.
    setComposerValue('before after')
    const editor = getByEditor()
    const el = editor.view.dom

    // Dispatch a paste carrying a sentinel skill token.
    act(() => {
      el.dispatchEvent(pasteEvent(`${skillToken('acp')}`))
    })

    // The pill renders as a visible span carrying the skill name.
    await waitFor(() => expect(document.querySelector('[data-skill-pill="true"]')).toBeTruthy())
    const pill = document.querySelector('[data-skill-pill="true"]') as HTMLElement
    expect(pill.getAttribute('data-skill-name')).toBe('acp')

    // The editor's serialized display string carries the padded token form
    // (`\uE000<name>\uE001\uE002<pad>\uE003`) — the padding block is re-emitted
    // for on-disk draft byte-stability.
    expect(getComposerValue()).toContain(skillToken('acp', SKILL_PAD_DEFAULT))
  })

  it('seeds the pasted pill path from getSkillPaths so a known skill resolves at send', async () => {
    const { getByEditor } = mountEditor({
      getSkillPaths: () => ({ acp: '/abs/SKILL.md' })
    })
    await waitFor(() => expect(getByEditor()).toBeTruthy())

    setComposerValue('x ')
    const editor = getByEditor()
    act(() => {
      editor.view.dom.dispatchEvent(pasteEvent(`${skillToken('acp')}`))
    })

    await waitFor(() => expect(document.querySelector('[data-skill-pill="true"]')).toBeTruthy())
    const pill = document.querySelector('[data-skill-pill="true"]') as HTMLElement
    // The path attr is seeded from getSkillPaths (patch 6: pasted pills get
    // known paths so buildPromptParts doesn't throw "missing a path").
    expect(pill.getAttribute('data-skill-path')).toBe('/abs/SKILL.md')
  })

  it('falls through to plain-text paste on a malformed (unclosed) sentinel clipboard without throwing', async () => {
    const { getByEditor } = mountEditor()
    await waitFor(() => expect(getByEditor()).toBeTruthy())

    setComposerValue('prefix ')
    const editor = getByEditor()
    const before = getComposerValue()

    act(() => {
      editor.view.dom.dispatchEvent(pasteEvent('\uE000no-close-here'))
    })

    // No pill was created (the malformed token couldn't parse → fell through to
    // plain-text paste; ProseMirror's default inserts the raw text).
    await waitFor(() => expect(getComposerValue()).not.toBe(before))
    expect(document.querySelector('[data-skill-pill="true"]')).toBeNull()
  })
})

describe('ChatComposerEditor keymap ordering (patch 13)', () => {
  it('runs onBeforeEditorKeyDown (Enter→submit) BEFORE StarterKit splitBlock — no new paragraph', async () => {
    let submitCalled = false
    const { getByEditor } = mountEditor({
      onBeforeEditorKeyDown: (event) => {
        // Simulate the host's Enter→submit: consume so the editor's base
        // keymap (StarterKit splitBlock) never runs.
        if (event.key === 'Enter' && !event.shiftKey) {
          submitCalled = true
          event.preventDefault()
          return true
        }
        return false
      }
    })
    await waitFor(() => expect(getByEditor()).toBeTruthy())

    // Type a non-empty doc.
    setComposerValue('hello world')
    const editor = getByEditor()

    const beforeParagraphs = editor.state.doc.content.childCount
    expect(beforeParagraphs).toBe(1)

    // Dispatch a real DOM keydown Enter so ProseMirror's handleKeyDown runs.
    act(() => {
      editor.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true
        })
      )
    })

    // Submit ran (the host's Enter→submit consumed the key).
    expect(submitCalled).toBe(true)
    // No new paragraph was inserted (StarterKit's splitBlock did NOT run) —
    // the doc still has exactly one paragraph.
    expect(editor.state.doc.content.childCount).toBe(1)
  })
})

describe('docToDisplayText round-trip (patches 7 + 11)', () => {
  it('re-emits the padding block after a pill so on-disk draft bytes are stable (patch 7)', async () => {
    const { getByEditor } = mountEditor()
    await waitFor(() => expect(getByEditor()).toBeTruthy())

    // Load a value carrying the ORIGINAL (variable-run) padding from a
    // pre-refactor saved draft. draftFromTokens consumes it; docToDisplayText
    // re-emits the FIXED single-figure-space padding. The presence of the
    // \uE002..\uE003 block is preserved (on-disk schema byte-stability); the
    // CONTENT normalizes to SKILL_PAD_DEFAULT.
    const oldDraft = `use this ${skillToken('acp', '   \u2007\u2007')} then`
    setComposerValue(oldDraft)

    const value = getComposerValue()
    // The re-emitted token carries the padding block (presence preserved).
    expect(value).toContain(skillToken('acp', SKILL_PAD_DEFAULT))
    // The original variable-run padding is NOT preserved (content normalizes
    // to the fixed single figure-space) — only the format presence is stable.
    expect(value).not.toContain('   \u2007\u2007')
  })

  it('suppresses the boundary \\n after a trailing hardBreak so multi-paragraph+hardBreak stays single-\\n (patch 11)', async () => {
    const { getByEditor } = mountEditor()
    await waitFor(() => expect(getByEditor()).toBeTruthy())

    const editor = getByEditor()
    // Construct a doc where paragraph1 ends in a hardBreak + paragraph2 — the
    // case that would yield `\n\n` (hardBreak + boundary) without the
    // suppression. Pre-refactor textarea produced a single `\n`.
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'line1' }, { type: 'hardBreak' }]
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'line2' }] }
        ]
      } as never)
    })

    // Single `\n` between line1 and line2 (hardBreak's `\n` + suppressed
    // boundary), NOT `\n\n`.
    expect(getComposerValue()).toBe('line1\nline2')
  })

  it('emits a single \\n for a normal multi-paragraph doc (no trailing hardBreak)', async () => {
    const { getByEditor } = mountEditor()
    await waitFor(() => expect(getByEditor()).toBeTruthy())

    setComposerValue('line1\nline2')
    // Two paragraphs (no hardBreak) → one boundary `\n`.
    expect(getComposerValue()).toBe('line1\nline2')
  })
})
