import { describe, expect, it } from 'vitest'
import type { SessionModelState, SessionModeState } from '@/lib/acp-api'
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingVisible,
  resolveSessionModes,
  supportsXhighFallback
} from '@/lib/acp-thinking'

const allModes = (): SessionModeState => ({
  currentModeId: 'xhigh',
  availableModes: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((id) => ({
    id,
    name: `Thinking: ${id}`
  }))
})

describe('getSupportedThinkingLevels', () => {
  it('returns off only for non-reasoning models', () => {
    expect(getSupportedThinkingLevels({ modelId: 'c/m', name: 'c/m', reasoning: false })).toEqual([
      'off'
    ])
  })

  it('omits xhigh without thinkingLevelMap when model lacks xhigh support', () => {
    expect(
      getSupportedThinkingLevels({
        modelId: 'cursor/grok-build-0.1',
        name: 'cursor/grok-build-0.1',
        reasoning: true
      })
    ).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
  })

  it('respects thinkingLevelMap null entries', () => {
    expect(
      getSupportedThinkingLevels({
        modelId: 'openai/gpt-5.2',
        name: 'openai/gpt-5.2',
        reasoning: true,
        thinkingLevelMap: {
          off: 'off',
          minimal: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh'
        }
      })
    ).toContain('xhigh')
  })
})

describe('resolveSessionModes', () => {
  it('hides thinking chip for non-reasoning models', () => {
    const models: SessionModelState = {
      currentModelId: 'cursor/claude-fable-5-high',
      availableModels: [
        {
          modelId: 'cursor/claude-fable-5-high',
          name: 'cursor/claude-fable-5-high',
          reasoning: false
        }
      ]
    }
    expect(resolveSessionModes(allModes(), models)).toBeNull()
  })

  it('clamps invalid current mode after model switch metadata', () => {
    const models: SessionModelState = {
      currentModelId: 'cursor/grok-build-0.1',
      availableModels: [
        {
          modelId: 'cursor/grok-build-0.1',
          name: 'cursor/grok-build-0.1',
          reasoning: true
        }
      ]
    }
    const resolved = resolveSessionModes(allModes(), models)
    expect(resolved?.availableModes.map((m) => m.id)).not.toContain('xhigh')
    expect(resolved?.currentModeId).toBe('high')
  })
})

describe('clampThinkingLevel', () => {
  it('steps down from xhigh to high when xhigh unsupported', () => {
    expect(clampThinkingLevel('xhigh', ['off', 'minimal', 'low', 'medium', 'high'])).toBe('high')
  })
})

describe('isThinkingVisible', () => {
  it('is false when legacy mode is off', () => {
    expect(
      isThinkingVisible(
        {
          currentModeId: 'off',
          availableModes: [{ id: 'off', name: 'Thinking: off' }]
        },
        {
          currentModelId: 'cursor/grok-build-0.1',
          availableModels: [{ modelId: 'cursor/grok-build-0.1', name: 'grok', reasoning: true }]
        }
      )
    ).toBe(false)
  })

  it('is true when mode is not off', () => {
    expect(
      isThinkingVisible(
        {
          currentModeId: 'high',
          availableModes: [
            { id: 'off', name: 'Thinking: off' },
            { id: 'high', name: 'Thinking: high' }
          ]
        },
        {
          currentModelId: 'cursor/grok-build-0.1',
          availableModels: [{ modelId: 'cursor/grok-build-0.1', name: 'grok', reasoning: true }]
        }
      )
    ).toBe(true)
  })
})

describe('supportsXhighFallback', () => {
  it('detects opus 4.7 models', () => {
    expect(supportsXhighFallback({ modelId: 'cursor/claude-opus-4-7-high', name: 'opus' })).toBe(
      true
    )
  })
})
