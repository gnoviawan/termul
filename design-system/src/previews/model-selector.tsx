import { useReducedMotion } from 'framer-motion'
import { useRef, useState } from 'react'
import { AttachFilesButton } from '@/components/chat/AttachFilesButton'
import { AgentModelSelector } from '@/components/chat/agent-model-selector/AgentModelSelector'
import {
  createFavoritesStore,
  type FavoriteModel,
  memoryFavoritesAdapter
} from '@/components/chat/agent-model-selector/favorite-models'
import { SelectorPanel } from '@/components/chat/agent-model-selector/SelectorPanel'
import { SelectorPanelV2 } from '@/components/chat/agent-model-selector/SelectorPanelV2'
import { favoriteFor } from '@/components/chat/agent-model-selector/selector-model'
import { ComposerBeamShell } from '@/components/chat/ComposerBeamShell'
import { CHAT_GUTTER_X, COMPOSER_CARD_CLASS } from '@/components/chat/chat-layout'
import { ChatComposerEditor } from '@/components/chat/composer/ChatComposerEditor'
import { ComposerSendButton } from '@/components/chat/composer/ComposerSendButton'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent } from '@/components/ui/message'
import { COMPOSER_FOCUS_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { Caption } from './kit'
import {
  MOCK_AGENT_CONFIGS,
  MOCK_DEFAULT_MODEL,
  MOCK_ENTRIES,
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

/**
 * Seed favorites, keyed the way the app store keys them: the agent's config id
 * from `armableConfigId`, never the agent id. Oldest first.
 */
const SEED_FAVORITES: FavoriteModel[] = (
  [
    ['cursor', 'claude-4.6-sonnet-thinking-max'],
    ['claude-acp', 'opus-1m'],
    ['codex-acp', 'gpt-5.4-codex']
  ] as const
).flatMap(([agentId, modelId], index) => {
  const entry = MOCK_ENTRIES.find((e) => e.agent.id === agentId)
  const key = entry ? favoriteFor(entry, MOCK_AGENT_CONFIGS, modelId) : null
  return key ? [{ ...key, addedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() }] : []
})

function V2Column({
  id,
  label,
  model,
  agentRail,
  manyAgents
}: {
  id: string
  label: string
  model: string
  agentRail?: 'top' | 'left'
  manyAgents?: boolean
}) {
  const state = useMockSelector(id, model, { manyAgents })
  // Each preview stars on its own, in memory: the canvas never touches the
  // app's localStorage favorites.
  const [favoritesStore] = useState(() =>
    createFavoritesStore(memoryFavoritesAdapter(SEED_FAVORITES))
  )
  const escapeRef = useRef<(() => boolean) | null>(null)
  return (
    // Room on the right for the Edit flyout.
    <div className={`flex ${agentRail === 'left' ? 'w-140' : 'w-130'} flex-col gap-3`}>
      <Caption>{label}</Caption>
      <div className={`${SURFACE} self-start`}>
        <SelectorPanelV2
          {...panelProps(state)}
          favoritesStore={favoritesStore}
          agentRail={agentRail}
          escapeRef={escapeRef}
        />
      </div>
    </div>
  )
}

/**
 * Model picker v2, view only: same source and mock as v1. In the app it sits
 * behind `localStorage['termul.modelPickerV2'] = '1'`. Visual direction after
 * volt (MIT, github.com/LeulAria/volt), on Termul tokens.
 */
export function ModelSelectorV2() {
  return (
    <div className="flex gap-6 p-5">
      <V2Column id="model-selector-v2-a" label="Context 300K · 1M" model={MOCK_DEFAULT_MODEL} />
      <V2Column
        id="model-selector-v2-b"
        label="Context 256K · 500K"
        model={MOCK_NARROW_CONTEXT_MODEL}
      />
    </div>
  )
}

/** Model picker v2 with the agent tabs as a rail left of the list. */
export function ModelSelectorV2Rail() {
  return (
    <div className="flex gap-6 p-5">
      <V2Column
        id="model-selector-v2-rail-a"
        label="Context 300K · 1M"
        model={MOCK_DEFAULT_MODEL}
        agentRail="left"
      />
      <V2Column
        id="model-selector-v2-rail-b"
        label="Context 256K · 500K"
        model={MOCK_NARROW_CONTEXT_MODEL}
        agentRail="left"
      />
    </div>
  )
}

/**
 * Fourteen agents (11 installed, 3 to install): the rail fills its 10 slots,
 * the strip its 8, and "More" holds the rest, installed first, A to Z.
 */
export function ModelSelectorV2ManyAgents() {
  return (
    <div className="flex gap-6 p-5">
      <V2Column
        id="model-selector-v2-many-rail"
        label="Rail · 14 agents"
        model={MOCK_DEFAULT_MODEL}
        agentRail="left"
        manyAgents
      />
      <V2Column
        id="model-selector-v2-many-top"
        label="Top strip · 14 agents"
        model={MOCK_DEFAULT_MODEL}
        manyAgents
      />
    </div>
  )
}

/**
 * The v2 picker where it lives: the chat composer's model pill, opening the
 * real `AgentModelSelector` popover above it (left rail). The composer is
 * `ChatInputBar`'s desktop markup on its own tokens and parts, minus what
 * needs a live session (mode chip, MCP, context strip). Mock data, launcher
 * (draft) path: a pick lands at once and the pill follows it.
 */
export function ModelSelectorV2Composer() {
  const state = useMockSelector('model-selector-v2-composer', MOCK_DEFAULT_MODEL)
  const reduced = useReducedMotion() ?? false
  const [value, setValue] = useState('')
  const [favoritesStore] = useState(() =>
    createFavoritesStore(memoryFavoritesAdapter(SEED_FAVORITES))
  )
  return (
    <div className="@container flex h-full flex-col bg-background">
      <div className={cn(CHAT_GUTTER_X, 'flex flex-1 flex-col justify-end')}>
        <div className="mx-auto w-full max-w-3xl">
          <Message align="end" className="py-2">
            <MessageContent className="w-fit max-w-[85%]">
              <Bubble variant="tinted" align="end" className="max-w-full">
                <BubbleContent className="whitespace-pre-wrap">
                  Add a health check to the API server.
                </BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
          <Message align="start" className="py-2">
            <MessageContent className="min-w-0 flex-1">
              <Bubble variant="ghost" className="w-full">
                <BubbleContent>
                  Added GET /healthz returning 200 with uptime. Tests pass.
                </BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        </div>
      </div>
      <div className={cn(CHAT_GUTTER_X, 'pb-6 pt-3')}>
        <div className="relative mx-auto w-full max-w-3xl">
          <ComposerBeamShell busy={false} reduced={reduced}>
            <div
              data-chat-composer="true"
              className={cn('relative', COMPOSER_CARD_CLASS, COMPOSER_FOCUS_CLASS)}
            >
              <div className="flex items-start gap-1 px-4 pb-1.5 pt-3.5">
                <ChatComposerEditor
                  className="min-w-0 flex-1"
                  value={value}
                  onValueChange={setValue}
                  minHeight={26}
                  maxHeight={78}
                  placeholder="Ask anything… (/ for commands, @ for files)"
                />
              </div>
              <div
                className="flex items-center justify-between gap-3 px-2 pb-2"
                data-composer-toolbar="wide"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <AttachFilesButton onClick={NOOP} />
                </div>
                <div className="flex min-w-0 items-center justify-end gap-2.5">
                  <div
                    className="flex min-w-0 flex-wrap items-center justify-end gap-2.5"
                    data-composer-toolbar-row="single"
                  >
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
                      v2PanelProps={{ agentRail: 'left', favoritesStore }}
                    />
                  </div>
                  <ComposerSendButton
                    showStop={false}
                    canSend={value.trim() !== ''}
                    busy={false}
                    reduced={reduced}
                    onCancel={NOOP}
                    onSubmit={() => setValue('')}
                  />
                </div>
              </div>
            </div>
          </ComposerBeamShell>
        </div>
      </div>
    </div>
  )
}
