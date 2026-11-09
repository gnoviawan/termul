import { EditorView } from '@codemirror/view'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { findThemeRuleValue } from '@/test-utils/codemirror-cssom'
import { CommandChips } from './chips'
import { TerminalInputSurface } from './TerminalInputSurface'

it('missing chip is hidden', () => {
  const { rerender } = render(<CommandChips cwd="/repo" />)
  expect(screen.getByLabelText('Working directory')).toHaveTextContent('/repo')
  expect(screen.queryByLabelText('Git branch')).not.toBeInTheDocument()
  rerender(<CommandChips cwd="" gitBranch="main" />)
  expect(screen.queryByLabelText('Working directory')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Git branch')).toHaveTextContent('main')
  rerender(<CommandChips gitBranch="" />)
  expect(screen.queryByLabelText('Working directory')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Git branch')).not.toBeInTheDocument()
})

it('chip update stays in the editor', () => {
  const { rerender } = render(
    <TerminalInputSurface mode="Editor" focused={false} terminalId="chip-terminal" cwd="/repo">
      <div data-testid="scrollback" />
    </TerminalInputSurface>
  )
  const composer = screen.getByRole('textbox', { name: 'Command editor' })
  const editorDOM = composer.closest('.cm-editor')
  expect(editorDOM).not.toBeNull()
  expect(screen.queryByLabelText('Git branch')).not.toBeInTheDocument()
  rerender(
    <TerminalInputSurface
      mode="Editor"
      focused={false}
      terminalId="chip-terminal"
      cwd="/repo"
      gitBranch="main"
    >
      <div data-testid="scrollback" />
    </TerminalInputSurface>
  )
  expect(screen.getByRole('textbox', { name: 'Command editor' }).closest('.cm-editor')).toBe(
    editorDOM
  )
  expect(screen.getByLabelText('Git branch')).toHaveTextContent('main')
  expect(screen.getByTestId('scrollback').parentElement).toHaveAttribute(
    'data-keyboard-target',
    'false'
  )
  rerender(
    <TerminalInputSurface
      mode="PTY"
      focused={false}
      terminalId="chip-terminal"
      cwd="/repo"
      gitBranch="main"
    >
      {null}
    </TerminalInputSurface>
  )
  expect(screen.queryByLabelText('Git branch')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Working directory')).not.toBeInTheDocument()
})

it('metadata chips are spans without an implicit live region', () => {
  render(<CommandChips cwd="/repo" gitBranch="main" />)
  for (const label of ['Working directory', 'Git branch']) {
    const chip = screen.getByLabelText(label)
    expect(chip.tagName).toBe('SPAN')
    expect(chip).not.toHaveAttribute('aria-live')
  }
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('each chip has an svg icon, title matching value, rounded-md, and not rounded-full', () => {
  render(<CommandChips cwd="/repo/path" gitBranch="feature-branch" />)
  const cwdChip = screen.getByLabelText('Working directory')
  expect(cwdChip).toHaveAttribute('title', '/repo/path')
  expect(cwdChip.className).toContain('rounded-md')
  expect(cwdChip.className).not.toContain('rounded-full')
  expect(cwdChip.querySelector('svg[aria-hidden="true"]')).not.toBeNull()

  const branchChip = screen.getByLabelText('Git branch')
  expect(branchChip).toHaveAttribute('title', 'feature-branch')
  expect(branchChip.className).toContain('rounded-md')
  expect(branchChip.className).not.toContain('rounded-full')
  expect(branchChip.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
})

it('renders editor block with border-t, border-border, bg-card, and no focus-within:border-ring without field borders on cm-content', () => {
  const { container } = render(
    <TerminalInputSurface mode="Editor" focused={false} terminalId="block-terminal" cwd="/repo">
      <div data-testid="scrollback" />
    </TerminalInputSurface>
  )
  const block = container.querySelector('[data-slot="command-editor-block"]')
  expect(block).not.toBeNull()
  expect(block?.className).toContain('border-t')
  expect(block?.className).toContain('border-border')
  expect(block?.className).toContain('bg-card')
  expect(block?.className).not.toContain('focus-within:border-ring')

  const content = container.querySelector('.cm-content')
  expect(content).not.toBeNull()
  expect(content?.className).not.toContain('border-field-border')
  expect(content?.className).not.toContain('rounded-md')
})

it('removes focus outline via theme rule on editor', () => {
  const { container } = render(
    <TerminalInputSurface mode="Editor" focused={false} terminalId="theme-terminal" cwd="/repo">
      <div data-testid="scrollback" />
    </TerminalInputSurface>
  )
  const editorEl = container.querySelector<HTMLElement>('.cm-editor')
  expect(editorEl).not.toBeNull()
  const view = EditorView.findFromDOM(editorEl!)
  expect(view).not.toBeNull()

  const classes = view!.themeClasses.split(/\s+/).filter(Boolean)
  let found = false
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule)) continue
        for (const cls of classes) {
          if (
            rule.selectorText === `.${cls}.cm-focused` &&
            (rule.style.outlineStyle === 'none' || rule.style.outline.includes('none'))
          ) {
            found = true
            break
          }
        }
        if (found) break
      }
    } catch {
      // ignore
    }
    if (found) break
  }
  expect(found).toBe(true)
})

it('themes command editor focus with themed caret, cursor border, and selection wash', () => {
  const { container } = render(
    <TerminalInputSurface
      mode="Editor"
      focused={false}
      terminalId="theme-caret-terminal"
      cwd="/repo"
    >
      <div data-testid="scrollback" />
    </TerminalInputSurface>
  )
  const editorEl = container.querySelector<HTMLElement>('.cm-editor')
  expect(editorEl).not.toBeNull()
  const view = EditorView.findFromDOM(editorEl!)
  expect(view).not.toBeNull()

  expect(findThemeRuleValue(view!, '.cm-content', 'caret-color')).toBe('oklch(var(--primary))')
  expect(findThemeRuleValue(view!, '.cm-cursor', 'border-left-color')).toBe('oklch(var(--primary))')
  expect(findThemeRuleValue(view!, '.cm-selectionBackground', 'background-color')).toBe(
    'oklch(var(--foreground) / 0.14)'
  )
})
