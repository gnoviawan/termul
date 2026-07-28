import type { FormEvent, KeyboardEvent, RefObject, SyntheticEvent } from 'react'
import { useCallback } from 'react'
import type { FileMentionMenuHandle } from './FileMentionMenu'
import { tryHandleMentionMenuKeyDown } from './mention-menu-keyboard'
import type { MentionMatch, MentionSection } from './mention-menu-model'
import type { ComposerMentions } from './use-composer-mentions'

export interface UseComposerTextareaOptions {
  value: string
  setValue: (v: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  mentions: ComposerMentions
  /** Clamp ceiling for the auto-grow height in px (default 160). */
  maxHeight?: number
  disabled?: boolean
  /** Suppress the mention menu when another menu (slash) is open. */
  slashOpen?: boolean
}

export interface ComposerTextarea {
  /** Bound to the textarea `onChange` — syncs value, auto-grows, updates mentions. */
  onInput: (e: FormEvent<HTMLTextAreaElement>) => void
  /** Bound to `onKeyUp` — keeps the @token filter synced with caret moves. */
  onKeyUp: (e: SyntheticEvent<HTMLTextAreaElement>) => void
  /** Bound to `onSelect` — selection changes move the caret, same as onKeyUp. */
  onSelect: (e: SyntheticEvent<HTMLTextAreaElement>) => void
  /** Pick a mention match: splices the @token, stages the file-ref, restores caret. */
  onMentionSelect: (match: MentionMatch) => void
  /** Handle mention-menu arrow/enter/escape; returns true when the event was consumed. */
  handleMentionKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  mentionMenuOpen: boolean
  mentionSections: MentionSection[]
  mentionMenuRef: RefObject<FileMentionMenuHandle>
  emptyLabel: string
  resetMentions: () => void
  /** Collapse the textarea height to its auto baseline (call on clear/send). */
  resetHeight: () => void
  /** Apply the auto-grow clamp to an element (after programmatic value changes). */
  clampHeight: (el: HTMLTextAreaElement) => void
  /** Forwarded `mentions.update` for callers that set the value outside the textarea. */
  updateMentions: (value: string, caret: number) => void
}

/**
 * Shared textarea + mention-menu wiring for the two composer hosts
 * (`ChatInputBar` and `AgentLauncher`). Owns value sync, auto-grow height,
 * caret-synced mention filtering, mention selection, and mention-menu keyboard
 * dispatch so the two hosts cannot drift.
 */
export function useComposerTextarea(opts: UseComposerTextareaOptions): ComposerTextarea {
  const {
    value,
    setValue,
    textareaRef,
    mentions,
    maxHeight = 160,
    disabled = false,
    slashOpen = false
  } = opts
  const {
    select: selectMention,
    update: updateMentions,
    reset: resetMentions,
    menuOpen,
    sections,
    menuRef,
    loading
  } = mentions

  const clampHeight = useCallback(
    (el: HTMLTextAreaElement) => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    },
    [maxHeight]
  )

  const resetHeight = useCallback(() => {
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [textareaRef])

  const onInput = useCallback(
    (e: FormEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget
      setValue(el.value)
      clampHeight(el)
      updateMentions(el.value, el.selectionStart ?? el.value.length)
    },
    [setValue, clampHeight, updateMentions]
  )

  const onKeyUp = useCallback(
    (e: SyntheticEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget
      updateMentions(el.value, el.selectionStart ?? el.value.length)
    },
    [updateMentions]
  )
  const onSelect = onKeyUp

  const onMentionSelect = useCallback(
    (match: MentionMatch) => {
      const el = textareaRef.current
      const currentValue = el?.value ?? value
      const caret = el?.selectionStart ?? currentValue.length
      const outcome = selectMention(currentValue, caret, match)
      if (!outcome) return
      setValue(outcome.value)
      resetHeight()
      requestAnimationFrame(() => {
        const t = textareaRef.current
        if (!t) return
        clampHeight(t)
        t.setSelectionRange(outcome.caret, outcome.caret)
        t.focus()
        updateMentions(outcome.value, outcome.caret)
      })
    },
    [textareaRef, value, setValue, selectMention, resetHeight, clampHeight, updateMentions]
  )

  const mentionMenuOpen = menuOpen && !disabled && !slashOpen

  const handleMentionKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) =>
      tryHandleMentionMenuKeyDown(e, {
        menuOpen: mentionMenuOpen,
        sectionsLength: sections.length,
        menuRef,
        onReset: resetMentions
      }),
    [mentionMenuOpen, sections.length, menuRef, resetMentions]
  )

  const emptyLabel = loading ? 'Searching files…' : 'No matching files.'

  return {
    onInput,
    onKeyUp,
    onSelect,
    onMentionSelect,
    handleMentionKeyDown,
    mentionMenuOpen,
    mentionSections: sections,
    mentionMenuRef: menuRef,
    emptyLabel,
    resetMentions,
    resetHeight,
    clampHeight,
    updateMentions
  }
}
