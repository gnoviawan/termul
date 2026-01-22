/**
 * AI Templates Settings Page Component
 *
 * Main settings page for managing AI tool templates.
 * Lists all templates with add/edit/delete/test functionality.
 * Source: Story 3.2 - Task 1.1: Create AITemplatesSettings page component
 */

import { useEffect, useCallback } from 'react'
import { Plus, Settings } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { TemplateList } from './TemplateList'
import { TemplateEditorDialog } from './TemplateEditorDialog'
import { TemplateDetailsPanel } from './TemplateDetailsPanel'
import { TemplateTestDialog } from './TemplateTestDialog'
import { useTemplates, useSelectedTemplate, useIsLoading, useTemplatesError, useTemplateActions, useEditorState, useShowTestDialog, useTestTemplate } from '../ai-templates-store'
import type { AIToolTemplate } from '@shared/types/ai-prompt.types'

/**
 * AITemplatesSettings - Main AI Templates settings page
 *
 * Displays list of all templates with "Add Custom Template" button.
 * Shows selected template details panel when template is selected.
 */
export function AITemplatesSettings() {
  const navigate = useNavigate()
  const templates = useTemplates()
  const selectedTemplate = useSelectedTemplate()
  const isLoading = useIsLoading()
  const error = useTemplatesError()
  const editorState = useEditorState()
  const showTestDialog = useShowTestDialog()
  const testTemplate = useTestTemplate()

  const {
    fetchTemplates,
    selectTemplate,
    clearSelection,
    openCreateEditor,
    openEditEditor,
    closeEditor,
    deleteTemplate,
    openTestDialog,
    closeTestDialog,
    createTemplate,
    updateTemplate
  } = useTemplateActions()

  // Load templates on mount
  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  // Handle template selection
  const handleSelectTemplate = useCallback((template: typeof templates[0]) => {
    selectTemplate(template)
  }, [selectTemplate])

  // Handle template edit
  const handleEditTemplate = useCallback((template: typeof templates[0]) => {
    openEditEditor(template)
  }, [openEditEditor])

  // Handle template delete
  const handleDeleteTemplate = useCallback(async (templateId: string) => {
    if (window.confirm('Are you sure you want to delete this template?')) {
      await deleteTemplate(templateId)
    }
  }, [deleteTemplate])

  // Handle template test
  const handleTestTemplate = useCallback((template: typeof templates[0]) => {
    openTestDialog(template)
  }, [openTestDialog])

  // Handle add template
  const handleAddTemplate = useCallback(() => {
    openCreateEditor()
  }, [openCreateEditor])

  // Handle save template
  const handleSaveTemplate = useCallback(async (template: AIToolTemplate) => {
    if (editorState === 'create') {
      await createTemplate(template)
    } else if (editorState === 'edit') {
      await updateTemplate(template)
    }
  }, [editorState, createTemplate, updateTemplate])

  // Handle test template from editor
  const handleTestFromEditor = useCallback((template: AIToolTemplate) => {
    openTestDialog(template)
  }, [openTestDialog])

  return (
    <main className="flex-1 flex flex-col min-w-0 h-full relative">
      {/* Header */}
      <div className="h-16 flex items-center justify-between px-8 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded text-primary">
            <Settings size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground leading-tight">
              AI Templates
            </h1>
            <p className="text-xs text-muted-foreground">
              Manage AI tool prompt templates
            </p>
          </div>
        </div>

        <button
          onClick={handleAddTemplate}
          className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded shadow-lg shadow-primary/20 transition-all"
        >
          <Plus size={16} />
          Add Custom Template
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {selectedTemplate ? (
          <div className="h-full flex">
            {/* Template list (sidebar) */}
            <div className="w-80 border-r border-border overflow-y-auto p-4 bg-secondary/10">
              <button
                onClick={clearSelection}
                className="mb-4 text-sm text-primary hover:text-primary/80 font-medium transition-colors"
              >
                ← Back to all templates
              </button>
              <TemplateList
                templates={templates}
                selectedTemplate={selectedTemplate}
                onSelectTemplate={handleSelectTemplate}
                onEditTemplate={handleEditTemplate}
                onDeleteTemplate={handleDeleteTemplate}
                onTestTemplate={handleTestTemplate}
                isLoading={isLoading}
                error={error}
              />
            </div>

            {/* Template details panel */}
            <div className="flex-1 overflow-y-auto p-8">
              <TemplateDetailsPanel
                template={selectedTemplate}
                onEdit={handleEditTemplate}
                onTest={handleTestTemplate}
                canEdit={!selectedTemplate.isDefault}
              />
            </div>
          </div>
        ) : (
          /* Full template list */
          <div className="h-full overflow-y-auto p-8">
            <div className="max-w-6xl mx-auto">
              <TemplateList
                templates={templates}
                selectedTemplate={selectedTemplate}
                onSelectTemplate={handleSelectTemplate}
                onEditTemplate={handleEditTemplate}
                onDeleteTemplate={handleDeleteTemplate}
                onTestTemplate={handleTestTemplate}
                isLoading={isLoading}
                error={error}
              />
            </div>
          </div>
        )}
      </div>

      {/* Dialogs */}
      <TemplateEditorDialog
        onSave={handleSaveTemplate}
        onCancel={closeEditor}
        onTest={handleTestFromEditor}
      />

      {testTemplate && (
        <TemplateTestDialog
          isOpen={showTestDialog}
          template={testTemplate}
          onClose={closeTestDialog}
        />
      )}
    </main>
  )
}
