/**
 * Merge Store
 *
 * State management for merge operations including conflict detection,
 * merge preferences, merge preview, and merge workflow state.
 * Source: Story 2.2 - Conflict Detection UI, Story 2.3 - Merge Preview UI, Story 2.4 - Merge Workflow
 */

// External dependencies
import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'

// Type imports
import type {
  ConflictDetectionResult,
  ConflictedFile,
  DetectionMode,
  FileChange,
  MergePreference,
  MergePreview,
  MergeResult
} from '@/shared/types/merge.types'

/**
 * Workflow state for merge process
 */
export type WorkflowState = 'idle' | 'select-branch' | 'detect-conflicts' | 'preview' | 'validate' | 'execute' | 'complete'

/**
 * Merge execution step for progress tracking (Story 2.6)
 */
export type MergeStep = 'idle' | 'preparing' | 'merging' | 'finalizing' | 'complete' | 'error'

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

  // Workflow state (Story 2.4)
  workflowState: WorkflowState
  sourceBranch: string
  targetBranch: string
  mergeResult: MergeResult | null
  isMerging: boolean
  mergeError: string | null
  worktreeId: string | null
  projectId: string | null

  // Merge progress state (Story 2.6)
  mergeProgress: number
  mergeStep: MergeStep

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

  // Workflow actions (Story 2.4)
  setWorkflowState: (state: WorkflowState) => void
  setBranches: (source: string, target: string) => void
  setWorktreeContext: (worktreeId: string, projectId: string) => void
  executeMerge: () => Promise<void>
  resetWorkflow: () => void

  // Merge progress actions (Story 2.6)
  setMergeProgress: (progress: number) => void
  setMergeStep: (step: MergeStep) => void
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

  // Workflow initial state (Story 2.4)
  workflowState: 'idle',
  sourceBranch: '',
  targetBranch: '',
  mergeResult: null,
  isMerging: false,
  mergeError: null,
  worktreeId: null,
  projectId: null,

  // Merge progress initial state (Story 2.6)
  mergeProgress: 0,
  mergeStep: 'idle',

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
  },

  // Set workflow state (Story 2.4)
  setWorkflowState: (state: WorkflowState) => {
    set({ workflowState: state })
  },

  // Set branches for merge (Story 2.4)
  setBranches: (source: string, target: string) => {
    set({ sourceBranch: source, targetBranch: target })
  },

  // Set worktree context (Story 2.4)
  setWorktreeContext: (worktreeId: string, projectId: string) => {
    set({ worktreeId, projectId })
  },

  // Execute merge (Story 2.4)
  executeMerge: async () => {
    const { projectId, sourceBranch, targetBranch } = get()
    if (!projectId || !sourceBranch || !targetBranch) {
      set({ mergeError: 'Missing required context for merge', isMerging: false })
      return
    }

    set({ isMerging: true, mergeError: null })

    try {
      const result = await window.api.merge.execute({
        projectId,
        sourceBranch,
        targetBranch
      })

      if (result.success && result.data) {
        set({ mergeResult: result.data, isMerging: false, workflowState: 'complete' })
      } else {
        set({ mergeError: result.error || 'Merge failed', isMerging: false })
      }
    } catch (error) {
      set({ mergeError: String(error), isMerging: false })
    }
  },

  // Reset workflow state (Story 2.4)
  resetWorkflow: () => {
    set({
      workflowState: 'idle',
      sourceBranch: '',
      targetBranch: '',
      mergeResult: null,
      isMerging: false,
      mergeError: null,
      worktreeId: null,
      projectId: null,
      mergeProgress: 0,
      mergeStep: 'idle'
    })
  },

  // Set merge progress (Story 2.6)
  setMergeProgress: (progress: number) => {
    set({ mergeProgress: Math.max(0, Math.min(100, progress)) })
  },

  // Set merge step (Story 2.6)
  setMergeStep: (step: MergeStep) => {
    set({ mergeStep: step })
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

// Workflow selectors (Story 2.4)
export const useWorkflowState = () => useMergeStore((state) => state.workflowState)
export const useSourceBranch = () => useMergeStore((state) => state.sourceBranch)
export const useTargetBranch = () => useMergeStore((state) => state.targetBranch)
export const useIsMerging = () => useMergeStore((state) => state.isMerging)
export const useMergeError = () => useMergeStore((state) => state.mergeError)
export const useMergeResult = () => useMergeStore((state) => state.mergeResult)

// Merge progress selectors (Story 2.6)
export const useMergeProgress = () => useMergeStore((state) => state.mergeProgress)
export const useMergeStep = () => useMergeStore((state) => state.mergeStep)

// Combined selectors
export const useDetectionState = () => useMergeStore(
  useShallow((state) => ({
    isDetecting: state.isDetecting,
    result: state.detectionResult,
    error: state.detectionError
  }))
)

// Actions selector
/**
 * Hook to access all merge store actions with stable references.
 * Uses shallow equality to prevent unnecessary re-renders.
 *
 * @returns Object containing all merge store actions
 */
export function useMergeActions(): Pick<
  MergeStore,
  | 'setDetectionMode'
  | 'detectConflicts'
  | 'loadPreference'
  | 'clearResults'
  | 'clearError'
  | 'getMergePreview'
  | 'setShowConflictsOnly'
  | 'setSelectedFile'
  | 'openDiff'
  | 'closeDiff'
  | 'clearPreview'
  | 'setWorkflowState'
  | 'setBranches'
  | 'setWorktreeContext'
  | 'executeMerge'
  | 'resetWorkflow'
  | 'setMergeProgress'
  | 'setMergeStep'
> {
  return useMergeStore(
    useShallow((state) => ({
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
    clearPreview: state.clearPreview,
    setWorkflowState: state.setWorkflowState,
    setBranches: state.setBranches,
    setWorktreeContext: state.setWorktreeContext,
    executeMerge: state.executeMerge,
    resetWorkflow: state.resetWorkflow,
    setMergeProgress: state.setMergeProgress,
    setMergeStep: state.setMergeStep
    }))
  )
}
