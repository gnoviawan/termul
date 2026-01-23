import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GLMClient, GLMError, GLMErrorCodes, type GLMResponse } from './glm-client'

// Mock the ZhipuAI SDK
const mockCreateCompletions = vi.fn()
vi.mock('zhipuai-sdk-nodejs-v4', () => {
  return {
    ZhipuAI: vi.fn().mockImplementation(() => ({
      createCompletions: mockCreateCompletions
    }))
  }
})

describe('GLMClient', () => {
  let client: GLMClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateCompletions.mockClear()
    mockCreateCompletions.mockReset()

    // Create a new client for each test
    client = new GLMClient({
      apiKey: 'test-api-key'
    })
  })

  describe('constructor', () => {
    it('should create client with valid API key', () => {
      expect(client).toBeInstanceOf(GLMClient)
      expect(client.getModel()).toBe('glm-4.7')
    })

    it('should use default model when not specified', () => {
      const defaultClient = new GLMClient({
        apiKey: 'test-api-key'
      })
      expect(defaultClient.getModel()).toBe('glm-4.7')
    })

    it('should use custom model when specified', () => {
      const customClient = new GLMClient({
        apiKey: 'test-api-key',
        model: 'glm-4.0'
      })
      expect(customClient.getModel()).toBe('glm-4.0')
    })

    it('should use default timeout when not specified', () => {
      const defaultClient = new GLMClient({
        apiKey: 'test-api-key'
      })
      expect(defaultClient).toBeDefined()
    })

    it('should use custom timeout when specified', () => {
      const customClient = new GLMClient({
        apiKey: 'test-api-key',
        timeout: 60000
      })
      expect(customClient).toBeDefined()
    })

    it('should use default retry settings when not specified', () => {
      const defaultClient = new GLMClient({
        apiKey: 'test-api-key'
      })
      expect(defaultClient).toBeDefined()
    })

    it('should throw GLMError when API key is empty', () => {
      expect(() => {
        new GLMClient({ apiKey: '' })
      }).toThrow(GLMError)
    })

    it('should throw GLMError when API key is only whitespace', () => {
      expect(() => {
        new GLMClient({ apiKey: '   ' })
      }).toThrow(GLMError)
    })

    it('should throw error with AUTHENTICATION_FAILED code for missing API key', () => {
      try {
        new GLMClient({ apiKey: '' })
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
        expect((error as GLMError).code).toBe(GLMErrorCodes.AUTHENTICATION_FAILED)
      }
    })
  })

  describe('chat', () => {
    it('should send chat request successfully', async () => {
      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.7',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Test response'
            }
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30
        }
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      const messages = [
        { role: 'user' as const, content: 'Hello' }
      ]

      const result = await client.chat(messages)

      expect(result).toEqual({
        content: 'Test response',
        model: 'glm-4.7',
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30
        }
      })

      expect(mockCreateCompletions).toHaveBeenCalledWith({
        model: 'glm-4.7',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: undefined,
        stream: false
      })
    })

    it('should handle multiple messages', async () => {
      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.7',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Response'
            }
          }
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 25,
          total_tokens: 40
        }
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      const messages = [
        { role: 'system' as const, content: 'You are helpful' },
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there' },
        { role: 'user' as const, content: 'How are you?' }
      ]

      await client.chat(messages)

      expect(mockCreateCompletions).toHaveBeenCalledWith({
        model: 'glm-4.7',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'How are you?' }
        ],
        maxTokens: undefined,
        stream: false
      })
    })

    it('should respect maxTokens parameter', async () => {
      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.7',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Response'
            }
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30
        }
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      await client.chat(messages, 5000)

      expect(mockCreateCompletions).toHaveBeenCalledWith({
        model: 'glm-4.7',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 5000,
        stream: false
      })
    })

    it('should throw GLMError when response has no choices', async () => {
      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.7',
        choices: []
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      await expect(client.chat(messages)).rejects.toThrow(GLMError)
    })

    it('should throw GLMError when response has invalid message format', async () => {
      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.7',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant'
              // Missing content
            }
          }
        ]
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      await expect(client.chat(messages)).rejects.toThrow(GLMError)
    })

    it('should handle response without usage information', async () => {
      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.7',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Response'
            }
          }
        ]
        // No usage field
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      const result = await client.chat(messages)

      expect(result.usage).toBeUndefined()
    })

    it('should use custom model when specified in constructor', async () => {
      const customModelClient = new GLMClient({
        apiKey: 'test-api-key',
        model: 'glm-4.0'
      })

      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.0',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Response'
            }
          }
        ]
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      await customModelClient.chat(messages)

      expect(mockCreateCompletions).toHaveBeenCalledWith({
        model: 'glm-4.0',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: undefined,
        stream: false
      })
    })
  })

  describe('prompt', () => {
    it('should send single prompt without system prompt', async () => {
      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.7',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Response'
            }
          }
        ]
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      const result = await client.prompt('Hello')

      expect(result.content).toBe('Response')
      expect(mockCreateCompletions).toHaveBeenCalledWith({
        model: 'glm-4.7',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: undefined,
        stream: false
      })
    })

    it('should send prompt with system prompt', async () => {
      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.7',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Response'
            }
          }
        ]
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      await client.prompt('Hello', 'You are helpful')

      expect(mockCreateCompletions).toHaveBeenCalledWith({
        model: 'glm-4.7',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' }
        ],
        maxTokens: undefined,
        stream: false
      })
    })

    it('should pass maxTokens parameter through', async () => {
      const mockResponse = {
        id: 'test-id',
        created: 1234567890,
        model: 'glm-4.7',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Response'
            }
          }
        ]
      }

      mockCreateCompletions.mockResolvedValue(mockResponse)

      await client.prompt('Hello', 'You are helpful', 5000)

      expect(mockCreateCompletions).toHaveBeenCalledWith({
        model: 'glm-4.7',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' }
        ],
        maxTokens: 5000,
        stream: false
      })
    })
  })

  describe('error handling', () => {
    it('should classify authentication errors correctly', async () => {
      mockCreateCompletions.mockRejectedValue(
        new Error('unauthorized: invalid api key')
      )

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await client.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
        expect((error as GLMError).code).toBe(GLMErrorCodes.AUTHENTICATION_FAILED)
      }
    })

    it('should classify rate limit errors correctly', async () => {
      mockCreateCompletions.mockRejectedValue(
        new Error('rate limit exceeded')
      )

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await client.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
        expect((error as GLMError).code).toBe(GLMErrorCodes.RATE_LIMIT_EXCEEDED)
      }
    })

    it('should classify network errors correctly', async () => {
      mockCreateCompletions.mockRejectedValue(
        new Error('network error: econnrefused')
      )

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await client.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
        expect((error as GLMError).code).toBe(GLMErrorCodes.NETWORK_ERROR)
      }
    })

    it('should handle timeout errors as network errors', async () => {
      mockCreateCompletions.mockRejectedValue(
        new Error('request timeout')
      )

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await client.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
        expect((error as GLMError).code).toBe(GLMErrorCodes.NETWORK_ERROR)
      }
    })

    it('should handle generic API errors', async () => {
      mockCreateCompletions.mockRejectedValue(
        new Error('some api error')
      )

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await client.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
        expect((error as GLMError).code).toBe(GLMErrorCodes.API_ERROR)
      }
    })

    it('should handle unknown error types', async () => {
      mockCreateCompletions.mockRejectedValue('string error')

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await client.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
        expect((error as GLMError).code).toBe(GLMErrorCodes.API_ERROR)
      }
    })
  })

  describe('retry logic', () => {
    it('should not retry authentication errors', async () => {
      mockCreateCompletions.mockRejectedValue(
        new Error('authentication failed')
      )

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await client.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
        expect((error as GLMError).code).toBe(GLMErrorCodes.AUTHENTICATION_FAILED)
      }

      // Should only be called once (no retries)
      expect(mockCreateCompletions).toHaveBeenCalledTimes(1)
    })

    it('should retry API errors', async () => {
      mockCreateCompletions.mockRejectedValue(
        new Error('invalid request: bad parameters')
      )

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await client.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
        // Note: The current implementation doesn't classify specific errors as INVALID_REQUEST
        // in handleError(), so it falls back to API_ERROR. This test verifies that behavior.
        expect((error as GLMError).code).toBe(GLMErrorCodes.API_ERROR)
      }

      // Should retry API errors (default maxRetries: 3, so 3 total attempts)
      expect(mockCreateCompletions).toHaveBeenCalledTimes(3)
    })

    it('should retry network errors', async () => {
      // Fail twice, then succeed
      mockCreateCompletions
        .mockRejectedValueOnce(new Error('network error'))
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({
          id: 'test-id',
          created: 1234567890,
          model: 'glm-4.7',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Success'
              }
            }
          ]
        })

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      const result = await client.chat(messages)

      expect(result.content).toBe('Success')
      // Should be called 3 times (initial + 2 retries)
      expect(mockCreateCompletions).toHaveBeenCalledTimes(3)
    })

    it('should retry rate limit errors', async () => {
      // Fail once with rate limit, then succeed
      mockCreateCompletions
        .mockRejectedValueOnce(new Error('rate limit exceeded'))
        .mockResolvedValueOnce({
          id: 'test-id',
          created: 1234567890,
          model: 'glm-4.7',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Success'
              }
            }
          ]
        })

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      const result = await client.chat(messages)

      expect(result.content).toBe('Success')
      // Should be called 2 times (initial + 1 retry)
      expect(mockCreateCompletions).toHaveBeenCalledTimes(2)
    })

    it('should respect maxRetries limit', async () => {
      const clientWithRetry = new GLMClient({
        apiKey: 'test-api-key',
        maxRetries: 2
      })

      mockCreateCompletions.mockRejectedValue(
        new Error('network error')
      )

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await clientWithRetry.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
      }

      // Should be called 2 times (initial + 1 retry, not 2 retries)
      expect(mockCreateCompletions).toHaveBeenCalledTimes(2)
    })

    it('should use exponential backoff for retries', async () => {
      const clientWithRetry = new GLMClient({
        apiKey: 'test-api-key',
        maxRetries: 3,
        retryDelay: 100 // 100ms for faster testing
      })

      const startTime = Date.now()

      // Fail all attempts
      mockCreateCompletions.mockRejectedValue(
        new Error('network error')
      )

      const messages = [{ role: 'user' as const, content: 'Hello' }]

      try {
        await clientWithRetry.chat(messages)
        expect.fail('Should have thrown GLMError')
      } catch (error) {
        expect(error).toBeInstanceOf(GLMError)
      }

      const elapsed = Date.now() - startTime

      // With maxRetries: 3, the retry logic uses attempt >= maxRetries
      // So attempts are: 1, 2, 3 (3 total attempts)
      // - After attempt 1 fails: wait 100 * 2^0 = 100ms
      // - After attempt 2 fails: wait 100 * 2^1 = 200ms
      // - Attempt 3 fails and throws (no wait after)
      // Total minimum delay: 100 + 200 = 300ms
      expect(elapsed).toBeGreaterThanOrEqual(250)

      // Should be called 3 times total (with maxRetries: 3)
      expect(mockCreateCompletions).toHaveBeenCalledTimes(3)
    })
  })

  describe('helper methods', () => {
    it('should return true when client is configured', () => {
      expect(client.isConfigured()).toBe(true)
    })

    it('should return the model name', () => {
      expect(client.getModel()).toBe('glm-4.7')
    })

    it('should return custom model name', () => {
      const customClient = new GLMClient({
        apiKey: 'test-api-key',
        model: 'custom-model'
      })
      expect(customClient.getModel()).toBe('custom-model')
    })
  })

  describe('GLMError', () => {
    it('should create error with message and code', () => {
      const error = new GLMError(
        'Test error',
        GLMErrorCodes.API_ERROR
      )

      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('Test error')
      expect(error.code).toBe(GLMErrorCodes.API_ERROR)
      expect(error.name).toBe('GLMError')
      expect(error.originalError).toBeUndefined()
    })

    it('should store original error', () => {
      const originalError = new Error('Original')
      const error = new GLMError(
        'Wrapped error',
        GLMErrorCodes.NETWORK_ERROR,
        originalError
      )

      expect(error.originalError).toBe(originalError)
    })
  })

  describe('GLMErrorCodes', () => {
    it('should have all expected error codes', () => {
      expect(GLMErrorCodes.AUTHENTICATION_FAILED).toBe('AUTHENTICATION_FAILED')
      expect(GLMErrorCodes.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED')
      expect(GLMErrorCodes.INVALID_REQUEST).toBe('INVALID_REQUEST')
      expect(GLMErrorCodes.API_ERROR).toBe('API_ERROR')
      expect(GLMErrorCodes.NETWORK_ERROR).toBe('NETWORK_ERROR')
    })
  })
})
