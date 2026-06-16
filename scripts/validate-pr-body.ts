/**
 * Validates a pull request description against the repo PR template.
 *
 * A git pre-commit/pre-push hook cannot see the PR body — that text only
 * exists on GitHub. This runs as a required CI check on `pull_request`
 * events so untemplated PRs (from humans OR CLI agents) are blocked at the
 * merge gate, not merely discouraged in CLAUDE.md / AGENTS.md.
 *
 * Usage (CI):
 *   PR_BODY="$PR_BODY" PR_TITLE="$PR_TITLE" bun run scripts/validate-pr-body.ts
 */

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

// HTML comments in the template are guidance, not content. Strip them so an
// untouched template's placeholder text doesn't read as "filled in".
//
// Strip repeatedly until the string stops changing: a single pass over
// `<!--[\s\S]*?-->` can leave a fresh `<!--` behind on crafted/overlapping
// input (e.g. `<!--<!---->-->`), which is the incomplete-sanitization class
// CodeQL flags (js/incomplete-multi-character-sanitization).
function stripComments(body: string): string {
  let previous: string
  let current = body
  do {
    previous = current
    current = current.replace(/<!--[\s\S]*?-->/g, '')
  } while (current !== previous)
  return current
}

function sectionBody(body: string, heading: string): string | null {
  // Find "## <heading>" and return everything up to the next "## " heading
  // (any level-2 heading) or the end of the body. Index-based to avoid the
  // \Z end-of-string anchor, which JavaScript regex does not support.
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headingRe = new RegExp(`^##\\s+${escaped}\\s*$`, 'm')
  const headingMatch = body.match(headingRe)
  if (headingMatch?.index === undefined) {
    return null
  }

  const start = headingMatch.index + headingMatch[0].length
  const rest = body.slice(start)
  const nextHeading = rest.match(/^##\s/m)
  const end = nextHeading?.index === undefined ? rest.length : nextHeading.index
  return rest.slice(0, end)
}

// A section is "empty" when, after removing comments, list bullets with no
// text (`-`), and whitespace, nothing meaningful remains.
function isSectionEmpty(content: string): boolean {
  const cleaned = stripComments(content)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Drop bare bullets / empty list items left from the template.
    .filter((line) => line !== '-' && line !== '*' && line !== '- ' && line !== '*')
  return cleaned.length === 0
}

export function validatePrBody(rawBody: string | undefined | null): ValidationResult {
  const errors: string[] = []
  const body = (rawBody ?? '').replace(/\r\n/g, '\n')

  if (body.trim().length === 0) {
    return {
      ok: false,
      errors: [
        'PR description is empty. Fill in the PR template at .github/PULL_REQUEST_TEMPLATE.md.'
      ]
    }
  }

  // 1. Summary must explain what + why.
  const summary = sectionBody(body, 'Summary')
  if (summary === null) {
    errors.push('Missing "## Summary" section — restore it from the PR template.')
  } else if (isSectionEmpty(summary)) {
    errors.push('"## Summary" is empty. Describe what this PR does and WHY.')
  }

  // 2. Related Issue: require a real "Closes #<n>" or an explicit "no issue" note.
  const related = sectionBody(body, 'Related Issue')
  if (related === null) {
    errors.push('Missing "## Related Issue" section — restore it from the PR template.')
  } else {
    const cleaned = stripComments(related)
    const linksIssue = /(?:closes|fixes|resolves|refs?)\s+#\d+/i.test(cleaned)
    const explainsNoIssue = /no\s+(?:related\s+)?issue/i.test(cleaned)
    if (!linksIssue && !explainsNoIssue) {
      errors.push(
        '"## Related Issue" has no linked issue. Use "Closes #<number>" or explain why no issue exists.'
      )
    }
  }

  // 3. Type of Change: at least one checkbox ticked.
  const type = sectionBody(body, 'Type of Change')
  if (type === null) {
    errors.push('Missing "## Type of Change" section — restore it from the PR template.')
  } else if (!/- \[x\]/i.test(stripComments(type))) {
    errors.push('"## Type of Change" has no box checked. Mark the change type with [x].')
  }

  // 4. What Changed must list real content.
  const whatChanged = sectionBody(body, 'What Changed')
  if (whatChanged === null) {
    errors.push('Missing "## What Changed" section — restore it from the PR template.')
  } else if (isSectionEmpty(whatChanged)) {
    errors.push('"## What Changed" is empty. List the concrete changes.')
  }

  // 5. How It Was Tested: at least one box ticked (incl. "Not applicable").
  const tested = sectionBody(body, 'How It Was Tested')
  if (tested === null) {
    errors.push('Missing "## How It Was Tested" section — restore it from the PR template.')
  } else if (!/- \[x\]/i.test(stripComments(tested))) {
    errors.push(
      '"## How It Was Tested" has no box checked. Mark how you verified the change (or "Not applicable").'
    )
  }

  return { ok: errors.length === 0, errors }
}

// Build the markdown comment body posted on the PR when validation fails.
export function buildFailureComment(errors: string[]): string {
  const items = errors.map((e) => `- ${e}`).join('\n')
  return [
    '<!-- pr-body-validation -->',
    '## ❌ PR description does not satisfy the template',
    '',
    'This PR is missing required information from the PR template. Please edit the',
    'PR **description** (not a comment) and fill in every required section:',
    '',
    items,
    '',
    'Template: [`.github/PULL_REQUEST_TEMPLATE.md`](../blob/HEAD/.github/PULL_REQUEST_TEMPLATE.md)',
    '',
    'This check re-runs automatically when you edit the description.'
  ].join('\n')
}

// CLI entry — only runs when invoked directly, not when imported by tests.
if (import.meta.main) {
  const result = validatePrBody(process.env.PR_BODY)

  // Emit a markdown comment body for the workflow to post on failure.
  const commentPath = process.env.PR_BODY_COMMENT_FILE
  if (commentPath && !result.ok) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(commentPath, buildFailureComment(result.errors), 'utf8')
  }

  if (result.ok) {
    console.log('✅ PR description satisfies the template.')
    process.exit(0)
  }
  console.error('❌ PR description does not satisfy the template:\n')
  for (const err of result.errors) {
    console.error(`  • ${err}`)
  }
  console.error(
    '\nEdit the PR description and fill in every required section.' +
      '\nTemplate: .github/PULL_REQUEST_TEMPLATE.md'
  )
  process.exit(1)
}
