import { describe, it, expect } from 'vitest'
import { AGENT_TEMPLATES, templateById, templateIcon } from './agent-templates'

describe('agent-templates', () => {
  it('includes the well-known ACP registry agents', () => {
    const ids = AGENT_TEMPLATES.map((t) => t.id)
    for (const id of ['gemini', 'claude-acp', 'codex-acp', 'github-copilot-cli', 'custom']) {
      expect(ids).toContain(id)
    }
  })

  it('every template has a name+command (except the empty custom one) and defaults terminal off', () => {
    for (const t of AGENT_TEMPLATES) {
      expect(t.config.allowTerminal).toBe(false)
      if (t.id !== 'custom') {
        expect(t.config.name.length).toBeGreaterThan(0)
        expect(t.config.command.length).toBeGreaterThan(0)
      }
    }
  })

  it('npx-distributed templates pass -y for non-interactive install', () => {
    for (const t of AGENT_TEMPLATES) {
      if (t.config.command === 'npx') {
        expect(t.config.args[0]).toBe('-y')
      }
    }
  })

  it('templateById resolves a known template and returns undefined otherwise', () => {
    expect(templateById('gemini')?.label).toBe('Gemini CLI')
    expect(templateById('does-not-exist')).toBeUndefined()
  })

  it('templateIcon returns a component for agents with icons and undefined otherwise', () => {
    expect(templateIcon('gemini')).toBeTypeOf('function')
    expect(templateIcon('codex-acp')).toBeTypeOf('function')
    // custom has no icon
    expect(templateIcon('custom')).toBeUndefined()
    expect(templateIcon(undefined)).toBeUndefined()
    expect(templateIcon('nope')).toBeUndefined()
  })
})
