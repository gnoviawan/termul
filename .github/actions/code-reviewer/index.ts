import * as core from '@actions/core'
import * as github from '@actions/github'

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

    // TODO: Implement review logic in subsequent subtasks
    core.info('Code review logic will be implemented in next phases')

    // Set outputs
    core.setOutput('review-completed', 'true')
    core.setOutput('issues-found', '0')
    core.setOutput('review-summary', 'Review logic not yet implemented')
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
