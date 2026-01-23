import * as github from '@actions/github'
import { RequestError } from '@octokit/request-error'

/**
 * Pull request information from GitHub API
 */
export interface PullRequest {
  number: number
  title: string
  body: string | null
  headSha: string
  baseRef: string
  headRef: string
  author: string
  createdAt: Date
  updatedAt: Date
  changedFiles: number
  additions: number
  deletions: number
}

/**
 * File changed in a pull request
 */
export interface PullRequestFile {
  sha: string
  filename: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  additions: number
  deletions: number
  changes: number
  patch: string | null | undefined
  previousFilename?: string
}

/**
 * Comment to post on a pull request
 */
export interface ReviewComment {
  path: string
  line?: number
  startLine?: number
  body: string
}

/**
 * Review to post on a pull request
 */
export interface Review {
  body: string
  comments: ReviewComment[]
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
}

/**
 * Error types for GitHub API operations
 */
export const GitHubErrorCodes = {
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  API_ERROR: 'API_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR'
} as const

export type GitHubErrorCode = (typeof GitHubErrorCodes)[keyof typeof GitHubErrorCodes]

/**
 * Custom error class for GitHub API operations
 */
export class GitHubError extends Error {
  constructor(
    message: string,
    public code: GitHubErrorCode,
    public originalError?: unknown
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/**
 * Configuration options for GitHub client
 */
export interface GitHubClientOptions {
  token: string
  owner?: string
  repo?: string
  baseUrl?: string
}

/**
 * GitHub API client wrapper for Pull Request operations
 * Provides a typed interface to GitHub's PR API for code review
 */
export class GitHubClient {
  private client: ReturnType<typeof github.getOctokit>
  private owner: string
  private repo: string

  /**
   * Create a new GitHub client instance
   *
   * @param options - Client configuration options
   */
  constructor(options: GitHubClientOptions) {
    if (!options.token || options.token.trim().length === 0) {
      throw new GitHubError(
        'GitHub token is required',
        GitHubErrorCodes.AUTHENTICATION_FAILED
      )
    }

    this.client = github.getOctokit(options.token, {
      baseUrl: options.baseUrl
    })

    // Get owner and repo from options or GitHub context
    const context = github.context
    this.owner = options.owner || context.repo.owner
    this.repo = options.repo || context.repo.repo

    if (!this.owner || !this.repo) {
      throw new GitHubError(
        'Owner and repository are required',
        GitHubErrorCodes.VALIDATION_FAILED
      )
    }
  }

  /**
   * Get pull request details
   *
   * @param pullNumber - Pull request number
   * @returns Promise resolving to pull request information
   * @throws GitHubError if the request fails
   */
  async getPR(pullNumber: number): Promise<PullRequest> {
    try {
      const { data: pr } = await this.client.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber
      })

      return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        headRef: pr.head.ref,
        author: pr.user?.login || 'unknown',
        createdAt: new Date(pr.created_at),
        updatedAt: new Date(pr.updated_at),
        changedFiles: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions
      }
    } catch (error) {
      throw this.handleError(error)
    }
  }

  /**
   * List all files changed in a pull request
   *
   * @param pullNumber - Pull request number
   * @returns Promise resolving to array of changed files
   * @throws GitHubError if the request fails
   */
  async listFiles(pullNumber: number): Promise<PullRequestFile[]> {
    try {
      const { data: files } = await this.client.rest.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
        per_page: 100
      })

      return files.map((file) => ({
        sha: file.sha,
        filename: file.filename,
        status: file.status as PullRequestFile['status'],
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch,
        previousFilename: file.previous_filename || undefined
      }))
    } catch (error) {
      throw this.handleError(error)
    }
  }

  /**
   * Get the diff for a specific file in a pull request
   *
   * @param pullNumber - Pull request number
   * @param filename - Name of the file
   * @returns Promise resolving to file diff patch or null
   * @throws GitHubError if the request fails
   */
  async getFileDiff(pullNumber: number, filename: string): Promise<string | null | undefined> {
    try {
      const files = await this.listFiles(pullNumber)
      const file = files.find((f) => f.filename === filename)

      if (!file) {
        throw new GitHubError(
          `File ${filename} not found in PR #${pullNumber}`,
          GitHubErrorCodes.NOT_FOUND
        )
      }

      return file.patch
    } catch (error) {
      throw this.handleError(error)
    }
  }

  /**
   * Post a review comment on a pull request
   *
   * @param pullNumber - Pull request number
   * @param review - Review to post
   * @returns Promise resolving when the comment is posted
   * @throws GitHubError if the request fails
   */
  async postReview(pullNumber: number, review: Review): Promise<void> {
    try {
      await this.client.rest.pulls.createReview({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
        body: review.body,
        comments: review.comments,
        event: review.event
      })
    } catch (error) {
      throw this.handleError(error)
    }
  }

  /**
   * Post a general comment on a pull request
   *
   * @param pullNumber - Pull request number
   * @param body - Comment body
   * @returns Promise resolving when the comment is posted
   * @throws GitHubError if the request fails
   */
  async postComment(pullNumber: number, body: string): Promise<void> {
    try {
      await this.client.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: pullNumber,
        body
      })
    } catch (error) {
      throw this.handleError(error)
    }
  }

  /**
   * Post a review comment on a specific line of a file
   *
   * @param pullNumber - Pull request number
   * @param comment - Comment to post
   * @param commitId - SHA of the commit to comment on
   * @returns Promise resolving when the comment is posted
   * @throws GitHubError if the request fails
   */
  async postLineComment(
    pullNumber: number,
    comment: ReviewComment,
    commitId: string
  ): Promise<void> {
    try {
      await this.client.rest.pulls.createReviewComment({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
        commit_id: commitId,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        start_line: comment.startLine
      })
    } catch (error) {
      throw this.handleError(error)
    }
  }

  /**
   * Get the content of a file from the repository
   *
   * @param path - Path to the file
   * @param ref - Git reference (branch, tag, or commit SHA)
   * @returns Promise resolving to file content
   * @throws GitHubError if the request fails
   */
  async getFileContent(path: string, ref?: string): Promise<string> {
    try {
      const { data: file } = await this.client.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref
      })

      if ('content' in file && file.type === 'file') {
        // Base64 decode the content
        return Buffer.from(file.content, 'base64').toString('utf-8')
      }

      throw new GitHubError(
        `Path ${path} is not a file`,
        GitHubErrorCodes.VALIDATION_FAILED
      )
    } catch (error) {
      throw this.handleError(error)
    }
  }

  /**
   * Convert API errors to GitHubError instances
   *
   * @param error - The error from the API call
   * @returns GitHubError instance
   */
  private handleError(error: unknown): GitHubError {
    if (error instanceof GitHubError) {
      return error
    }

    // Handle Octokit RequestError
    if (error instanceof RequestError) {
      const status = error.status

      // Authentication errors
      if (status === 401 || status === 403) {
        return new GitHubError(
          'Authentication failed. Check your GitHub token.',
          GitHubErrorCodes.AUTHENTICATION_FAILED,
          error
        )
      }

      // Rate limit errors
      if (status === 429 || (status === 403 && error.headers?.['x-ratelimit-remaining'] === '0')) {
        return new GitHubError(
          'GitHub API rate limit exceeded. Please try again later.',
          GitHubErrorCodes.RATE_LIMIT_EXCEEDED,
          error
        )
      }

      // Not found errors
      if (status === 404) {
        return new GitHubError(
          'Resource not found. Check the owner, repo, and PR number.',
          GitHubErrorCodes.NOT_FOUND,
          error
        )
      }

      // Validation errors
      if (status === 422) {
        return new GitHubError(
          `Validation failed: ${error.message}`,
          GitHubErrorCodes.VALIDATION_FAILED,
          error
        )
      }

      // Generic API error
      return new GitHubError(
        `GitHub API error: ${error.message}`,
        GitHubErrorCodes.API_ERROR,
        error
      )
    }

    // Handle standard Error
    if (error instanceof Error) {
      const message = error.message.toLowerCase()

      // Check for network errors
      if (
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('econnrefused') ||
        message.includes('enotfound')
      ) {
        return new GitHubError(
          'Network error: Unable to reach GitHub API',
          GitHubErrorCodes.NETWORK_ERROR,
          error
        )
      }

      // Generic error
      return new GitHubError(
        `Error: ${error.message}`,
        GitHubErrorCodes.API_ERROR,
        error
      )
    }

    // Unknown error type
    return new GitHubError(
      'Unknown error occurred',
      GitHubErrorCodes.API_ERROR,
      error
    )
  }

  /**
   * Validate that the client is properly configured
   *
   * @returns true if client is ready to use
   */
  isConfigured(): boolean {
    return this.client !== undefined && this.owner !== undefined && this.repo !== undefined
  }

  /**
   * Get the repository owner
   *
   * @returns Repository owner
   */
  getOwner(): string {
    return this.owner
  }

  /**
   * Get the repository name
   *
   * @returns Repository name
   */
  getRepo(): string {
    return this.repo
  }
}
