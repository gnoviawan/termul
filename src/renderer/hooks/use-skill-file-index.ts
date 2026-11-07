import { useEffect, useState } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { skillsApi } from '@/lib/skills-api'

/** Lowercased skill name → absolute `SKILL.md` path. */
export type SkillFileIndex = ReadonlyMap<string, string>

const EMPTY_INDEX: SkillFileIndex = new Map()

/** A fresh index is reused across chips and surfaces; a stale one refetches
 * on the next mount so newly installed skills become clickable. */
const INDEX_TTL_MS = 30_000

interface CacheEntry {
  fetchedAt: number
  index: Promise<SkillFileIndex>
}

const cache = new Map<string, CacheEntry>()

/** Lookup key for a chip name: case-insensitive, like the slash menu. */
export function skillIndexKey(name: string): string {
  return name.trim().toLowerCase()
}

async function fetchIndex(
  projectRoot: string | undefined
): Promise<{ index: SkillFileIndex; ok: boolean }> {
  try {
    const entries = await skillsApi.listSkillFiles(projectRoot)
    const index = new Map<string, string>()
    for (const entry of entries) {
      const key = skillIndexKey(entry.name)
      if (key && !index.has(key)) index.set(key, entry.path)
    }
    return { index, ok: true }
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'useSkillFileIndex',
      message: `Failed to index skill files: ${err instanceof Error ? err.message : String(err)}`
    })
    return { index: EMPTY_INDEX, ok: false }
  }
}

/** Load (or reuse) the skill file index for a project root. */
export function loadSkillFileIndex(projectRoot: string | undefined): Promise<SkillFileIndex> {
  const key = projectRoot ?? ''
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < INDEX_TTL_MS) return cached.index
  // A failed load evicts only its own entry: a newer load may already own the key.
  const index: Promise<SkillFileIndex> = fetchIndex(projectRoot).then((result) => {
    if (!result.ok && cache.get(key)?.index === index) cache.delete(key)
    return result.index
  })
  cache.set(key, { fetchedAt: Date.now(), index })
  return index
}

/** Test-only: forget every cached index. */
export function resetSkillFileIndexCache(): void {
  cache.clear()
}

/**
 * The skill file index for `projectRoot`. Empty until the first load resolves
 * (chips render static until then) and on failure (logged, never thrown).
 */
export function useSkillFileIndex(projectRoot: string | undefined): SkillFileIndex {
  const key = projectRoot ?? ''
  const [loaded, setLoaded] = useState<{ key: string; index: SkillFileIndex } | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadSkillFileIndex(projectRoot).then((index) => {
      if (!cancelled) setLoaded({ key: projectRoot ?? '', index })
    })
    return () => {
      cancelled = true
    }
  }, [projectRoot])

  return loaded?.key === key ? loaded.index : EMPTY_INDEX
}
