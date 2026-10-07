import { describe, expect, it } from 'vitest'
import {
  emptyPendingLauncherOptions,
  hasPendingLauncherOptions,
  optionsToPending,
  overlayPendingLauncherOptions
} from './pending-launcher-options'

describe('pending-launcher-options', () => {
  it('overlays pending model/mode/config onto cached options', () => {
    const overlaid = overlayPendingLauncherOptions({
      models: {
        currentModelId: 'm1',
        availableModels: [
          { modelId: 'm1', name: 'One' },
          { modelId: 'm2', name: 'Two' }
        ]
      },
      modes: {
        currentModeId: 'agent',
        availableModes: [
          { id: 'agent', name: 'Agent' },
          { id: 'plan', name: 'Plan' }
        ]
      },
      configOptions: [
        {
          id: 'thought_level',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: 'low',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' }
          ]
        }
      ],
      pending: {
        modelId: 'm2',
        modeId: 'plan',
        configValues: { thought_level: 'high' }
      }
    })

    expect(overlaid.models?.currentModelId).toBe('m2')
    expect(overlaid.modes?.currentModeId).toBe('plan')
    expect(overlaid.configOptions[0]?.currentValue).toBe('high')
    expect(hasPendingLauncherOptions(emptyPendingLauncherOptions())).toBe(false)
    expect(hasPendingLauncherOptions({ modelId: 'm2', configValues: {} })).toBe(true)
  })

  describe('optionsToPending', () => {
    it('derives the pending payload from the displayed snapshot (config model option)', () => {
      const pending = optionsToPending({
        models: null,
        modes: {
          currentModeId: 'plan',
          availableModes: [
            { id: 'agent', name: 'Agent' },
            { id: 'plan', name: 'Plan' }
          ]
        },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'm2',
            options: [
              { value: 'm1', name: 'One' },
              { value: 'm2', name: 'Two' }
            ]
          },
          {
            id: 'thought_level',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select',
            currentValue: 'high',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' }
            ]
          },
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'agent',
            options: [
              { value: 'agent', name: 'Agent' },
              { value: 'plan', name: 'Plan' }
            ]
          }
        ]
      })

      // The displayed snapshot becomes the launch payload: selected model,
      // mode, and every advertised config value — including the model config
      // option (apply-time dedupe keeps it from being applied twice).
      expect(pending.modelId).toBe('m2')
      expect(pending.modeId).toBe('plan')
      // The mode-category option is suppressed while native modes are
      // advertised (the Agent chip owns mode — the chip-display rule).
      expect(pending.configValues).toEqual({ model: 'm2', thought_level: 'high' })
    })

    it('keeps mode-category options in configValues when native modes are absent', () => {
      const pending = optionsToPending({
        models: null,
        modes: null,
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'bypass',
            options: [
              { value: 'plan', name: 'Plan' },
              { value: 'bypass', name: 'Bypass' }
            ]
          }
        ]
      })

      expect(pending.modeId).toBeUndefined()
      expect(pending.configValues).toEqual({ mode: 'bypass' })
    })

    it('derives the model from native models state when no model config option exists', () => {
      const pending = optionsToPending({
        models: {
          currentModelId: 'openrouter/gpt-5.5',
          availableModels: [
            { modelId: 'kiro/claude-opus-4-8', name: 'Kiro' },
            { modelId: 'openrouter/gpt-5.5', name: 'OpenRouter' }
          ]
        },
        modes: null,
        configOptions: []
      })

      expect(pending.modelId).toBe('openrouter/gpt-5.5')
      expect(pending.configValues).toEqual({})
    })

    it('prefers the model config option over the native models projection', () => {
      const pending = optionsToPending({
        models: {
          currentModelId: 'native-m1',
          availableModels: [{ modelId: 'native-m1', name: 'Native' }]
        },
        modes: null,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'config-m2',
            options: [{ value: 'config-m2', name: 'Config Two' }]
          }
        ]
      })

      expect(pending.modelId).toBe('config-m2')
    })

    it('produces an empty payload when nothing is advertised', () => {
      const pending = optionsToPending({ models: null, modes: null, configOptions: [] })
      expect(pending).toEqual({ modelId: undefined, modeId: undefined, configValues: {} })
      expect(hasPendingLauncherOptions(pending)).toBe(false)
    })

    it('stores a boolean option as true or false text', () => {
      const pending = optionsToPending({
        models: null,
        modes: null,
        configOptions: [
          {
            id: 'approvals',
            name: 'Approvals',
            category: null,
            type: 'boolean',
            currentValue: true
          }
        ]
      })

      expect(pending.configValues).toEqual({ approvals: 'true' })
    })

    it('only carries DISPLAYED options — hidden and duplicate-singleton entries stay out', () => {
      const pending = optionsToPending({
        models: null,
        modes: null,
        configOptions: [
          {
            id: 'hidden',
            name: 'Hidden',
            category: null,
            type: 'select',
            currentValue: 'x',
            options: []
          },
          {
            id: 'thought_level',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select',
            currentValue: 'high',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' }
            ]
          },
          {
            // Second option in a promoted singleton category is never
            // rendered (#444) — its value must not ship either.
            id: 'thought_level_extra',
            name: 'Thinking extra',
            category: 'thought_level',
            type: 'select',
            currentValue: 'low',
            options: [{ value: 'low', name: 'Low' }]
          }
        ]
      })

      expect(pending.configValues).toEqual({ thought_level: 'high' })
    })

    it('treats an empty availableModes list as no mode API (mode option stays displayed)', () => {
      const pending = optionsToPending({
        models: null,
        // modes object present but empty — the Agent chip is hidden and the
        // mode config option remains the displayed control.
        modes: { currentModeId: 'agent', availableModes: [] },
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'bypass',
            options: [
              { value: 'agent', name: 'Agent' },
              { value: 'bypass', name: 'Bypass' }
            ]
          }
        ]
      })

      expect(pending.modeId).toBeUndefined()
      expect(pending.configValues).toEqual({ mode: 'bypass' })
    })
  })

  describe('overlayPendingLauncherOptions', () => {
    it('paints pending.modelId onto a model-category config option', () => {
      const overlaid = overlayPendingLauncherOptions({
        models: null,
        modes: null,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'm1',
            options: [
              { value: 'm1', name: 'One' },
              { value: 'm2', name: 'Two' }
            ]
          }
        ],
        pending: { modelId: 'm2', configValues: {} }
      })

      expect(overlaid.configOptions[0]?.currentValue).toBe('m2')
    })

    it('paints a stored boolean back onto the option', () => {
      const overlaid = overlayPendingLauncherOptions({
        models: null,
        modes: null,
        configOptions: [
          {
            id: 'approvals',
            name: 'Approvals',
            category: null,
            type: 'boolean',
            currentValue: false
          }
        ],
        pending: { configValues: { approvals: 'true' } }
      })

      expect(overlaid.configOptions[0]?.currentValue).toBe(true)
    })

    it('does not paint a modelId the model config option does not advertise', () => {
      const overlaid = overlayPendingLauncherOptions({
        models: null,
        modes: null,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'm1',
            options: [{ value: 'm1', name: 'One' }]
          }
        ],
        pending: { modelId: 'm9', configValues: {} }
      })

      expect(overlaid.configOptions[0]?.currentValue).toBe('m1')
    })
  })
})
