import * as core from '@actions/core'
import * as github from '@actions/github'
import { reviewPullRequest } from './review-orchestrator.js'

/**
 * Main entry point for the Code Reviewer GitHub Action.
 * This action performs automated code review on Pull Requests using the GLM 4.7 model.
 *
 * @returns Promise that resolves when the review is complete
 */
async function run(): Promise<void> {
  try {
    core.info('Starting Code Reviewer action...')

    // Get action inputs
    const glmApiKey = core.getInput('glm-api-key', { required: true })
    const model = core.getInput('model', { required: false }) || 'glm-4.7'
    const maxFiles = parseInt(
      core.getInput('max-files', { required: false }) || '10',
      10
    )
    const maxTokens = parseInt(
      core.getInput('max-tokens', { required: false }) || '4000',
      10
    )
    const severity = core.getInput('severity', { required: false }) || 'medium'
    const excludePatterns = core
      .getInput('exclude-patterns', { required: false })
      .split(',')
      .filter((pattern: string) => pattern.trim().length > 0)

    core.debug(`GLM Model: ${model}`)
    core.debug(`Max files to review: ${maxFiles}`)
    core.debug(`Max tokens: ${maxTokens}`)
    core.debug(`Severity level: ${severity}`)
    core.debug(`Exclude patterns: ${excludePatterns.join(', ')}`)

    // Get GitHub context
    const context = github.context
    const { repo, owner } = context.repo
    const pullNumber = context.issue.number

    if (!pullNumber) {
      core.warning('Not a pull request event, skipping review')
      return
    }

    core.info(`Reviewing PR #${pullNumber} in ${owner}/${repo}`)

    // Get GitHub token
    const githubToken =
      core.getInput('github-token', { required: false }) || process.env.GITHUB_TOKEN || ''

    if (!githubToken) {
      core.setFailed('GitHub token is required. Please provide it via github-token input.')
      return
    }

    // Perform the review
    const result = await reviewPullRequest(pullNumber, {
      glmApiKey,
      githubToken,
      model,
      maxFiles,
      maxTokens,
      severity: severity as 'low' | 'medium' | 'high' | 'critical',
      excludePatterns,
      includeSecurity: true,
      includePerformance: true,
      includeBestPractices: true
    })

    // Log results
    core.info(`Review completed: ${result.success ? 'SUCCESS' : 'FAILED'}`)
    core.info(`Files reviewed: ${result.filesReviewed}/${result.totalFiles}`)
    core.info(`Issues found: ${result.issuesFound}`)

    // Set outputs
    core.setOutput('review-completed', result.success ? 'true' : 'false')
    core.setOutput('issues-found', result.issuesFound.toString())
    core.setOutput('files-reviewed', result.filesReviewed.toString())
    core.setOutput('review-summary', result.summary)

    if (result.error) {
      core.setFailed(result.error)
    }
  } catch (error) {
    if (error instanceof Error) {
      core.error(`Error: ${error.message}`)
      core.setFailed(error.message)
    } else {
      core.error('Unknown error occurred')
      core.setFailed('Unknown error occurred')
    }
  }
}

// Execute the action
run()
