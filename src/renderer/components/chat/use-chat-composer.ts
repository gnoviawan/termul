import type { Editor } from '@tiptap/core'
import type { MutableRefObject, RefObject } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { buildPromptWithLoadedSkills } from '@/hooks/use-agent-skills'
import type { AvailableCommand, SessionConfigOption, SessionModeState } from '@/lib/acp-api'
import { docOffsetToDisplayOffset, SKILL_PAD_DEFAULT } from '@/lib/composer/doc-to-prompt'
import { extractSkillNames, insertSkillToken, SKILL_TOKEN_START } from '@/lib/skill-tokens'
import type { AgentSkillSummary } from '@/lib/skills-api'
import { tryHandleMentionMenuKeyDown } from './mention-menu-keyboard'
import type { SlashMenuHandle } from './SlashCommandMenu'
import type { ComposerKeyboardEvent } from './slash-menu-keyboard'
import { tryHandleSlashMenuKeyDown } from './slash-menu-keyboard'
import {
  buildSlashSections,
  findSlashTrigger,
  isSlashTriggerAny,
  type SlashItem,
  type SlashSection,
  slashFilter
} from './slash-menu-model'
import type { ComposerMentions } from './use-composer-mentions'

/**
 * Shared chat-composer state + handlers for the two composer hosts
 * (`ChatInputBar` — the running chatbox — and `AgentLauncher` — the new-chat
 * screen). This is a LOGIC extraction, not a JSX extraction: the two surfaces
 * keep their own outer chrome (BorderBeam/queue vs agent picker/banners), but
 * route the duplicated composer-field logic — slash menu, skill-pill splice,
 * command chip, submit text builder — through this hook so they cannot drift
 * again.
 *
 * The hook is renderer-neutral: no Tauri/runtime calls, no JSX. Both surfaces
 * keep their own `submit()`/`launch()` because the dispatch shapes differ
 * (`onSend`/`onSendBlocks` vs `finalizeChatLaunch`/`sendPromptBlocks`), but both
 * read `activeCommand` + `skillPathsRef` + `buildPromptParts()` from the hook
 * to build the wire/display text identically.
 *
 * ## Editor integration (modular redesign)
 *
 * The transparent-`<textarea>` + `SkillComposerOverlay` surface is replaced by a
 * Tiptap rich-text editor (`ChatComposerEditor`). The pill is now a real inline
 * DOM node (a Tiptap `NodeView`), so the caret sits flush against the pill by
 * construction — no canvas-based figure-space padding (`measureSkillPadding` is
 * deleted) and no overlay scroll-sync (`SkillComposerOverlay` is deleted). The
 * `value` string (sentinel-token format) stays the single source of truth
 * shared with `buildPromptParts`, draft persistence, and the timeline renderer,
 * so the wire payload stays byte-identical to the pre-refactor surface.
 *
 * The hook owns: `activeCommand`, `skillPathsRef`, slash-menu open/sections,
 * `handleSelect` (skill splice + command chip + config/mode apply),
 * `buildPromptParts` (wire/display text builder), and the slash/mention menu
 * keymap adapter (`onSlashOrMentionKeyDown`) that the editor runs BEFORE its
 * own keymap. Backspace-over-pill removal is owned by the editor itself.
 */
