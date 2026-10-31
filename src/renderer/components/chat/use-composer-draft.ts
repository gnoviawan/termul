import { PersistenceKeys } from '@shared/types/persistence.types'
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react'
import { persistenceApi } from '@/lib/api'

/** Drafts handed to a chat before its composer mounts, by draft key (see {@link seedComposerDraft}). */
const draftSeeds = new Map<string, string>()

/**
 * Put an editable, unsent draft into a chat's composer (a GitHub Start card).
 * It is persisted like a typed draft, and also held in memory so a composer
 * that mounts or re-keys before the write lands still opens with it.
 */
export function seedComposerDraft(projectId: string, sessionId: string, text: string): void {
  const key = PersistenceKeys.chatDraft(projectId, sessionId)
  draftSeeds.set(key, text)
  void persistenceApi.write(key, text).catch(() => {})
}

interface UseComposerDraftArgs {
  projectId: string | null | undefined
  sessionId: string | null | undefined
  /** Set while editing/seeding a message: the seed wins over a stale draft. */
  seedNonce: number | undefined
}

/**
 * The composer's text state plus its per-session persisted draft. Moved verbatim
 * out of `ChatInputBar`; returns the same `[value, setValue]` pair `useState`
 * would.
 */
export function useComposerDraft({
  projectId,
  sessionId,
  seedNonce
}: UseComposerDraftArgs): [string, Dispatch<SetStateAction<string>>] {
  const [value, setValue] = useState('')
  // Persist the in-progress composer draft per session (project + session id)
  // so an unsent message survives a web reload. useState stays the source of
  // truth; the persisted copy is a recovery fallback only — hydrate on mount,
  // debounce writes on change, and clear (delete) when the composer empties
  // (covers both manual clear and clear-on-send). External seeding (editing a
  // message) takes precedence over a stale draft.
  const draftKey = PersistenceKeys.chatDraft(String(projectId), String(sessionId))
  // Guard against undefined/null ids collapsing the key to
  // `chat-draft/undefined/undefined` and cross-session drafts colliding.
  const canPersistDraft = projectId != null && sessionId != null
  const hydratedRef = useRef(false)
  // A seeded draft counts as hydrated only once it renders: until then `value`
  // is the previous text, and writing that would delete the persisted seed.
  const pendingSeedRef = useRef<string | null>(null)
  useEffect(() => {
    pendingSeedRef.current = null
    if (seedNonce !== undefined) {
      // Editing/seeding a message — don't restore a stale draft over the seed.
      hydratedRef.current = true
      return
    }
    if (!canPersistDraft) {
      // projectId/sessionId missing — can't key a draft; treat as hydrated so
      // the write effect's hydration gate doesn't block (it also guards).
      hydratedRef.current = true
      return
    }
    const seeded = draftSeeds.get(draftKey)
    if (seeded !== undefined) {
      draftSeeds.delete(draftKey)
      hydratedRef.current = false
      pendingSeedRef.current = seeded
      setValue(seeded)
      return
    }
    let cancelled = false
    hydratedRef.current = false
    void persistenceApi
      .read<string>(draftKey)
      .then((result) => {
        if (cancelled) return
        if (result.success && typeof result.data === 'string' && result.data) {
          setValue(result.data)
        }
      })
      .catch(() => {
        // Storage unavailable/corrupt — degrade to empty (no UI crash).
      })
      .finally(() => {
        if (!cancelled) hydratedRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [draftKey, seedNonce, canPersistDraft])

  // Debounced draft write on change — only after hydration so the just-loaded
  // draft isn't clobbered with '' before the read resolves. Empty value
  // clears the persisted draft so a reload after send/empty stays clean.
  // While editing/seeding a message (seedNonce set), skip persistence so the
  // seeded text isn't leaked back as the session's draft (reload would restore
  // the edited message into the composer).
  useEffect(() => {
    if (seedNonce !== undefined) return
    if (!canPersistDraft) return
    if (!hydratedRef.current) {
      if (pendingSeedRef.current === null || value !== pendingSeedRef.current) return
      pendingSeedRef.current = null
      hydratedRef.current = true
    }
    if (!value) {
      void persistenceApi.delete(draftKey).catch(() => {})
      return
    }
    const handle = setTimeout(() => {
      void persistenceApi.writeDebounced(draftKey, value).catch(() => {})
    }, 400)
    return () => clearTimeout(handle)
  }, [value, draftKey, seedNonce, canPersistDraft])

  // Flush the latest draft on unmount only (AskUserQuestion replaces the
  // composer). Keep a ref so we do not defeat the debounce on every keystroke.
  const draftValueRef = useRef(value)
  draftValueRef.current = value
  useEffect(() => {
    return () => {
      if (seedNonce !== undefined) return
      if (!canPersistDraft) return
      const latest = draftValueRef.current
      if (!latest) return
      void persistenceApi.write(draftKey, latest).catch(() => {})
    }
  }, [draftKey, seedNonce, canPersistDraft])

  return [value, setValue]
}
