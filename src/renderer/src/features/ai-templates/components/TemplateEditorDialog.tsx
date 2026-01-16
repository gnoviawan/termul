/**
 * Template Editor Dialog Component
 *
 * Dialog for creating and editing AI tool templates.
 * Features: form fields, variable definitions, real-time validation.
 * Source: Story 3.2 - Task 2: Create Template Editor Dialog
 */

import { useState, useEffect, useCallback, memo } from 'react'
import { X, Plus, Trash2, Check, AlertCircle, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useTemplateActions, useEditorState, useEditingTemplate, useValidationState, useIsLoading } from '../ai-templates-store'
import type { AIToolTemplate, AIToolType, TemplateVariable } from '@shared/types/ai-prompt.types'

export interface TemplateEditorDialogProps {
  onSave: (template: AIToolTemplate) => Promise<void>
  onCancel: () => void
  onTest: (template: AIToolTemplate) => void
}

/**
 * Template variable definition row
 */
interface VariableRowProps {
  variable: TemplateVariable
  index: number
  onUpdate: (index: number, variable: TemplateVariable) => void
  onRemove: (index: number) => void
  canRemove: boolean
}

const VariableRow = memo(({ variable, index, onUpdate, onRemove, canRemove }: VariableRowProps) => {
  const [name, setName] = useState(variable.name)
  const [description, setDescription] = useState(variable.description)
  const [required, setRequired] = useState(variable.required)
  const [defaultValue, setDefaultValue] = useState(variable.defaultValue || '')

  useEffect(() => {
    onUpdate(index, { ...variable, name, description, required, defaultValue: defaultValue || undefined })
  }, [name, description, required, defaultValue])

  return (
    <div className="grid grid-cols-[1fr_2fr_auto_auto_auto] gap-2 items-start p-3 bg-card rounded border border-border">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="variableName"
        className="bg-secondary/50 border border-border rounded px-2 py-1.5 text-sm font-mono text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
      />

      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Variable description"
        className="bg-secondary/50 border border-border rounded px-2 py-1.5 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
      />

      <label className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
          className="rounded border-border"
        />
        Required
      </label>

      <input
        type="text"
        value={defaultValue}
        onChange={(e) => setDefaultValue(e.target.value)}
        placeholder="Default value"
        className="bg-secondary/50 border border-border rounded px-2 py-1.5 text-sm text-muted-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
        disabled={required}
      />

      <button
        onClick={() => onRemove(index)}
        disabled={!canRemove}
        className="p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  )
})

VariableRow.displayName = 'VariableRow'

/**
 * Get tool display name
 */
function getToolDisplayName(tool: AIToolType): string {
  switch (tool) {
    case 'cursor':
      return 'Cursor'
    case 'aider':
      return 'Aider'
    case 'claude-code':
      return 'Claude Code'
    case 'custom':
      return 'Custom'
    default:
      return tool
  }
}

/**
 * TemplateEditorDialog - Create/edit template dialog
 *
 * Two-column layout: Form fields left, live preview right.
 * Real-time validation via validateTemplate IPC.
 */
export function TemplateEditorDialog({ onSave, onCancel, onTest }: TemplateEditorDialogProps) {
  const editorState = useEditorState()
  const editingTemplate = useEditingTemplate()
  const validationState = useValidationState()
  const isLoading = useIsLoading()

  const { validateTemplate, clearError } = useTemplateActions()

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [tool, setTool] = useState<AIToolType>('custom')
  const [promptTemplate, setPromptTemplate] = useState('')
  const [variables, setVariables] = useState<TemplateVariable[]>([])

  // Initialize from editing template
  useEffect(() => {
    if (editorState === 'edit' && editingTemplate) {
      setName(editingTemplate.name)
      setDescription(editingTemplate.description)
      setTool(editingTemplate.tool)
      setPromptTemplate(editingTemplate.promptTemplate)
      setVariables(editingTemplate.variables)
    } else if (editorState === 'create') {
      // Reset form for create mode
      setName('')
      setDescription('')
      setTool('custom')
      setPromptTemplate('')
      setVariables([])
    }
  }, [editorState, editingTemplate])

  // Real-time validation
  useEffect(() => {
    const timeoutId = setTimeout(async () => {
      if (name && promptTemplate) {
        const template: AIToolTemplate = {
          id: editingTemplate?.id || `custom-${Date.now()}`,
          name,
          description,
          tool,
          promptTemplate,
          variables,
          requiredVars: variables.filter(v => v.required).map(v => v.name)
        }

        await validateTemplate(template)
      }
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [name, promptTemplate, variables, tool, description, editingTemplate, validateTemplate])

  const isOpen = editorState !== 'closed'

  // Handle add variable
  const handleAddVariable = useCallback(() => {
    setVariables([...variables, {
      name: '',
      description: '',
      required: false
    }])
  }, [variables])

  // Handle update variable
  const handleUpdateVariable = useCallback((index: number, variable: TemplateVariable) => {
    const updated = [...variables]
    updated[index] = variable
    setVariables(updated)
  }, [variables])

  // Handle remove variable
  const handleRemoveVariable = useCallback((index: number) => {
    setVariables(variables.filter((_, i) => i !== index))
  }, [variables])

  // Handle save
  const handleSave = useCallback(async () => {
    const template: AIToolTemplate = {
      id: editingTemplate?.id || `custom-${Date.now()}`,
      name,
      description,
      tool,
      promptTemplate,
      variables,
      requiredVars: variables.filter(v => v.required).map(v => v.name),
      isDefault: false
    }

    await onSave(template)
  }, [name, description, tool, promptTemplate, variables, editingTemplate, onSave])

  // Handle test
  const handleTest = useCallback(() => {
    const template: AIToolTemplate = {
      id: editingTemplate?.id || `custom-${Date.now()}`,
      name,
      description,
      tool,
      promptTemplate,
      variables,
      requiredVars: variables.filter(v => v.required).map(v => v.name),
      isDefault: false
    }

    onTest(template)
  }, [name, description, tool, promptTemplate, variables, editingTemplate, onTest])

  const isValid = validationState?.isValid ?? false
  const hasErrors = validationState?.errors && validationState.errors.length > 0
  const canSave = name.trim() !== '' && promptTemplate.trim() !== '' && !hasErrors

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-full max-w-5xl border border-border overflow-hidden flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {editorState === 'edit' ? 'Edit Template' : 'Create Custom Template'}
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Define a new AI tool prompt template with variables
                </p>
              </div>
              <button
                onClick={onCancel}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              <div className="grid grid-cols-2 divide-x divide-border">
                {/* Left: Form fields */}
                <div className="p-6 space-y-6">
                  {/* Template name */}
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      Template Name *
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="My Custom AI Tool"
                      className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                    />
                  </div>

                  {/* Template description */}
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      Description
                    </label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Describe what this template does..."
                      rows={3}
                      className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none resize-none"
                    />
                  </div>

                  {/* Tool type */}
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      Tool Type
                    </label>
                    <select
                      value={tool}
                      onChange={(e) => setTool(e.target.value as AIToolType)}
                      className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                    >
                      <option value="cursor">Cursor</option>
                      <option value="aider">Aider</option>
                      <option value="claude-code">Claude Code</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>

                  {/* Prompt template */}
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      Prompt Template *
                    </label>
                    <textarea
                      value={promptTemplate}
                      onChange={(e) => setPromptTemplate(e.target.value)}
                      placeholder="Use {{variableName}} for variables..."
                      rows={8}
                      className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm font-mono text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none resize-none"
                    />
                    <p className="text-xs text-muted-foreground mt-2">
                      Use {'{{'}
                      variableName
                      {'}}'}
                      {' '}syntax for template variables
                    </p>
                  </div>
                </div>

                {/* Right: Variable definitions */}
                <div className="p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-foreground">
                      Variables ({variables.length})
                    </h3>
                    <button
                      onClick={handleAddVariable}
                      className="flex items-center gap-1 text-xs px-2 py-1 bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      Add Variable
                    </button>
                  </div>

                  {variables.length === 0 ? (
                    <div className="text-center py-8 text-sm text-muted-foreground">
                      No variables defined. Click "Add Variable" to get started.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {variables.map((variable, index) => (
                        <VariableRow
                          key={index}
                          variable={variable}
                          index={index}
                          onUpdate={handleUpdateVariable}
                          onRemove={handleRemoveVariable}
                          canRemove={variables.length > 0}
                        />
                      ))}
                    </div>
                  )}

                  {/* Validation feedback */}
                  {validationState && (
                    <div className={cn(
                      'rounded-md p-3 border',
                      isValid ? 'bg-green-500/10 border-green-500/20' : 'bg-destructive/10 border-destructive/20'
                    )}>
                      {hasErrors ? (
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-destructive">
                              Validation Errors
                            </p>
                            <ul className="text-xs text-destructive/80 mt-1 space-y-1">
                              {validationState.errors.map((error, i) => (
                                <li key={i}>• {error}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      ) : isValid ? (
                        <div className="flex items-center gap-2">
                          <Check className="w-4 h-4 text-green-500" />
                          <p className="text-sm text-green-500">
                            Template is valid
                          </p>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-secondary/20 flex-shrink-0">
              <button
                onClick={handleTest}
                disabled={!canSave}
                className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Test Template
              </button>

              <div className="flex items-center gap-3">
                <button
                  onClick={onCancel}
                  className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
                >
                  Cancel
                </button>

                <button
                  onClick={handleSave}
                  disabled={!canSave || isLoading}
                  className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      Save Template
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