export interface UseChatComposerArgs {
  value: string
  setValue: (v: string) => void
  /** The Tiptap editor instance (drives transactional pill insertion + caret
   * restoration after a programmatic string splice). */
  editorRef: MutableRefObject<Editor | null>
  slashMenuRef: RefObject<SlashMenuHandle | null>
  commands: AvailableCommand[]
  configOptions: SessionConfigOption[]
  modes: SessionModeState | null
  skills: AgentSkillSummary[]
  disabled: boolean
  onSetConfig: (configId: string, valueId: string) => void | Promise<void>
  onSetMode: (modeId: string) => void | Promise<void>
  /** Reserved for model-row parity (the model chip routes native ACP models
   * through `onSetModel` when `modelSource === 'models'`). Slash-menu model
   * rows currently flow through the `config` branch → `onSetConfig`, matching
   * the canonical `ChatInputBar` behavior; these fields are kept on the
   * interface so a future model-row divergence can land without reshaping it. */
  onSetModel?: (modelId: string) => void | Promise<void>
  modelOption?: SessionConfigOption | null
  modelSource?: 'models' | 'config'
  /** Mention-menu state from `useComposerMentions`. The hook calls
   * `mentions.update` after programmatic splices (the editor's live
   * `onCaretChange` feeds it on natural typing). */
  mentions: ComposerMentions
  /**
   * Schedule a caret restore (display-string offset → doc pos) after a
   * programmatic value splice, with rAF cleanup. Provided by the host's
   * `useComposerCaretRestore(editorRef)` so the hook's `handleSelect` + the
   * host's `onMentionSelect`/seed share ONE rAF ref per editor instance.
   */
  scheduleRestoreCaret: (displayOffset: number) => void
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
   * Slash + mention menu keymap adapter for the editor. Runs `tryHandleSlashMenuKeyDown`
   * then `tryHandleMentionMenuKeyDown` (both consume ↑/↓/Tab/Enter/Escape when
   * their menu is open). The editor calls this BEFORE its own keymap so menu
   * keys never reach ProseMirror's base handlers. Returns true when consumed
   * (the editor skips its default handling for that key).
   */
  onSlashOrMentionKeyDown: (event: KeyboardEvent) => boolean
  /**
   * Build the wire/display prompt text parts from the current value, resolved
   * skill paths, and active command. Throws `Error("Skill '<name>' is missing
   * a path")` when a selected skill has no resolvable path (the canonical
   * `ChatInputBar` Block If — surfaces catch and toast).
   */
  buildPromptParts: () => ChatPromptParts
}

/**
 * Adapter: shape a DOM `KeyboardEvent` to the {@link ComposerKeyboardEvent}
 * contract the slash/mention menu keyboard helpers expect. The DOM event
 * already carries `key`/`shiftKey`/`metaKey`/`ctrlKey`/`altKey`/`isComposing`
 * (via `nativeEvent`); we expose `nativeEvent` as the DOM event itself so
 * `.nativeEvent.isComposing` reads the real composing flag, and
 * `target`/`currentTarget` as the editor's contenteditable element so future
 * helpers can reach the editor without a contenteditable-lacking
 * `selectionStart` lying about the caret. Properly typed — no `as unknown as`
 * escape hatch.
 */
function adaptDomKeybEvent(
  domEvent: KeyboardEvent,
  editorEl: HTMLElement | null
): ComposerKeyboardEvent {
  return {
    key: domEvent.key,
    shiftKey: domEvent.shiftKey,
    metaKey: domEvent.metaKey,
    ctrlKey: domEvent.ctrlKey,
    altKey: domEvent.altKey,
    target: domEvent.target as HTMLElement | null,
    currentTarget: editorEl,
    nativeEvent: domEvent,
    preventDefault: () => domEvent.preventDefault(),
    stopPropagation: () => domEvent.stopPropagation(),
    get defaultPrevented() {
      return domEvent.defaultPrevented
    }
  }
}

