import { describe, expect, it } from 'vitest'
import {
  emptyPendingLauncherOptions,
  hasPendingLauncherOptions,
  launchPending,
  mergeRestoredPending,
  optionsToPending,
  overlayPendingLauncherOptions,
  pendingWithModel,
  restoredLauncherOptions
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

    it('paints pending.modelId onto a model inside a grouped select option', () => {
      const overlaid = overlayPendingLauncherOptions({
        models: null,
        modes: null,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gemini-flash',
            options: [
              { value: 'gemini-flash', name: 'Gemini Flash' },
              {
                group: 'anthropic',
                name: 'Anthropic',
                options: [{ value: 'claude-sonnet', name: 'Claude Sonnet' }]
              }
            ]
          }
        ],
        pending: { modelId: 'claude-sonnet', configValues: {} }
      })

      expect(overlaid.configOptions[0]?.currentValue).toBe('claude-sonnet')
    })
  })
})

describe('restoring the launcher from a saved record', () => {
  const select = (id: string, category: string, current: string, values: string[]) => ({
    id,
    name: id,
    category,
    type: 'select' as const,
    currentValue: current,
    options: values.map((value) => ({ value, name: value }))
  })
  /** The launcher's options while `model` is on screen; Claude-style permission mode as a config option. */
  const optionsFor = (model: string) => [
    select('model', 'model', model, ['opus', 'sonnet']),
    select('effort', 'thought_level', 'medium', ['low', 'medium', 'high']),
    select('permission', 'mode', 'default', ['default', 'bypass'])
  ]
  const SAVED = {
    modelId: 'opus',
    configValues: { model: 'opus', effort: 'high', permission: 'bypass' },
    modelValues: { opus: { effort: 'high' }, sonnet: { effort: 'low' } }
  }
  const restore = (input: Partial<Parameters<typeof restoredLauncherOptions>[0]>) => {
    const dropped: string[] = []
    const pending = restoredLauncherOptions({
      saved: SAVED,
      pick: null,
      models: null,
      modes: null,
      configOptions: optionsFor('opus'),
      onDrop: (what) => dropped.push(what),
      ...input
    })
    return { pending, dropped }
  }

  it("brings back the saved model with that model's own values and the agent-wide mode", () => {
    expect(restore({}).pending).toEqual({
      modelId: 'opus',
      modeId: undefined,
      configValues: { permission: 'bypass', effort: 'high', model: 'opus' }
    })
  })

  it("keeps the saved model's values and the mode on a cold start, before the options load", () => {
    expect(restore({ configOptions: [] }).pending).toEqual({
      modelId: 'opus',
      modeId: undefined,
      configValues: { permission: 'bypass', effort: 'high' }
    })
  })

  it('keeps a legacy record’s flat values on a cold start', () => {
    const { pending, dropped } = restore({
      saved: {
        modelId: 'opus',
        configValues: { model: 'opus', effort: 'low', permission: 'bypass' }
      },
      configOptions: []
    })
    expect(pending).toEqual({
      modelId: 'opus',
      modeId: undefined,
      configValues: { effort: 'low', permission: 'bypass' }
    })
    expect(dropped).toEqual([])
  })

  it('drops a value the options of the same model no longer offer', () => {
    const { pending, dropped } = restore({
      saved: { modelId: 'opus', modelValues: { opus: { effort: 'max' } } }
    })
    expect(pending.configValues).toEqual({ model: 'opus' })
    expect(dropped).toEqual(['option effort'])
  })

  it("keeps a value unchecked while another model's options are on screen", () => {
    const { pending, dropped } = restore({
      saved: { modelId: 'opus', modelValues: { opus: { effort: 'max' } } },
      configOptions: optionsFor('sonnet')
    })
    expect(pending.configValues).toEqual({ effort: 'max', model: 'opus' })
    expect(dropped).toEqual([])
  })

  it("a model picked with its agent comes with that model's values, or the favorite's", () => {
    const pick = { modelId: 'sonnet', modelConfigId: 'model' }
    expect(restore({ pick }).pending.configValues).toEqual({
      permission: 'bypass',
      effort: 'low',
      model: 'sonnet'
    })
    expect(
      restore({ pick: { ...pick, values: { effort: 'medium' } } }).pending.configValues
    ).toEqual({ permission: 'bypass', effort: 'medium', model: 'sonnet' })
  })

  it('a record from before per-model values restores its flat values', () => {
    const { pending } = restore({
      saved: { modelId: 'opus', configValues: { model: 'sonnet', effort: 'low' } }
    })
    expect(pending).toEqual({
      modelId: 'opus',
      modeId: undefined,
      configValues: { effort: 'low', model: 'opus' }
    })
  })

  it("a model pick replaces the last model's values with its own and keeps the mode", () => {
    const prev = {
      modelId: 'opus',
      modeId: 'plan',
      configValues: { model: 'opus', effort: 'high', permission: 'bypass' }
    }
    const options = optionsFor('opus')
    expect(pendingWithModel(prev, 'sonnet', { effort: 'low' }, 'model', options)).toEqual({
      modelId: 'sonnet',
      modeId: 'plan',
      configValues: { permission: 'bypass', effort: 'low', model: 'sonnet' }
    })
    expect(pendingWithModel(prev, 'sonnet', {}, 'model', options).configValues).toEqual({
      permission: 'bypass',
      model: 'sonnet'
    })
  })

  it('a model pick before any option is known keeps the earlier values for the live apply', () => {
    const prev = { modelId: 'opus', configValues: { effort: 'high', permission: 'bypass' } }
    expect(pendingWithModel(prev, 'sonnet', { effort: 'low' }, null, [])).toEqual({
      modelId: 'sonnet',
      configValues: { effort: 'low', permission: 'bypass' }
    })
  })

  describe('the launch payload', () => {
    const options = optionsFor('opus')

    it("keeps the shown effort when the launch runs the shown options' model", () => {
      const displayed = {
        modelId: 'opus',
        configValues: { model: 'opus', effort: 'high', permission: 'default' }
      }
      expect(launchPending(displayed, { configValues: {} }, { modelId: 'opus', options })).toEqual({
        modelId: 'opus',
        modeId: undefined,
        configValues: displayed.configValues
      })
    })

    it("drops the shown effort of another model: a never-tuned pick launches on the agent's default", () => {
      const displayed = {
        modelId: 'sonnet',
        configValues: { model: 'sonnet', effort: 'high', permission: 'default' }
      }
      const pending = { modelId: 'sonnet', configValues: { model: 'sonnet' } }
      expect(launchPending(displayed, pending, { modelId: 'opus', options })).toEqual({
        modelId: 'sonnet',
        modeId: undefined,
        configValues: { model: 'sonnet', permission: 'default' }
      })
    })
  })
})

describe('merging a restore that lands after the user started picking', () => {
  const SAVED = {
    modelId: 'opus',
    configValues: { model: 'opus', effort: 'high', fast: 'on', permission: 'plan' },
    modelValues: { opus: { effort: 'high', fast: 'on' } }
  }
  const RESTORED = {
    modelId: 'opus',
    configValues: { effort: 'high', fast: 'on', permission: 'plan' }
  }

  it("a model picked during a cold-start read keeps its own values, not the restored model's", () => {
    const prev = { modelId: 'sonnet', configValues: { model: 'sonnet' } }
    expect(mergeRestoredPending(prev, RESTORED, SAVED, [])).toEqual({
      modelId: 'sonnet',
      modeId: undefined,
      configValues: { model: 'sonnet', permission: 'plan' }
    })
  })

  it('an edit made during the read wins over the restored value of the same model', () => {
    const prev = { configValues: { effort: 'low' } }
    expect(mergeRestoredPending(prev, RESTORED, SAVED, [])).toEqual({
      modelId: 'opus',
      modeId: undefined,
      configValues: { effort: 'low', fast: 'on', permission: 'plan' }
    })
  })
})
