/**
 * Review orchestrator for coordinating the code review workflow
 * Manages the complete review process from PR analysis to comment posting
 */

import { GLMClient, GLMError } from './glm-client.js'
import { GitHubClient, GitHubError } from './github-client.js'
import { parseDiff, filterDiffs, getDiffSummary, DiffParserError } from './diff-parser.js'
import { generateReviewPrompt, CodeChangeContext } from './prompts.js'
import {
  formatComment,
  formatNoIssuesComment,
  truncateComment,
  ReviewFeedback,
  ReviewIssue
} from './comment-formatter.js'

/**
 * Configuration options for the review orchestrator
 */
export interface ReviewOrchestratorOptions {
  glmApiKey: string
  githubToken: string
  model?: string
  maxFiles?: number
  maxTokens?: number
  severity?: 'low' | 'medium' | 'high' | 'critical'
  excludePatterns?: string[]
  includeSecurity?: boolean
  includePerformance?: boolean
  includeBestPractices?: boolean
}

/**
 * Result of a review operation
 */
export interface ReviewResult {
  success: boolean
  issuesFound: number
  summary: string
  filesReviewed: number
  totalFiles: number
  filesSkipped?: number
  binaryFilesSkipped?: number
  largePRWarning?: boolean
  error?: string
}

/**
 * Parsed GLM response for review feedback
 */
interface ParsedGLMResponse {
  summary: string
  issues: ReviewIssue[]
  security?: string[]
  performance?: string[]
  bestPractices?: string[]
  positiveFeedback?: string[]
}

/**
 * Orchestrate the complete code review workflow for a Pull Request
 *
 * This function:
 * 1. Retrieves PR details and changed files
 * 2. Filters and parses diffs
 * 3. Generates review prompts
 * 4. Calls GLM 4.7 API for analysis
 * 5. Formats and posts review comments
 *
 * @param pullNumber - Pull request number
 * @param options - Review configuration options
 * @returns Promise resolving to review result
 */
export async function reviewPullRequest(
  pullNumber: number,
  options: ReviewOrchestratorOptions
): Promise<ReviewResult> {
  const {
    glmApiKey,
    githubToken,
    model = 'glm-4.7',
    maxFiles = 10,
    maxTokens = 4000,
    severity = 'medium',
    excludePatterns = [],
    includeSecurity = true,
    includePerformance = true,
    includeBestPractices = true
  } = options

  // Initialize clients
  const glmClient = new GLMClient({
    apiKey: glmApiKey,
    model,
    timeout: 30000,
    maxRetries: 3,
    retryDelay: 1000
  })

  const githubClient = new GitHubClient({
    token: githubToken
  })

  try {
    // Step 1: Get PR details
    const pr = await githubClient.getPR(pullNumber)

    // Step 2: Get list of changed files
    const files = await githubClient.listFiles(pullNumber)

    if (files.length === 0) {
      return {
        success: true,
        issuesFound: 0,
        summary: 'No files changed in this PR',
        filesReviewed: 0,
        totalFiles: 0
      }
    }

    // Step 3: Filter files and parse diffs
    const filterResult = await filterAndParseFiles(
      files,
      githubClient,
      pullNumber,
      maxFiles,
      excludePatterns
    )

    if (filterResult.reviewFiles.length === 0) {
      return {
        success: true,
        issuesFound: 0,
        summary: 'No reviewable files after filtering (binary files, excluded patterns, or empty diffs)',
        filesReviewed: 0,
        totalFiles: files.length,
        filesSkipped: filterResult.filesSkipped,
        binaryFilesSkipped: filterResult.binaryFilesSkipped
      }
    }

    // Check if this is a large PR (files were skipped due to limit)
    const isLargePR = filterResult.filesSkipped > 0 || filterResult.binaryFilesSkipped > 0

    // Step 4: Generate review prompt
    const codeChanges: CodeChangeContext[] = filterResult.reviewFiles.map((file) => ({
      filePath: file.filePath,
      diff: file.patch || '',
      language: file.language
    }))

    const prompt = generateReviewPrompt(codeChanges, {
      severity,
      includeSecurity,
      includePerformance,
      includeBestPractices,
      maxSuggestions: 20
    })

    // Step 5: Call GLM API
    const glmResponse = await glmClient.prompt(prompt, undefined, maxTokens)

    // Step 6: Parse GLM response
    const feedback = parseGLMResponse(glmResponse.content)

    // Step 7: Format and post comment
    const commentBody =
      feedback.issues.length > 0
        ? formatComment(feedback, {
            includeSummary: true,
            includePositiveFeedback: true,
            groupBySeverity: true,
            includeLineNumbers: true
          })
        : formatNoIssuesComment(feedback.summary, feedback.positiveFeedback)

    // Truncate if needed
    const truncatedComment = truncateComment(commentBody)

    // Post the review comment
    await githubClient.postComment(pullNumber, truncatedComment)

    // Calculate total issues
    const issuesFound = feedback.issues.length

    return {
      success: true,
      issuesFound,
      summary: feedback.summary,
      filesReviewed: filterResult.reviewFiles.length,
      totalFiles: files.length,
      filesSkipped: filterResult.filesSkipped,
      binaryFilesSkipped: filterResult.binaryFilesSkipped,
      largePRWarning: isLargePR
    }
  } catch (error) {
    return handleError(error, pullNumber, githubClient)
  }
}

