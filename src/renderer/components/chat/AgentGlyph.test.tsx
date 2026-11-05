import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EntryGlyph } from '@/components/agents/launcher/pickers'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import { AgentGlyph } from './AgentGlyph'

const glyph = (container: HTMLElement): HTMLElement =>
  container.querySelector<HTMLElement>('span[aria-hidden="true"]') as HTMLElement

describe('AgentGlyph brand colour', () => {
  it('draws a registry brand colour per theme, over the caller’s text colour', () => {
    const { container } = render(
      <AgentGlyph templateId="claude-acp" className="text-muted-foreground" />
    )
    const el = glyph(container)
    expect(el).toHaveAttribute('data-agent-brand')
    expect(el.style.getPropertyValue('--agent-brand-light')).toBe('#C15F3C')
    expect(el.style.getPropertyValue('--agent-brand-dark')).toBe('#D97757')
    expect(el).toHaveClass('text-(--agent-brand-light)', '[.dark_&]:text-(--agent-brand-dark)')
    expect(el).not.toHaveClass('text-muted-foreground')
  })

  it('keeps a monochrome mark on currentColor (no brand colour in the registry)', () => {
    const { container } = render(
      <AgentGlyph templateId="cursor" className="text-muted-foreground" />
    )
    const el = glyph(container)
    expect(el).not.toHaveAttribute('data-agent-brand')
    expect(el).toHaveClass('text-muted-foreground')
    expect(el.style.getPropertyValue('--agent-brand-light')).toBe('')
  })

  it('keeps an uploaded icon on currentColor even for a branded template', () => {
    const custom = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M0 0h16v16H0z"/></svg>'
    const { container } = render(<AgentGlyph icon={custom} templateId="claude-acp" />)
    expect(glyph(container)).not.toHaveAttribute('data-agent-brand')
    expect(glyph(container)).toHaveClass('text-foreground/80')
  })

  it('colours the bundled icon when it is the persisted one', () => {
    const svg = findBundledIconByKey('acp:claude-acp')?.svg ?? ''
    const { container } = render(<AgentGlyph icon={svg} />)
    expect(glyph(container)).toHaveAttribute('data-agent-brand')
  })

  it('gives each Gemini glyph its own gradient id, referenced by its own fill', () => {
    const { container } = render(
      <>
        <AgentGlyph templateId="gemini" />
        <AgentGlyph templateId="gemini" />
        <EntryGlyph config={null} templateId="gemini" />
      </>
    )
    const glyphs = Array.from(container.querySelectorAll<HTMLElement>('span[data-agent-brand]'))
    expect(glyphs).toHaveLength(3)
    const ids = glyphs.map((el) => el.querySelector('linearGradient')?.id ?? '')
    expect(new Set(ids).size).toBe(3)
    glyphs.forEach((el, i) => {
      expect(ids[i]).toMatch(/^agent-brand-[\w-]+$/)
      expect(el.style.getPropertyValue('--agent-brand-fill')).toBe(`url(#${ids[i]})`)
      expect(el.querySelectorAll('stop')).toHaveLength(2)
    })
  })

  it('adds no gradient to a solid brand', () => {
    const { container } = render(<AgentGlyph templateId="claude-acp" />)
    expect(container.querySelector('linearGradient')).toBeNull()
  })
})

describe('EntryGlyph brand colour', () => {
  it('a brand colour wins over colorClassName; monochrome marks keep it', () => {
    const { container } = render(
      <>
        <EntryGlyph config={null} templateId="claude-acp" colorClassName="text-current" />
        <EntryGlyph config={null} templateId="cursor" colorClassName="text-current" />
      </>
    )
    const [claude, cursor] = Array.from(
      container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')
    )
    expect(claude).toHaveAttribute('data-agent-brand')
    expect(claude).not.toHaveClass('text-current')
    expect(cursor).not.toHaveAttribute('data-agent-brand')
    expect(cursor).toHaveClass('text-current')
  })

  it('an unknown agent falls back to currentColor', () => {
    const { container } = render(<EntryGlyph config={null} templateId="no-such-agent" name="X" />)
    expect(container.querySelector('[data-agent-brand]')).toBeNull()
  })
})
