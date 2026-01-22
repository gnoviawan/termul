/**
 * AI Templates Feature Module
 *
 * Public exports for AI Templates feature.
 * Source: Story 3.2 - AI Tool Templates UI
 */

export { AITemplatesSettings } from './components/AITemplatesSettings'
export { TemplateList } from './components/TemplateList'
export { TemplateCard } from './components/TemplateCard'
export { TemplateEditorDialog } from './components/TemplateEditorDialog'
export { TemplateDetailsPanel } from './components/TemplateDetailsPanel'
export { TemplateTestDialog } from './components/TemplateTestDialog'

export {
  useAITemplatesStore,
  useTemplates,
  useSelectedTemplate,
  useIsLoading,
  useTemplatesError,
  useValidationState,
  useEditorState,
  useEditingTemplate,
  useShowTestDialog,
  useTestTemplate,
  useTemplatesState,
  useTemplateActions
} from './ai-templates-store'
