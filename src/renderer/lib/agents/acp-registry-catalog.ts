/**
 * ADR-004.6: Renderer-side ACP Registry catalog (identity & discovery only).
 *
 * Wraps the Rust `agent_registry_fetch` command, which performs the opt-in,
 * read-only fetch + disk cache. This module NEVER derives a launch command from
 * the registry — `command`/`baseArgs`/`promptMode` always come from the app-owned
 * launch table (`agent-registry.ts`). Here we only consume identity (name,
 * description, website, icon) for display, and link entries to launch-table
 * definitions via `registryId`.
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauriContext } from '@/lib/tauri-runtime'
import type { IpcResult } from '@shared/types/ipc.types'
import type { TerminalAgentDefinition } from '@/lib/agents/agent-registry'

/** A single agent identity entry from the ACP Registry. */
export interface AcpRegistryEntry {
	id: string
	name: string
	description?: string | null
	website?: string | null
	/** Remote CDN SVG URL (16x16 monochrome `currentColor`). */
	icon?: string | null
}

export interface AcpRegistryCatalog {
	entries: AcpRegistryEntry[]
	/** 'network' | 'cache' | 'empty' — where the entries came from. */
	source: string
	fetchedAt?: string | null
}

const EMPTY_CATALOG: AcpRegistryCatalog = { entries: [], source: 'empty', fetchedAt: null }

/**
 * Fetch the ACP Registry catalog. Opt-in: call this only on explicit user action
 * (e.g. opening "Browse agents"). Returns an empty catalog outside Tauri or on
 * failure so callers can fall back to bundled identities.
 *
 * @param forceRefresh - bypass the disk cache and hit the network.
 */
export async function fetchAcpRegistry(forceRefresh = false): Promise<AcpRegistryCatalog> {
	if (!isTauriContext()) {
		return EMPTY_CATALOG
	}
	try {
		const result = await invoke<IpcResult<AcpRegistryCatalog>>('agent_registry_fetch', {
			forceRefresh,
		})
		if (result.success) {
			return result.data
		}
		return EMPTY_CATALOG
	} catch {
		return EMPTY_CATALOG
	}
}

/** Build an id→entry index for O(1) identity lookup. */
export function indexByRegistryId(
	catalog: AcpRegistryCatalog,
): Map<string, AcpRegistryEntry> {
	return new Map(catalog.entries.map((e) => [e.id, e]))
}

/**
 * Apply registry identity (icon, and optionally name when missing) to a
 * launch-table definition via its `registryId`. The launch command is never
 * touched. Returns a new object; the input is not mutated.
 *
 * Defense-in-depth: the ADR-004.6 contract is that the default experience is
 * offline. A registry entry's `icon` is a remote CDN URL — we must never
 * inject it into a definition that has no bundled icon, because that would
 * silently start a network fetch on every render. We only "borrow" identity
 * when the definition already has something to anchor it.
 */
export function applyRegistryIdentity(
	def: TerminalAgentDefinition,
	index: Map<string, AcpRegistryEntry>,
): TerminalAgentDefinition {
	if (!def.registryId) return def
	const entry = index.get(def.registryId)
	if (!entry) return def
	// Prefer an already-bundled icon. We never promote a remote icon to a
	// bundleless def — the default experience stays offline.
	if (!def.icon) return def
	return { ...def, icon: def.icon }
}
