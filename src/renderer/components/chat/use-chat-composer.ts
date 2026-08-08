import type { KeyboardEvent, MutableRefObject, RefObject } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { buildPromptWithLoadedSkills } from '@/hooks/use-agent-skills'
import type { AvailableCommand, SessionConfigOption, SessionModeState } from '@/lib/acp-api'
import { measureSkillPadding } from '@/lib/skill-chip-metrics'
import {
  extractSkillNames,
  insertSkillToken,
  removeSkillTokenBeforeCaret,
  SKILL_TOKEN_START
} from '@/lib/skill-tokens'
import type { AgentSkillSummary } from '@/lib/skills-api'
import type { SlashMenuHandle } from './SlashCommandMenu'
import { tryHandleSlashMenuKeyDown } from './slash-menu-keyboard'
import {
  buildSlashSections,
  findSlashTrigger,
  isSlashTriggerAny,
  type SlashItem,
  type SlashSection,
  slashFilter
} from './slash-menu-model'

/**
 * Shared chat-composer state + handlers for the two composer hosts
 * (`ChatInputBar` — the running chatbox — and `AgentLauncher` — the new-chat
 * screen). This is a LOGIC extraction, not a JSX extraction: the two surfaces
 * keep their own outer chrome (BorderBeam/queue vs agent picker/banners), but
 * route the duplicated composer-field logic — slash menu, skill-token splice,
 * command chip, submit text builder — through this hook so they cannot drift
 * again.
 *
 * The hook is renderer-neutral: no Tauri/runtime calls, no JSX. Both surfaces
 * keep their own `submit()`/`launch()` because the dispatch shapes differ
 * (`onSend`/`onSendBlocks` vs `finalizeChatLaunch`/`sendPromptBlocks`), but
 * both read `activeCommand` + `skillPathsRef` + `buildPromptParts()` from the
 * hook to build the wire/display text identically.
 */
