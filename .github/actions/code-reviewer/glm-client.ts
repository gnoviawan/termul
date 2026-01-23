import { ZhipuAI } from 'zhipuai-sdk-nodejs-v4'

/**
 * Response from GLM 4.7 API
 */
export interface GLMResponse {
  content: string
  model: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

/**
 * Error types for GLM API operations
 */
export const GLMErrorCodes = {
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  API_ERROR: 'API_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR'
} as const

export type GLMErrorCode = (typeof GLMErrorCodes)[keyof typeof GLMErrorCodes]

/**
 * Custom error class for GLM API operations
 */
export class GLMError extends Error {
  constructor(
    message: string,
    public code: GLMErrorCode,
    public originalError?: unknown
  ) {
    super(message)
    this.name = 'GLMError'
  }
}

/**
 * Configuration options for GLM client
 */
export interface GLMClientOptions {
  apiKey: string
  model?: string
  timeout?: number
  maxRetries?: number
  retryDelay?: number
}

/**
 * Message format for GLM chat completions
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * GLM 4.7 API client wrapper
 * Provides a typed interface to Zhipu AI's GLM 4.7 model for code review
 */
export class GLMClient {
  private client: ZhipuAI
  private model: string
  private timeout: number
  private maxRetries: number
  private retryDelay: number

  /**
   * Create a new GLM client instance
   *
   * @param options - Client configuration options
   */
  constructor(options: GLMClientOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new GLMError(
        'API key is required',
        GLMErrorCodes.AUTHENTICATION_FAILED
      )
    }

    this.client = new ZhipuAI({
      apiKey: options.apiKey
    })
    this.model = options.model || 'glm-4.7'
    this.timeout = options.timeout || 30000 // 30 seconds default
    this.maxRetries = options.maxRetries ?? 3
    this.retryDelay = options.retryDelay ?? 1000 // 1 second default
  }

  /**
   * Send a chat completion request to GLM 4.7
   *
   * @param messages - Array of chat messages
   * @param maxTokens - Maximum tokens in response (optional)
   * @returns Promise resolving to GLM response
   * @throws GLMError if the request fails
   */
  async chat(
    messages: ChatMessage[],
    maxTokens?: number
  ): Promise<GLMResponse> {
    return this.retryAsync(async () => {
      const response = await this.client.createCompletions({
        model: this.model,
        messages: messages.map((msg) => ({
          role: msg.role,
          content: msg.content
        })),
        maxTokens,
        stream: false
      })

      // When stream: false, response is CompletionsResponseMessage
      // Type assertion needed because SDK returns union type
      const completion = response as {
        id: string
        created: number
        model: string
        choices: Array<{
          index: number
          finish_reason: string
          message: {
            role: string
            content: string
          }
        }>
        usage: {
          prompt_tokens: number
          completion_tokens: number
          total_tokens: number
        }
      }

      // Validate response structure
      if (!completion.choices || completion.choices.length === 0) {
        throw new GLMError(
          'Empty response from GLM API',
          GLMErrorCodes.API_ERROR
        )
      }

      const choice = completion.choices[0]
      if (!choice.message || !choice.message.content) {
        throw new GLMError(
          'Invalid response format from GLM API',
          GLMErrorCodes.API_ERROR
        )
      }

      return {
        content: choice.message.content,
        model: completion.model || this.model,
        usage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens
            }
          : undefined
      }
    })
  }

  /**
   * Send a single prompt to GLM 4.7 (convenience method)
   *
   * @param prompt - The prompt text
   * @param systemPrompt - Optional system prompt
   * @param maxTokens - Maximum tokens in response (optional)
   * @returns Promise resolving to GLM response
   */
  async prompt(
    prompt: string,
    systemPrompt?: string,
    maxTokens?: number
  ): Promise<GLMResponse> {
    const messages: ChatMessage[] = []

    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt
      })
    }

    messages.push({
      role: 'user',
      content: prompt
    })

    return this.chat(messages, maxTokens)
  }

  /**
   * Retry an async operation with exponential backoff
   *
   * @param operation - The async operation to retry
   * @param attempt - Current attempt number (used internally for recursion)
   * @returns Promise resolving to the operation result
   * @throws GLMError if all retries fail
   */
  private async retryAsync<T>(
    operation: () => Promise<T>,
    attempt: number = 1
  ): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      const glmError = this.handleError(error)

      // Don't retry authentication or invalid request errors
      if (
        glmError.code === GLMErrorCodes.AUTHENTICATION_FAILED ||
        glmError.code === GLMErrorCodes.INVALID_REQUEST
      ) {
        throw glmError
      }

      // Check if we should retry
      if (attempt >= this.maxRetries) {
        throw glmError
      }

      // Calculate exponential backoff delay
      const delay = this.retryDelay * Math.pow(2, attempt - 1)

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay))

      // Retry the operation
      return this.retryAsync(operation, attempt + 1)
    }
  }

  /**
   * Convert API errors to GLMError instances
   *
   * @param error - The error from the API call
   * @returns GLMError instance
   */
  private handleError(error: unknown): GLMError {
    if (error instanceof GLMError) {
      return error
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase()

      // Check for authentication errors
      if (
        message.includes('unauthorized') ||
        message.includes('authentication') ||
        message.includes('invalid api key')
      ) {
        return new GLMError(
          'Authentication failed: Invalid API key',
          GLMErrorCodes.AUTHENTICATION_FAILED,
          error
        )
      }

      // Check for rate limit errors
      if (
        message.includes('rate limit') ||
        message.includes('quota') ||
        message.includes('too many requests')
      ) {
        return new GLMError(
          'Rate limit exceeded. Please try again later.',
          GLMErrorCodes.RATE_LIMIT_EXCEEDED,
          error
        )
      }

      // Check for network errors
      if (
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('econnrefused')
      ) {
        return new GLMError(
          'Network error: Unable to reach GLM API',
          GLMErrorCodes.NETWORK_ERROR,
          error
        )
      }

      // Generic API error
      return new GLMError(
        `API error: ${error.message}`,
        GLMErrorCodes.API_ERROR,
        error
      )
    }

    // Unknown error type
    return new GLMError(
      'Unknown error occurred',
      GLMErrorCodes.API_ERROR,
      error
    )
  }

  /**
   * Validate that the client is properly configured
   *
   * @returns true if client is ready to use
   */
  isConfigured(): boolean {
    return this.client !== undefined && this.model !== undefined
  }

  /**
   * Get the model being used
   *
   * @returns Model name
   */
  getModel(): string {
    return this.model
  }
}
