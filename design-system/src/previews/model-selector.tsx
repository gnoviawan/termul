import { useRef } from 'react'
import { AgentModelSelector } from '@/components/chat/agent-model-selector/AgentModelSelector'
import { SelectorPanel } from '@/components/chat/agent-model-selector/SelectorPanel'
import { Caption } from './kit'
import {
  MOCK_DEFAULT_MODEL,
  MOCK_NARROW_CONTEXT_MODEL,
  type MockSelectorState,
  useMockSelector
} from './model-selector-mocks'

/**
 * The live desktop popover surface (AgentModelSelector's AnimatedMenuContent
 * classes), drawn inline: the canvas world is transformed, so a portaled
 * popover would not sit inside the canvas item.
 */
const SURFACE =
  'flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md'

const NOOP = (): void => {}

function panelProps(state: MockSelectorState) {
  const { draft, agentTemplateId: _, ...rest } = state
  return { ...rest, source: draft.source, touch: false, disabled: false, onClose: NOOP }
}

function V1Column({ id, label, model }: { id: string; label: string; model: string }) {
  const state = useMockSelector(id, model)
  const escapeRef = useRef<(() => boolean) | null>(null)
  return (
    <div className="flex w-80 flex-col gap-3">
      <Caption>{label}</Caption>
      <div className={SURFACE}>
        <SelectorPanel {...panelProps(state)} escapeRef={escapeRef} />
      </div>
      <div className="flex justify-end">
        <AgentModelSelector
          draft={state.draft}
          disabled={false}
          busy={false}
          modelOption={state.modelOption}
          modelSource="config"
          thoughtLevel={state.thoughtLevel}
          fastMode={state.fastMode}
          agentTemplateId={state.agentTemplateId}
          agentIcon={null}
          genericOptions={state.genericOptions}
          onSetConfig={state.onSetConfig}
          onSetModel={state.onPickModel}
        />
      </div>
    </div>
  )
}

/** The current picker, unchanged, open on mock data through the draft path. */
export function ModelSelectorV1() {
  return (
    <div className="flex gap-6 p-5">
      <V1Column id="model-selector-v1-a" label="Context 300K · 1M" model={MOCK_DEFAULT_MODEL} />
      <V1Column
        id="model-selector-v1-b"
        label="Context 256K · 500K"
        model={MOCK_NARROW_CONTEXT_MODEL}
      />
    </div>
  )
}
