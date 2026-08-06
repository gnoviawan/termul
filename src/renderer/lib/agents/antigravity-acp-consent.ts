import { PersistenceKeys } from '@shared/types/persistence.types'
import { ANTIGRAVITY_ACP_ID, ANTIGRAVITY_ACP_RELEASE } from '@/lib/agents/antigravity-acp'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'

export const ANTIGRAVITY_ACP_ACKNOWLEDGEMENT_VERSION = `${ANTIGRAVITY_ACP_ID}:${ANTIGRAVITY_ACP_RELEASE}:terms-warning-v1`

interface AntigravityAcpAcknowledgement {
  version: string
}

export async function hasAntigravityAcpAcknowledgement(): Promise<boolean> {
  try {
    const result = await persistenceApi.read<AntigravityAcpAcknowledgement>(
      PersistenceKeys.antigravityAcpAcknowledgement
    )
    if (!result.success) {
      if (result.code !== 'KEY_NOT_FOUND') {
        void logFrontendError({
          level: 'warn',
          source: 'acp.antigravity.acknowledgement.read',
          message: result.error
        })
      }
      return false
    }
    return result.data?.version === ANTIGRAVITY_ACP_ACKNOWLEDGEMENT_VERSION
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'acp.antigravity.acknowledgement.read',
      message: String(error)
    })
    return false
  }
}

export async function saveAntigravityAcpAcknowledgement(): Promise<void> {
  try {
    const result = await persistenceApi.write<AntigravityAcpAcknowledgement>(
      PersistenceKeys.antigravityAcpAcknowledgement,
      { version: ANTIGRAVITY_ACP_ACKNOWLEDGEMENT_VERSION }
    )
    if (!result.success) {
      throw new Error(result.error)
    }
  } catch (error) {
    void logFrontendError({
      level: 'error',
      source: 'acp.antigravity.acknowledgement.write',
      message: String(error)
    })
    throw error
  }
}
