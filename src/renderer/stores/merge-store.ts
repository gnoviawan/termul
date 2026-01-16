/**
 * Merge Store
 *
 * State management for merge operations including conflict detection,
 * merge preferences, merge preview, and merge workflow state.
 * Source: Story 2.2 - Conflict Detection UI, Story 2.3 - Merge Preview UI
 */

import { create } from 'zustand'
import type {
  DetectionMode,
  ConflictDetectionResult,
  MergePreference,
  MergePreview,
  FileChange,
  ConflictedFile
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

  // Preview state (Story 2.3)
  mergePreview: MergePreview | null
  isLoadingPreview: boolean
  previewError: string | null
  showConflictsOnly: boolean
  selectedFile: FileChange | ConflictedFile | null
  isDiffOpen: boolean

  // Actions
  setDetectionMode: (mode: DetectionMode) => void
  detectConflicts: (projectId: string, sourceBranch: string, targetBranch: string) => Promise<void>
  loadPreference: () => Promise<void>
  savePreference: (mode: DetectionMode) => Promise<void>
  clearResults: () => void
  clearError: () => void

  // Preview actions (Story 2.3)
  getMergePreview: (projectId: string, sourceBranch: string, targetBranch: string) => Promise<void>
  setShowConflictsOnly: (show: boolean) => void
  setSelectedFile: (file: FileChange | ConflictedFile | null) => void
  openDiff: () => void
  closeDiff: () => void
  clearPreview: () => void
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

  // Preview initial state (Story 2.3)
  mergePreview: null,
  isLoadingPreview: false,
  previewError: null,
  showConflictsOnly: false,
  selectedFile: null,
  isDiffOpen: false,

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
  },

  // Get merge preview (Story 2.3)
  getMergePreview: async (projectId: string, sourceBranch: string, targetBranch: string) => {
    set({ isLoadingPreview: true, previewError: null })

    try {
      const result = await window.api.merge.getPreview({
        projectId,
        sourceBranch,
        targetBranch
      })

      if (result.success) {
        set({ mergePreview: result.data, isLoadingPreview: false })
      } else {
        set({ previewError: result.error || 'Preview generation failed', isLoadingPreview: false })
      }
    } catch (error) {
      set({ previewError: String(error), isLoadingPreview: false })
    }
  },

  // Show conflicts only toggle (Story 2.3)
  setShowConflictsOnly: (show: boolean) => {
    set({ showConflictsOnly: show })
  },

  // Set selected file for diff preview (Story 2.3)
  setSelectedFile: (file: FileChange | ConflictedFile | null) => {
    set({ selectedFile: file })
  },

  // Open diff preview (Story 2.3)
  openDiff: () => {
    set({ isDiffOpen: true })
  },

  // Close diff preview (Story 2.3)
  closeDiff: () => {
    set({ isDiffOpen: false, selectedFile: null })
  },

  // Clear preview state (Story 2.3)
  clearPreview: () => {
    set({
      mergePreview: null,
      isLoadingPreview: false,
      previewError: null,
      showConflictsOnly: false,
      selectedFile: null,
      isDiffOpen: false
    })
  }
}))

// Selectors for optimized re-renders
export const useDetectionMode = () => useMergeStore((state) => state.detectionMode)
export const useDetectionResult = () => useMergeStore((state) => state.detectionResult)
export const useIsDetecting = () => useMergeStore((state) => state.isDetecting)
export const useDetectionError = () => useMergeStore((state) => state.detectionError)
export const usePreferenceLoaded = () => useMergeStore((state) => state.preferenceLoaded)

// Preview selectors (Story 2.3)
export const useMergePreview = () => useMergeStore((state) => state.mergePreview)
export const useIsLoadingPreview = () => useMergeStore((state) => state.isLoadingPreview)
export const usePreviewError = () => useMergeStore((state) => state.previewError)
export const useShowConflictsOnly = () => useMergeStore((state) => state.showConflictsOnly)
export const useSelectedFile = () => useMergeStore((state) => state.selectedFile)
export const useIsDiffOpen = () => useMergeStore((state) => state.isDiffOpen)

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
  clearError: state.clearError,
  getMergePreview: state.getMergePreview,
  setShowConflictsOnly: state.setShowConflictsOnly,
  setSelectedFile: state.setSelectedFile,
  openDiff: state.openDiff,
  closeDiff: state.closeDiff,
  clearPreview: state.clearPreview
}))
