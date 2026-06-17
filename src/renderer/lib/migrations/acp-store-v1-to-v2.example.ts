/**
 * Example Migration: ACP Store v1 → v2
 *
 * This is a reference example showing how to write store migrations using the
 * tauri-persistence-api migration system. This specific migration is not used
 * in production (hence .example.ts extension) but serves as a template.
 *
 * ## When to Create a Migration
 *
 * Create a migration whenever you change a store's data structure in a way that
 * would break existing user data:
 *
 * - Renaming fields
 * - Changing field types
 * - Adding required fields
 * - Restructuring nested objects
 * - Changing array item structures
 *
 * ## Migration Workflow
 *
 * 1. Define your migration function (see `migrateAcpStoreV1toV2` below)
 * 2. Register it on app startup (see `registerAcpMigrations` below)
 * 3. Call `runMigrations()` after all migrations are registered
 * 4. Users' data will be automatically migrated on next app launch
 *
 * ## Example Scenario
 *
 * Suppose ACP store v1 stored messages as simple strings:
 *
 * ```typescript
 * interface SessionV1 {
 *   messages: string[]  // ❌ Old format
 * }
 * ```
 *
 * And v2 requires structured ChatMessage objects:
 *
 * ```typescript
 * interface SessionV2 {
 *   messages: ChatMessage[]  // ✅ New format
 * }
 * ```
 *
 * This migration transforms the data structure safely.
 */

import type { IpcResult } from '@shared/types/ipc.types'
import { Store } from '@tauri-apps/plugin-store'
import { type Migration, registerMigration } from '../tauri-persistence-api'

// ==================== Type Definitions ====================

/** Old v1 message format (simple strings) */
interface MessageV1 {
  text: string
}

/** New v2 message format (structured ChatMessage) */
interface ChatMessageV2 {
  id: string
  role: 'user' | 'agent' | 'thought'
  blocks: Array<{ type: 'text'; text: string }>
  streaming: boolean
  timestamp: number
}

/** Old v1 session structure */
interface AcpSessionV1 {
  id: string
  agentId: string
  cwd: string
  messages: MessageV1[]
}

/** New v2 session structure */
interface AcpSessionV2 {
  id: string
  agentId: string
  cwd: string
  messages: ChatMessageV2[]
}

// ==================== Migration Implementation ====================

/**
 * Transform a v1 message (simple object) into a v2 ChatMessage.
 */
function transformMessageV1toV2(msgV1: MessageV1, index: number): ChatMessageV2 {
  return {
    id: `msg-${Date.now()}-${index}`,
    role: 'user', // Default to user role for legacy messages
    blocks: [{ type: 'text', text: msgV1.text }],
    streaming: false,
    timestamp: Date.now()
  }
}

/**
 * Migration function: ACP Store v1 → v2
 *
 * This function:
 * 1. Loads the current v1 data from the store
 * 2. Transforms it to v2 format
 * 3. Writes the transformed data back
 * 4. Returns success/failure
 *
 * @returns IpcResult<void> - Success or failure with error details
 */
export async function migrateAcpStoreV1toV2(): Promise<IpcResult<void>> {
  try {
    // Load the store (same store used by tauri-persistence-api)
    const store = await Store.load('termul-data.json', { autoSave: false })

    // Read the current ACP session data
    const rawData = await store.get<{
      _version: number
      data: Record<string, AcpSessionV1>
    }>('acp-sessions')

    // Handle missing data (fresh install or different key)
    if (!rawData?.data) {
      // No data to migrate - this is fine
      return { success: true, data: undefined }
    }

    // Transform each session from v1 to v2 format
    const sessionsV1 = rawData.data
    const sessionsV2: Record<string, AcpSessionV2> = {}

    for (const [sessionId, sessionV1] of Object.entries(sessionsV1)) {
      sessionsV2[sessionId] = {
        ...sessionV1,
        messages: sessionV1.messages.map((msg, idx) => transformMessageV1toV2(msg, idx))
      }
    }

    // Write the transformed data back to the store
    // Update the versioned data structure
    await store.set('acp-sessions', {
      _version: 2,
      data: sessionsV2
    })

    // Persist to disk
    await store.save()

    return { success: true, data: undefined }
  } catch (err) {
    return {
      success: false,
      error: `Failed to migrate ACP store from v1 to v2: ${String(err)}`,
      code: 'MIGRATION_ERROR'
    }
  }
}

// ==================== Registration ====================

/**
 * Register all ACP store migrations.
 *
 * Call this function during app initialization (e.g., in App.tsx or main.tsx)
 * BEFORE calling runMigrations().
 *
 * Example usage:
 *
 * ```typescript
 * import { registerAcpMigrations } from '@/lib/migrations/acp-store-v1-to-v2.example'
 * import { runMigrations } from '@/lib/tauri-persistence-api'
 *
 * // On app startup:
 * async function initializeApp() {
 *   // 1. Register all migrations
 *   registerAcpMigrations()
 *
 *   // 2. Run migrations (executes any pending migrations)
 *   const result = await runMigrations()
 *
 *   if (!result.success) {
 *     console.error('Migration failed:', result.error)
 *     // Handle migration failure (e.g., show error dialog)
 *   }
 *
 *   // 3. Continue with normal app initialization
 * }
 * ```
 */
export function registerAcpMigrations(): void {
  // Register the v1 → v2 migration
  const v1toV2Migration: Migration = {
    fromVersion: 1,
    toVersion: 2,
    migrate: migrateAcpStoreV1toV2
  }

  const result = registerMigration(v1toV2Migration)

  if (!result.success) {
    console.error('Failed to register ACP migration v1→v2:', result.error)
  }

  // If you have more migrations, register them here:
  //
  // const v2toV3Migration: Migration = {
  //   fromVersion: 2,
  //   toVersion: 3,
  //   migrate: migrateAcpStoreV2toV3
  // }
  // registerMigration(v2toV3Migration)
}

// ==================== Testing Your Migration ====================

/**
 * Testing migrations:
 *
 * 1. Unit test the migration function directly:
 *
 * ```typescript
 * import { describe, it, expect, beforeEach } from 'vitest'
 * import { migrateAcpStoreV1toV2 } from './acp-store-v1-to-v2.example'
 *
 * describe('ACP Store v1→v2 Migration', () => {
 *   it('transforms v1 messages to v2 ChatMessage format', async () => {
 *     // Setup mock store with v1 data
 *     // ...
 *
 *     const result = await migrateAcpStoreV1toV2()
 *
 *     expect(result.success).toBe(true)
 *     // Verify transformed data structure
 *   })
 * })
 * ```
 *
 * 2. Integration test with the migration system:
 *
 * ```typescript
 * import { registerMigration, runMigrations, getCurrentSchemaVersion } from '../tauri-persistence-api'
 *
 * it('migrates ACP store through version chain', async () => {
 *   registerAcpMigrations()
 *
 *   const result = await runMigrations()
 *
 *   expect(result.success).toBe(true)
 *
 *   const version = await getCurrentSchemaVersion()
 *   expect(version.data).toBe(2)
 * })
 * ```
 */
