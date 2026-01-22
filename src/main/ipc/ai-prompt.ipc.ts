/**
 * AI Prompt IPC handlers
 *
 * Bridges renderer AI prompt API calls to AIPromptGenerator service in main process.
 * All handlers use IpcResult<T> pattern for consistent error handling.
 * Source: Story 3.1 - Task 4: Create IPC Handlers for AI Prompts
 */

import { ipcMain } from 'electron'
import { AIPromptGenerator, AIPromptError } from '../services/ai-prompt-generator'
import type {
  IpcResult,
  IpcErrorCode
} from '../../shared/types/ipc.types'
import type {
  AIToolType,
  GeneratedPrompt,
  AIToolTemplate,
  ValidationResult,
  GeneratePromptDto,
  RegisterTemplateDto,
  ValidateTemplateDto,
  AIPromptErrorCodeType
} from '../../shared/types/ai-prompt.types'

/**
 * AI prompt error codes for IPC
 */
const AIPromptErrorCodes: Record<string, AIPromptErrorCodeType> = {
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  INVALID_TEMPLATE: 'INVALID_TEMPLATE',
  MISSING_REQUIRED_VAR: 'MISSING_REQUIRED_VAR',
  TOOL_NOT_SUPPORTED: 'TOOL_NOT_SUPPORTED',
  GENERATION_FAILED: 'GENERATION_FAILED'
} as const

/**
 * Map AIPromptError to IpcResult format
 */
function mapErrorToIpcResult(error: unknown): IpcResult<never> {
  if (error instanceof AIPromptError) {
    return {
      success: false,
      error: error.message,
      code: error.code as IpcErrorCode
    }
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
    code: 'GENERATION_FAILED'
  }
}

/**
 * Singleton instance of AIPromptGenerator
 */
let aiPromptGenerator: AIPromptGenerator | null = null

/**
 * Get or create AI prompt generator instance
 */
function getGenerator(): AIPromptGenerator {
  if (!aiPromptGenerator) {
    aiPromptGenerator = new AIPromptGenerator()
  }
  return aiPromptGenerator
}

/**
 * Register AI prompt IPC handlers
 *
 * Handler registration must happen before app.ready() to prevent timing issues.
 * Task 4.1: Create electron/main/ipc/ai-prompt.ipc.ts file
 */
export function registerAIPromptIpc(): void {
  // Task 4.2: Implement ai-prompt:generate handler
  ipcMain.handle(
    'ai-prompt:generate',
    async (_event, dto: GeneratePromptDto): Promise<IpcResult<GeneratedPrompt>> => {
      try {
        const generator = getGenerator()
        const result = await generator.generatePrompt(dto.tool, dto.context)

        return {
          success: true,
          data: result
        }
      } catch (error) {
        return mapErrorToIpcResult(error)
      }
    }
  )

  // Task 4.3: Implement ai-prompt:list-templates handler
  ipcMain.handle(
    'ai-prompt:list-templates',
    async (): Promise<IpcResult<AIToolTemplate[]>> => {
      try {
        const generator = getGenerator()
        const templates = generator.listTemplates()

        return {
          success: true,
          data: templates
        }
      } catch (error) {
        return mapErrorToIpcResult(error)
      }
    }
  )

  // Task 4.4: Implement ai-prompt:register-template handler
  ipcMain.handle(
    'ai-prompt:register-template',
    async (_event, dto: RegisterTemplateDto): Promise<IpcResult<void>> => {
      try {
        const generator = getGenerator()
        generator.registerTemplate(dto.template)

        return {
          success: true,
          data: undefined
        }
      } catch (error) {
        return mapErrorToIpcResult(error)
      }
    }
  )

  // Task 4.5: Implement ai-prompt:validate-template handler
  ipcMain.handle(
    'ai-prompt:validate-template',
    async (_event, dto: ValidateTemplateDto): Promise<IpcResult<ValidationResult>> => {
      try {
        const generator = getGenerator()
        const result = generator.validateTemplate(dto.template)

        return {
          success: true,
          data: result
        }
      } catch (error) {
        return mapErrorToIpcResult(error)
      }
    }
  )
}