export interface UseChatComposerArgs {
  value: string
  setValue: (v: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  slashMenuRef: RefObject<SlashMenuHandle | null>
  commands: AvailableCommand[]
  configOptions: SessionConfigOption[]
  modes: SessionModeState | null
  skills: AgentSkillSummary[]
  disabled: boolean
  onSetConfig: (configId: string, valueId: string) => void | Promise<void>
  onSetMode: (modeId: string) => void | Promise<void>
  /**
   * Reserved for model-row parity (the model chip routes native ACP models
   * through `onSetModel` when `modelSource === 'models'`). Slash-menu model
   * rows currently flow through the `config` branch → `onSetConfig`, matching
   * the canonical `ChatInputBar` behavior; these fields are kept on the
   * interface so a future model-row divergence can land without reshaping it.
   */
  onSetModel?: (modelId: string) => void | Promise<void>
  modelOption?: SessionConfigOption | null
  modelSource?: 'models' | 'config'
  /** Mention-menu keyboard dispatch from `useComposerTextarea`. */
  handleMentionKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  updateMentions: (v: string, caret: number) => void
  resetMentions: () => void
  resetHeight: () => void
  clampHeight: (el: HTMLTextAreaElement) => void
}

export interface ChatPromptParts {
  /** Resolved skills with their SKILL.md paths (for the wire header). */
  skills: Array<{ name: string; path: string }>
  hasSkills: boolean
  /** Wire text dispatched to the agent (skills framed by path, tokens → `(name)`). */
  wireText: string
  /** Display text stored in the optimistic user message (raw token value). */
  displayText: string
  /** Wire text with the active command (`/cmd `) prefixed when set. */
  wireWithCommand: string
  /** Display text with the active command (`/cmd `) prefixed when set. */
  displayWithCommand: string
  wireTrimmed: string
  displayTrimmed: string
}

export interface UseChatComposerResult {
  slashOpen: boolean
  slashSections: SlashSection[]
  activeCommand: string | null
  setActiveCommand: (v: string | null) => void
  clearActiveCommand: () => void
  skillPathsRef: MutableRefObject<Record<string, string>>
  hasSkillToken: boolean
  handleSelect: (item: SlashItem) => void
  /**
   * Shared keydown for the composer textarea: skill-token backspace, slash-menu
   * arrow/Tab/Enter/Escape, and @-mention arrow/Tab/Enter/Escape. Enter→submit
   * and Escape→cancel/launch are surface-specific (the dispatch shapes differ),
   * so each host wraps this handler and checks `e.defaultPrevented` before
   * running its own Enter/Escape branch.
   */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  /**
   * Build the wire/display prompt text parts from the current value, resolved
   * skill paths, and active command. Throws `Error("Skill '<name>' is missing
   * a path")` when a selected skill has no resolvable path (the canonical
   * `ChatInputBar` Block If — surfaces catch and toast).
   */
  buildPromptParts: () => ChatPromptParts
}

export function useChatComposer(args: UseChatComposerArgs): UseChatComposerResult {
  const {
    value,
    setValue,
    textareaRef,
    slashMenuRef,
    commands,
    configOptions,
    modes,
    skills,
    disabled,
    onSetConfig,
    onSetMode,
    handleMentionKeyDown,
    updateMentions,
    resetHeight,
    clampHeight
  } = args

  const [activeCommand, setActiveCommand] = useState<string | null>(null)
  // name → SKILL.md path, captured when a skill is picked from the slash menu
  // so the wire prompt can cite paths synchronously at send time (no IPC read,
  // no failure path). The composer value carries the inline skill tokens; this
  // ref supplies the path for each token's name when building the wire text.
  const skillPathsRef = useRef<Record<string, string>>({})

  const slashOpen = isSlashTriggerAny(value) && !disabled
  const filter = slashFilter(value)
  const slashSections = useMemo(
    () => (slashOpen ? buildSlashSections({ commands, configOptions, modes, skills, filter }) : []),
    [slashOpen, commands, configOptions, modes, skills, filter]
  )
  // The transparent-textarea overlay is only needed when the value carries a
  // skill token; otherwise keep the textarea text visible so plain typing,
  // overlay first-paint, and any overlay failure never render invisible text.
  const hasSkillToken = value.includes(SKILL_TOKEN_START)

  const handleSelect = useCallback(
    (item: SlashItem) => {
      if (item.kind === 'skill') {
        // Splice an inline skill token at the caret, removing the `/`-filter
        // text the slash menu was filtering on. The token carries the skill
        // name; the path is recorded into `skillPathsRef` so the wire prompt
        // can cite it synchronously at send time. A trailing space is appended
        // so the caret lands in plain text and the next `/` trigger matches.
        const trigger = findSlashTrigger(value)
        const caret = textareaRef.current?.selectionStart ?? value.length
        const insertAt = trigger ? trigger.end : caret
        const deleteBefore = trigger ? trigger.end - trigger.start : 0
        // Measure the FIGURE-SPACE padding needed so the transparent textarea
        // token text is as wide as the `SkillChip` pill the overlay renders over
        // it — without this the caret lands ~6 chars behind the chip. Synchronous
        // canvas measurement; returns '' in jsdom / when no canvas, degrading to
        // the unpadded token.
        const padding = measureSkillPadding(item.name, textareaRef.current)
        const { value: next, caret: nextCaret } = insertSkillToken(
          value,
          insertAt,
          item.name,
          deleteBefore,
          padding
        )
        skillPathsRef.current[item.name] = item.path
        setValue(next)
        updateMentions(next, nextCaret)
        resetHeight()
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (!el) return
          clampHeight(el)
          el.setSelectionRange(nextCaret, nextCaret)
          el.focus()
        })
        return
      }
      if (item.kind === 'command') {
        // Set the command chip instead of inserting bare text into the
        // textarea. If the trigger was mid-text, replace the /token portion in
        // the input.
        const midTrigger = findSlashTrigger(value)
        if (midTrigger && midTrigger.start > 0) {
          // Mid-text trigger: remove the /token from the input, keep the rest
          const before = value.slice(0, midTrigger.start).trimEnd()
          const after = value.slice(midTrigger.end).trimStart()
          const remaining = [before, after].filter(Boolean).join(' ')
          setValue(remaining)
          updateMentions(remaining, remaining.length)
        } else {
          // Leading or standalone trigger: clear the input
          setValue('')
          updateMentions('', 0)
        }
        setActiveCommand(item.name)
        resetHeight()
        textareaRef.current?.focus()
        return
      }
      if (item.kind === 'config') {
        // AgentChatPanel's setters toast then rethrow; swallow here so the
        // already-surfaced failure doesn't become an unhandled rejection.
        void Promise.resolve(onSetConfig(item.configId, item.valueId)).catch(() => {})
      } else {
        void Promise.resolve(onSetMode(item.modeId)).catch(() => {})
      }
      setValue('')
      updateMentions('', 0)
      resetHeight()
    },
    [value, onSetConfig, onSetMode, resetHeight, clampHeight, updateMentions, setValue, textareaRef]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Backspace over an inline skill token (caret immediately after a chip,
      // no active selection): remove the whole token plus the splicer's
      // trailing space. Falls through to the default one-char backspace when
      // the caret is in plain text. Alt is excluded so macOS Option+Backspace
      // (delete-word) doesn't slice a token and leave orphan sentinels.
      if (e.key === 'Backspace' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = e.currentTarget
        const caret = el.selectionStart ?? 0
        const selEnd = el.selectionEnd ?? 0
        if (caret === selEnd) {
          const result = removeSkillTokenBeforeCaret(value, caret)
          if (result.removed) {
            e.preventDefault()
            setValue(result.value)
            updateMentions(result.value, result.caret)
            resetHeight()
            requestAnimationFrame(() => {
              const t = textareaRef.current
              if (!t) return
              clampHeight(t)
              t.setSelectionRange(result.caret, result.caret)
              t.focus()
            })
            return
          }
        }
      }
      if (
        tryHandleSlashMenuKeyDown(e, {
          menuOpen: slashOpen,
          sectionsLength: slashSections.length,
          menuRef: slashMenuRef,
          onClearInput: () => {
            setValue('')
            setActiveCommand(null)
            updateMentions('', 0)
            resetHeight()
          }
        })
      ) {
        return
      }
      if (handleMentionKeyDown(e)) {
        return
      }
      // Enter→submit / Escape→cancel are surface-specific: each host wraps
      // this handler and checks `e.defaultPrevented` before running its own
      // branch (the dispatch shapes — onSend/onSendBlocks vs
      // finalizeChatLaunch/sendPromptBlocks — differ).
    },
    [
      value,
      slashOpen,
      slashSections.length,
      slashMenuRef,
      handleMentionKeyDown,
      updateMentions,
      clampHeight,
      resetHeight,
      setValue,
      textareaRef
    ]
  )

  const clearActiveCommand = useCallback(() => {
    setActiveCommand(null)
    textareaRef.current?.focus()
  }, [textareaRef])

  const buildPromptParts = useCallback((): ChatPromptParts => {
    // Extract the inline skill tokens carried in the value and resolve each
    // name to its SKILL.md path. Paths come from `skillPathsRef` (captured at
    // pick time) first, then fall back to the currently-available skills list
    // — so editing + re-sending a chip message (where the ref is empty
    // because paths aren't persisted with the message) still resolves paths
    // from the live skills list. A skill surfaced without a path in either
    // (e.g. a future web skill with no parity route) blocks the send — HALT
    // with a clear error so the user can remove the chip.
    const skillNames = extractSkillNames(value)
    const resolvedSkills = skillNames.map((name) => ({
      name,
      path: skillPathsRef.current[name] ?? skills.find((s) => s.name === name)?.path ?? ''
    }))
    const missingPath = resolvedSkills.find((s) => !s.path)
    if (missingPath) {
      throw new Error(`Skill '${missingPath.name}' is missing a path`)
    }
    const hasSkills = resolvedSkills.length > 0
    // Wire text dispatched to the agent: skills framed by path under
    // `# Agent Skills`, then the user text with tokens replaced by `(name)`.
    // Always call the framer (it inline-replaces tokens + trims even when
    // there are no framed skills) so a value carrying a token with no matching
    // path entry degrades to `(name)` rather than leaking a private-use
    // sentinel.
    const wireText = buildPromptWithLoadedSkills(resolvedSkills, value)
    // Display text stored in the optimistic user message: the raw token value
    // so the timeline overlay re-renders the chips inline.
    const displayText = value
    // Prepend the active command to both wire and display so the timeline
    // shows `/cmd …` and the agent receives the command-prefixed wire text.
    const wireWithCommand = activeCommand ? `/${activeCommand} ${wireText}` : wireText
    const displayWithCommand = activeCommand ? `/${activeCommand} ${displayText}` : displayText
    return {
      skills: resolvedSkills,
      hasSkills,
      wireText,
      displayText,
      wireWithCommand,
      displayWithCommand,
      wireTrimmed: wireWithCommand.trim(),
      displayTrimmed: displayWithCommand.trim()
    }
  }, [value, skills, activeCommand])

  return {
    slashOpen,
    slashSections,
    activeCommand,
    setActiveCommand,
    clearActiveCommand,
    skillPathsRef,
    hasSkillToken,
    handleSelect,
    handleKeyDown,
    buildPromptParts
  }
}
