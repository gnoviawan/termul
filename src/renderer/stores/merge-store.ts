/**
 * Merge Store
 *
 * State management for merge operations including conflict detection,
 * merge preferences, and merge workflow state.
 * Source: Story 2.2 - Conflict Detection UI (Accurate vs Fast modes)
 */

import { create } from 'zustand'
import type {
  DetectionMode,
  ConflictDetectionResult,
  MergePreference
} from '@/shared/types/merge.types'

/**
 * Merge store state and actions
 */
interface MergeStore {
  // State
  detectionMode: DetectionMode
  detectionResult: ConflictDetectionResult | null
  isDetecting: boolean
  detectionError: string | null
  preferenceLoaded: boolean

  // Actions
  setDetectionMode: (mode: DetectionMode) => void
  detectConflicts: (projectId: string, sourceBranch: string, targetBranch: string) => Promise<void>
  loadPreference: () => Promise<void>
  savePreference: (mode: DetectionMode) => Promise<void>
  clearResults: () => void
  clearError: () => void
}

/**
 * Merge store using Zustand
 * Default detection mode is "accurate" for first-time users (FR10, AC8)
 */
export const useMergeStore = create<MergeStore>((set, get) => ({
  // Initial state
  detectionMode: 'accurate', // Default for first-time users
  detectionResult: null,
  isDetecting: false,
  detectionError: null,
  preferenceLoaded: false,

  // Set detection mode
  setDetectionMode: (mode: DetectionMode) => {
    set({ detectionMode: mode })
    // Auto-save preference when mode changes
    get().savePreference(mode)
  },

  // Detect conflicts using selected mode
  detectConflicts: async (projectId: string, sourceBranch: string, targetBranch: string) => {
    set({ isDetecting: true, detectionError: null })

    try {
      const result = await window.api.merge.detectConflicts({
        projectId,
        sourceBranch,
        targetBranch,
        mode: get().detectionMode
      })

      if (result.success) {
        set({ detectionResult: result.data, isDetecting: false })
      } else {
        set({ detectionError: result.error || 'Detection failed', isDetecting: false })
      }
    } catch (error) {
      set({ detectionError: String(error), isDetecting: false })
    }
  },

  // Load saved preference from IPC
  loadPreference: async () => {
    try {
      const result = await window.api.merge.getPreference()
      if (result.success && result.data) {
        set({ detectionMode: result.data.detectionMode, preferenceLoaded: true })
      } else {
        // Use default if no preference saved
        set({ preferenceLoaded: true })
      }
    } catch (error) {
      console.error('[MergeStore] Failed to load preference:', error)
      set({ preferenceLoaded: true })
    }
  },

  // Save preference to IPC
  savePreference: async (mode: DetectionMode) => {
    try {
      await window.api.merge.setPreference({
        detectionMode: mode
      })
    } catch (error) {
      console.error('[MergeStore] Failed to save preference:', error)
    }
  },

  // Clear detection results
  clearResults: () => {
    set({ detectionResult: null, detectionError: null })
  },

  // Clear error state
  clearError: () => {
    set({ detectionError: null })
  }
}))

// Selectors for optimized re-renders
export const useDetectionMode = () => useMergeStore((state) => state.detectionMode)
export const useDetectionResult = () => useMergeStore((state) => state.detectionResult)
export const useIsDetecting = () => useMergeStore((state) => state.isDetecting)
export const useDetectionError = () => useMergeStore((state) => state.detectionError)
export const usePreferenceLoaded = () => useMergeStore((state) => state.preferenceLoaded)

// Combined selectors
export const useDetectionState = () => useMergeStore((state) => ({
  isDetecting: state.isDetecting,
  result: state.detectionResult,
  error: state.detectionError
}))

// Actions selector
export const useMergeActions = () => useMergeStore((state) => ({
  setDetectionMode: state.setDetectionMode,
  detectConflicts: state.detectConflicts,
  loadPreference: state.loadPreference,
  clearResults: state.clearResults,
  clearError: state.clearError
}))
