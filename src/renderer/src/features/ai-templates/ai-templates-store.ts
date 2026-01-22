/**
 * AI Templates Store
 *
 * State management for AI tool templates including template CRUD operations,
 * validation, and editor state.
 * Source: Story 3.2 - Task 7: Template State Management
 */

import { create } from 'zustand'
import type {
  AIToolTemplate,
  ValidationResult,
  AIToolType
} from '@shared/types/ai-prompt.types'

/**
 * Editor state for template creation/editing
 */
export type EditorState = 'closed' | 'create' | 'edit'

/**
 * AI Templates store state and actions
 */
interface AITemplatesStore {
  // State
  templates: AIToolTemplate[]
  selectedTemplate: AIToolTemplate | null
  isLoading: boolean
  error: string | null
  validationState: ValidationResult | null
  editorState: EditorState
  editingTemplate: AIToolTemplate | null

  // Dialog states
  showTestDialog: boolean
  testTemplate: AIToolTemplate | null

  // Actions
  fetchTemplates: () => Promise<void>
  selectTemplate: (template: AIToolTemplate) => void
  clearSelection: () => void
  createTemplate: (template: AIToolTemplate) => Promise<void>
  updateTemplate: (template: AIToolTemplate) => Promise<void>
  deleteTemplate: (templateId: string) => Promise<void>
  validateTemplate: (template: AIToolTemplate) => Promise<ValidationResult>
  clearError: () => void

  // Editor actions
  openCreateEditor: () => void
  openEditEditor: (template: AIToolTemplate) => void
  closeEditor: () => void

  // Test dialog actions
  openTestDialog: (template: AIToolTemplate) => void
  closeTestDialog: () => void
}

/**
 * AI Templates store using Zustand
 * Manages template list, selection, editing, and validation
 */
export const useAITemplatesStore = create<AITemplatesStore>((set, get) => ({
  // Initial state
  templates: [],
  selectedTemplate: null,
  isLoading: false,
  error: null,
  validationState: null,
  editorState: 'closed',
  editingTemplate: null,
  showTestDialog: false,
  testTemplate: null,

  // Fetch all templates from IPC
  fetchTemplates: async () => {
    set({ isLoading: true, error: null })

    try {
      const result = await window.api.aiPrompt.listTemplates()

      if (result.success) {
        set({ templates: result.data || [], isLoading: false })
      } else {
        set({ error: result.error || 'Failed to load templates', isLoading: false })
      }
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  // Select a template to view details
  selectTemplate: (template: AIToolTemplate) => {
    set({ selectedTemplate: template })
  },

  // Clear template selection
  clearSelection: () => {
    set({ selectedTemplate: null })
  },

  // Create a new template via IPC
  createTemplate: async (template: AIToolTemplate) => {
    set({ isLoading: true, error: null })

    try {
      const result = await window.api.aiPrompt.registerTemplate({ template })

      if (result.success) {
        // Refresh templates after create
        await get().fetchTemplates()
        set({ isLoading: false, editorState: 'closed' })
      } else {
        set({ error: result.error || 'Failed to create template', isLoading: false })
      }
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  // Update a template (delete + re-register since no update API)
  updateTemplate: async (template: AIToolTemplate) => {
    set({ isLoading: true, error: null })

    try {
      // Note: Since there's no updateTemplate IPC, we would need to implement
      // deletion and re-registration. For now, this is a placeholder.
      // The actual implementation will need to handle this in Task 5.

      // For now, just refresh templates
      await get().fetchTemplates()
      set({ isLoading: false, editorState: 'closed', editingTemplate: null })
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  // Delete a template (custom templates only)
  deleteTemplate: async (templateId: string) => {
    const template = get().templates.find(t => t.id === templateId)

    // Cannot delete default templates
    if (template?.isDefault) {
      set({ error: 'Cannot delete default templates' })
      return
    }

    set({ isLoading: true, error: null })

    try {
      // Delete will be implemented in Task 5 with IPC
      // For now, remove from local state
      set({
        templates: get().templates.filter(t => t.id !== templateId),
        isLoading: false,
        selectedTemplate: get().selectedTemplate?.id === templateId ? null : get().selectedTemplate
      })
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  // Validate template via IPC
  validateTemplate: async (template: AIToolTemplate) => {
    try {
      const result = await window.api.aiPrompt.validateTemplate({ template })

      if (result.success) {
        set({ validationState: result.data })
      } else {
        set({ validationState: { isValid: false, errors: [result.error || 'Validation failed'], warnings: [] } })
      }

      return result.success ? result.data : { isValid: false, errors: [result.error || 'Validation failed'], warnings: [] }
    } catch (error) {
      const errorResult = { isValid: false, errors: [String(error)], warnings: [] }
      set({ validationState: errorResult })
      return errorResult
    }
  },

  // Clear error state
  clearError: () => {
    set({ error: null })
  },

  // Open create editor
  openCreateEditor: () => {
    set({ editorState: 'create', editingTemplate: null, validationState: null })
  },

  // Open edit editor
  openEditEditor: (template: AIToolTemplate) => {
    // Cannot edit default templates
    if (template.isDefault) {
      set({ error: 'Cannot edit default templates' })
      return
    }

    set({ editorState: 'edit', editingTemplate: template, validationState: null })
  },

  // Close editor
  closeEditor: () => {
    set({ editorState: 'closed', editingTemplate: null, validationState: null })
  },

  // Open test dialog
  openTestDialog: (template: AIToolTemplate) => {
    set({ showTestDialog: true, testTemplate: template })
  },

  // Close test dialog
  closeTestDialog: () => {
    set({ showTestDialog: false, testTemplate: null })
  }
}))

// Selectors for optimized re-renders
export const useTemplates = () => useAITemplatesStore((state) => state.templates)
export const useSelectedTemplate = () => useAITemplatesStore((state) => state.selectedTemplate)
export const useIsLoading = () => useAITemplatesStore((state) => state.isLoading)
export const useTemplatesError = () => useAITemplatesStore((state) => state.error)
export const useValidationState = () => useAITemplatesStore((state) => state.validationState)
export const useEditorState = () => useAITemplatesStore((state) => state.editorState)
export const useEditingTemplate = () => useAITemplatesStore((state) => state.editingTemplate)
export const useShowTestDialog = () => useAITemplatesStore((state) => state.showTestDialog)
export const useTestTemplate = () => useAITemplatesStore((state) => state.testTemplate)

// Combined selectors
export const useTemplatesState = () => useAITemplatesStore((state) => ({
  templates: state.templates,
  selectedTemplate: state.selectedTemplate,
  isLoading: state.isLoading,
  error: state.error
}))

// Actions selector
export const useTemplateActions = () => useAITemplatesStore((state) => ({
  fetchTemplates: state.fetchTemplates,
  selectTemplate: state.selectTemplate,
  clearSelection: state.clearSelection,
  createTemplate: state.createTemplate,
  updateTemplate: state.updateTemplate,
  deleteTemplate: state.deleteTemplate,
  validateTemplate: state.validateTemplate,
  clearError: state.clearError,
  openCreateEditor: state.openCreateEditor,
  openEditEditor: state.openEditEditor,
  closeEditor: state.closeEditor,
  openTestDialog: state.openTestDialog,
  closeTestDialog: state.closeTestDialog
}))