export function useChatComposer(args: UseChatComposerArgs): UseChatComposerResult {
  const {
    value,
    setValue,
    editorRef,
    slashMenuRef,
    commands,
    configOptions,
    modes,
    skills,
    disabled,
    onSetConfig,
    onSetMode,
    mentions,
    scheduleRestoreCaret
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
  // Pills are real DOM nodes now, so there is no transparent-text overlay to
  // gate. `hasSkillToken` is still exposed for hosts that branch on whether the
  // value carries a skill (e.g. placeholder copy).
  const hasSkillToken = value.includes(SKILL_TOKEN_START)

  const handleSelect = useCallback(
    (item: SlashItem) => {
      if (item.kind === 'skill') {
        // Splice an inline skill token into the display string at the caret,
        // removing the `/`-filter text the slash menu was filtering on. The
        // token carries the skill name + the fixed padding block
        // (`\uE002<SKILL_PAD_DEFAULT>\uE003`) — the padding is obsolete for
        // display (the pill is a real DOM node), but it's re-emitted by
        // `docToDisplayText` to preserve the on-disk draft schema, so the
        // splice must include it for offset consistency (the caret offset from
        // `insertSkillToken` accounts for the padding block's length). The path
        // is recorded into `skillPathsRef` so the wire prompt can cite it
        // synchronously at send time. A trailing space is appended so the
        // caret lands in plain text and the next `/` trigger matches.
        const trigger = findSlashTrigger(value)
        const editor = editorRef.current
        const caret = editor ? stringCaretFromEditor(editor) : trigger ? trigger.end : value.length
        const insertAt = trigger ? trigger.end : caret
        const deleteBefore = trigger ? trigger.end - trigger.start : 0
        const { value: next, caret: nextCaret } = insertSkillToken(
          value,
          insertAt,
          item.name,
          deleteBefore,
          SKILL_PAD_DEFAULT
        )
        skillPathsRef.current[item.name] = item.path
        setValue(next)
        mentions.update(next, nextCaret)
        // Restore the caret to the post-pill offset (flush against the pill's
        // right edge — the pill is a real DOM node, so no gap). rAF defers past
        // React's commit + the editor's external-value re-parse; the shared
        // `scheduleRestoreCaret` cancels any pending frame + no-ops if the
        // editor was destroyed before the frame fired (no swallowed throws).
        scheduleRestoreCaret(nextCaret)
        return
      }
      if (item.kind === 'command') {
        // Set the command chip instead of inserting bare text into the
        // editor. If the trigger was mid-text, replace the /token portion in
        // the input.
        const midTrigger = findSlashTrigger(value)
        if (midTrigger && midTrigger.start > 0) {
          const before = value.slice(0, midTrigger.start).trimEnd()
          const after = value.slice(midTrigger.end).trimStart()
          const remaining = [before, after].filter(Boolean).join(' ')
          setValue(remaining)
          mentions.update(remaining, remaining.length)
        } else {
          setValue('')
          mentions.update('', 0)
        }
        setActiveCommand(item.name)
        editorRef.current?.commands.focus()
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
      mentions.update('', 0)
    },
    [value, onSetConfig, onSetMode, setValue, editorRef, mentions, scheduleRestoreCaret]
  )

  const onSlashOrMentionKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      const editorEl = editorRef.current?.view.dom ?? null
      const reactLike = adaptDomKeybEvent(event, editorEl)
      if (
        tryHandleSlashMenuKeyDown(reactLike, {
          menuOpen: slashOpen,
          sectionsLength: slashSections.length,
          menuRef: slashMenuRef,
          onClearInput: () => {
            setValue('')
            setActiveCommand(null)
            mentions.update('', 0)
          }
        })
      ) {
        return true
      }
      if (
        tryHandleMentionMenuKeyDown(reactLike, {
          menuOpen: mentions.menuOpen && !disabled && !slashOpen,
          sectionsLength: mentions.sections.length,
          menuRef: mentions.menuRef,
          onReset: mentions.reset
        })
      ) {
        return true
      }
      return false
    },
    [slashOpen, slashSections.length, slashMenuRef, mentions, disabled, setValue, editorRef]
  )

  const clearActiveCommand = useCallback(() => {
    setActiveCommand(null)
    editorRef.current?.commands.focus()
  }, [editorRef])

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
    const wireText = buildPromptWithLoadedSkills(resolvedSkills, value)
    const displayText = value
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
    onSlashOrMentionKeyDown,
    buildPromptParts
  }
}

/**
 * Read the current string-caret (display-string offset) from the editor's live
 * selection. Used by `handleSelect` to splice a skill token at the caret when
 * the slash menu had no leading `/`-trigger to anchor on (e.g. the trigger is
 * mid-text and the caret sits at the filter boundary).
 */
function stringCaretFromEditor(editor: Editor): number {
  return docOffsetToDisplayOffset(editor.state.doc, editor.state.selection.to)
}