/**
 * Filter and parse files for review
 *
 * @param files - Array of changed files from PR
 * @param githubClient - GitHub API client
 * @param pullNumber - Pull request number
 * @param maxFiles - Maximum number of files to review
 * @param excludePatterns - File patterns to exclude
 * @returns Promise resolving to filtered and parsed files with statistics
 */
async function filterAndParseFiles(
  files: Array<{
    filename: string
    status: string
    patch: string | null | undefined
  }>,
  githubClient: GitHubClient,
  pullNumber: number,
  maxFiles: number,
  excludePatterns: string[]
): Promise<{
  reviewFiles: Array<{
    filePath: string
    patch: string | null | undefined
    language?: string
  }>
  filesSkipped: number
  binaryFilesSkipped: number
}>
{
  const reviewFiles: Array<{
    filePath: string
    patch: string | null | undefined
    language?: string
  }> = []

  let filesSkipped = 0
  let binaryFilesSkipped = 0

  // Sort files by status (prioritize added/modified)
  const sortedFiles = [...files].sort((a, b) => {
    const statusPriority = { added: 0, modified: 1, renamed: 2, removed: 3 }
    const aPriority = statusPriority[a.status as keyof typeof statusPriority] ?? 4
    const bPriority = statusPriority[b.status as keyof typeof statusPriority] ?? 4
    return aPriority - bPriority
  })

  for (const file of sortedFiles) {
    // Stop if we've reached the max files limit
    if (reviewFiles.length >= maxFiles) {
      // Count remaining files as skipped
      filesSkipped += sortedFiles.length - sortedFiles.indexOf(file)
      break
    }

    try {
      // Skip deleted files
      if (file.status === 'removed' || !file.patch || file.patch.trim().length === 0) {
        filesSkipped++
        continue
      }

      // Skip if file matches exclude patterns
      if (shouldExcludeFile(file.filename, excludePatterns)) {
        filesSkipped++
        continue
      }

      // Parse the diff
      const parsedDiff = parseDiff(file.patch, file.filename, {
        excludePatterns,
        includeBinary: false
      })

      // Skip if parsing failed or file is binary
      if (!parsedDiff) {
        filesSkipped++
        continue
      }

      if (parsedDiff.isBinary) {
        binaryFilesSkipped++
        filesSkipped++
        continue
      }

      // Add to review list
      reviewFiles.push({
        filePath: file.filename,
        patch: file.patch,
        language: parsedDiff.language
      })
    } catch (error) {
      // Log error but continue processing other files
      if (error instanceof DiffParserError) {
        // Track specific error types
        if (error.code === 'BINARY_FILE') {
          binaryFilesSkipped++
        }
        filesSkipped++
      }
    }
  }

  return {
    reviewFiles,
    filesSkipped,
    binaryFilesSkipped
  }
}

/**
 * Check if a file should be excluded based on patterns
 *
 * @param filePath - Path to the file
 * @param excludePatterns - Patterns to exclude
 * @returns true if file should be excluded
 */
function shouldExcludeFile(filePath: string, excludePatterns: string[]): boolean {
  if (excludePatterns.length === 0) {
    return false
  }

  const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/')

  return excludePatterns.some((pattern) => {
    const normalizedPattern = pattern.toLowerCase().trim()
    if (normalizedPattern.includes('*')) {
      const regex = new RegExp(
        '^' + normalizedPattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      )
      return regex.test(normalizedPath)
    }
    return normalizedPath.endsWith(normalizedPattern) || normalizedPath.includes(normalizedPattern)
  })
}

/**
 * Parse GLM API response into structured review feedback
 *
 * @param content - Response content from GLM API
 * @returns Parsed review feedback
 */
function parseGLMResponse(content: string): ParsedGLMResponse {
  const result: ParsedGLMResponse = {
    summary: '',
    issues: [],
    security: [],
    performance: [],
    bestPractices: [],
    positiveFeedback: []
  }

  // Try to extract structured information from the response
  const lines = content.split('\n')
  let currentSection: string | null = null
  let currentIssue: Partial<ReviewIssue> | null = null

  for (const line of lines) {
    const trimmedLine = line.trim()

    // Detect sections
    if (trimmedLine.toLowerCase().includes('review summary') || trimmedLine.toLowerCase().includes('summary')) {
      currentSection = 'summary'
      continue
    } else if (
      trimmedLine.toLowerCase().includes('issues found') ||
      trimmedLine.toLowerCase().includes('security considerations')
    ) {
      currentSection = 'security'
      continue
    } else if (trimmedLine.toLowerCase().includes('performance considerations')) {
      currentSection = 'performance'
      continue
    } else if (trimmedLine.toLowerCase().includes('best practices')) {
      currentSection = 'bestPractices'
      continue
    } else if (trimmedLine.toLowerCase().includes('positive feedback') || trimmedLine.toLowerCase().includes('what was done well')) {
      currentSection = 'positiveFeedback'
      continue
    }

    // Parse content based on current section
    if (currentSection === 'summary' && trimmedLine && !trimmedLine.startsWith('#')) {
      result.summary += (result.summary ? ' ' : '') + trimmedLine
    } else if (currentSection === 'security' && trimmedLine.startsWith('-')) {
      const item = trimmedLine.replace(/^-\s*/, '').trim()
      if (item) result.security?.push(item)
    } else if (currentSection === 'performance' && trimmedLine.startsWith('-')) {
      const item = trimmedLine.replace(/^-\s*/, '').trim()
      if (item) result.performance?.push(item)
    } else if (currentSection === 'bestPractices' && trimmedLine.startsWith('-')) {
      const item = trimmedLine.replace(/^-\s*/, '').trim()
      if (item) result.bestPractices?.push(item)
    } else if (currentSection === 'positiveFeedback' && trimmedLine.startsWith('-')) {
      const item = trimmedLine.replace(/^-\s*/, '').trim()
      if (item) result.positiveFeedback?.push(item)
    }

    // Parse issues (look for severity markers)
    const severityMatch = trimmedLine.match(/\*\*Severity:\*\*\s*(critical|high|medium|low)/i)
    if (severityMatch) {
      // Save previous issue if exists
      if (currentIssue && currentIssue.issue && currentIssue.suggestion) {
        result.issues.push(currentIssue as ReviewIssue)
      }

      // Start new issue
      currentIssue = {
        severity: severityMatch[1].toLowerCase() as ReviewIssue['severity']
      }
    }

    // Parse issue fields
    if (currentIssue) {
      if (trimmedLine.toLowerCase().includes('**location:**')) {
        const locationMatch = trimmedLine.match(/\`([^:]+):?(\d+)?\`/)
        if (locationMatch) {
          currentIssue.file = locationMatch[1]
          currentIssue.line = locationMatch[2] ? parseInt(locationMatch[2], 10) : undefined
        }
      } else if (trimmedLine.toLowerCase().includes('**issue:**')) {
        currentIssue.issue = trimmedLine.replace(/\*\*Issue:\*\*\s*/i, '').trim()
      } else if (trimmedLine.toLowerCase().includes('**suggestion:**')) {
        currentIssue.suggestion = trimmedLine.replace(/\*\*Suggestion:\*\*\s*/i, '').trim()
      } else if (trimmedLine.toLowerCase().includes('**reason:**') || trimmedLine.toLowerCase().includes('**why:**')) {
        currentIssue.reason = trimmedLine
          .replace(/\*\*(Reason|Why):\*\*\s*/i, '')
          .trim()
      }
    }
  }

  // Add last issue if exists
  if (currentIssue && currentIssue.issue && currentIssue.suggestion) {
    result.issues.push(currentIssue as ReviewIssue)
  }

  // If no summary was extracted, use the first paragraph
  if (!result.summary) {
    const paragraphs = content.split('\n\n').filter((p) => p.trim() && !p.trim().startsWith('#'))
    if (paragraphs.length > 0) {
      result.summary = paragraphs[0].trim()
    } else {
      result.summary = 'Code review completed'
    }
  }

  return result
}

/**
 * Handle errors from the review process
 *
 * @param error - Error that occurred
 * @param pullNumber - Pull request number
 * @param githubClient - GitHub client for posting error comments
 * @returns Review result with error information
 */
function handleError(error: unknown, pullNumber: number, githubClient: GitHubClient): ReviewResult {
  let errorMessage = 'Unknown error occurred'
  let shouldPostComment = true

  if (error instanceof GLMError) {
    errorMessage = `GLM API Error: ${error.message} (${error.code})`

    // Don't post comment for authentication errors (likely invalid API key)
    if (error.code === 'AUTHENTICATION_FAILED') {
      shouldPostComment = false
    }
  } else if (error instanceof GitHubError) {
    errorMessage = `GitHub API Error: ${error.message} (${error.code})`

    // Don't post comment for authentication errors
    if (error.code === 'AUTHENTICATION_FAILED') {
      shouldPostComment = false
    }
  } else if (error instanceof Error) {
    errorMessage = error.message
  }

  // Try to post error comment
  if (shouldPostComment) {
    try {
      const errorComment = `<!-- code-reviewer-comment -->

## ⚠️ Code Review Error

An error occurred during the code review process:

\`\`\`
${errorMessage}
\`\`\`

Please check the workflow logs for more details.

<!-- /code-reviewer-comment -->`

      githubClient.postComment(pullNumber, errorComment)
    } catch {
      // Ignore errors when posting error comments
    }
  }

  return {
    success: false,
    issuesFound: 0,
    summary: errorMessage,
    filesReviewed: 0,
    totalFiles: 0,
    error: errorMessage
  }
}
