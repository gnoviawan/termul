# Code Reviewer GitHub Action

Automated code review for Pull Requests using GLM 4.7 (Zhipu AI). This action analyzes your code changes and provides actionable feedback directly on your PRs, similar to tools like Coderabbit.

![GitHub Action](https://img.shields.io/badge/GitHub-Action-blue)
![GLM 4.7](https://img.shields.io/badge/GLM-4.7-purple)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)

## Features

- **Automated Code Analysis** - Reviews Pull Requests automatically when opened or updated
- **GLM 4.7 Integration** - Uses Zhipu AI's advanced GLM 4.7 model for intelligent code review
- **Multi-Language Support** - Supports 30+ programming languages
- **Smart Diff Parsing** - Analyzes only changed code, not entire files
- **Severity Levels** - Reports issues with critical, high, medium, and low severity
- **Binary File Detection** - Automatically skips binary files (images, PDFs, etc.)
- **Large PR Handling** - Intelligently handles PRs with many files
- **Merge Conflict Detection** - Detects and reports merge conflicts
- **Configurable** - Customize severity, file limits, token limits, and exclusion patterns
- **Markdown Comments** - Posts beautifully formatted review comments to your PRs

## Prerequisites

Before using this action, you need:

1. **GLM API Key** - Get your API key from [Zhipu AI (BigModel)](https://bigmodel.cn/)
2. **GitHub Repository** - This action runs on GitHub-hosted repositories
3. **GitHub Secrets** - Store your API key securely in repository secrets

## Setup

### 1. Get GLM API Key

1. Visit [https://bigmodel.cn/](https://bigmodel.cn/)
2. Sign up or log in
3. Navigate to API Keys section
4. Generate a new API key
5. Copy the key for the next step

### 2. Configure GitHub Secret

1. Go to your repository on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `GLM_API_KEY`
5. Value: Paste your API key from Zhipu AI
6. Click **Add secret**

### 3. Create Workflow File

Create `.github/workflows/code-review.yml` in your repository:

```yaml
name: Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main, develop, dev]

permissions:
  pull-requests: write
  issues: write
  contents: read

jobs:
  code-review:
    name: Automated Code Review
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run Code Review
        uses: ./.github/actions/code-reviewer
        with:
          glm-api-key: ${{ secrets.GLM_API_KEY }}
          model: glm-4.7
```

## Usage

### Basic Usage

The simplest configuration uses all defaults:

```yaml
- name: Run Code Review
  uses: ./.github/actions/code-reviewer
  with:
    glm-api-key: ${{ secrets.GLM_API_KEY }}
```

### Advanced Configuration

Customize the action behavior with optional inputs:

```yaml
- name: Run Code Review
  uses: ./.github/actions/code-reviewer
  with:
    glm-api-key: ${{ secrets.GLM_API_KEY }}
    model: glm-4.7
    max-files: 20
    max-tokens: 16000
    severity: warning
    exclude-patterns: '*.min.js,*.lock,package-lock.json,yarn.lock,dist/,build/'
```

## Configuration

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `glm-api-key` | Yes | - | API key for Zhipu AI GLM 4.7 API |
| `model` | No | `glm-4.7` | GLM model to use for code review |
| `max-files` | No | `10` | Maximum number of files to review in a single PR |
| `max-tokens` | No | `16000` | Maximum tokens to use per API call |
| `severity` | No | `warning` | Minimum severity level for issues to report (`error`, `warning`, `info`) |
| `exclude-patterns` | No | `*.min.js,*.lock,package-lock.json,yarn.lock` | Comma-separated list of file patterns to exclude |

### Severity Levels

The action reports issues at four severity levels:

- **🔴 Critical** - Security vulnerabilities, major bugs, data loss risks
- **🟠 High** - Performance issues, potential bugs, anti-patterns
- **🟡 Medium** - Code quality, maintainability, style issues
- **🔵 Low** - Minor suggestions, nice-to-have improvements

The `severity` input controls which issues are reported:

- `error` - Only critical and high severity issues
- `warning` (default) - Critical, high, and medium severity issues
- `info` - All issues including low severity

### Outputs

| Output | Description |
|--------|-------------|
| `review-completed` | Whether the code review was completed successfully (`true`/`false`) |
| `issues-found` | Number of issues found during review |
| `review-summary` | Summary of the code review results |

### Example: Using Outputs

```yaml
- name: Run Code Review
  id: review
  uses: ./.github/actions/code-reviewer
  with:
    glm-api-key: ${{ secrets.GLM_API_KEY }}

- name: Check Results
  if: steps.review.outputs.issues-found > 0
  run: |
    echo "Found ${{ steps.review.outputs.issues-found }} issues"
    echo "Summary: ${{ steps.review.outputs.review-summary }}"
```

## What Gets Reviewed

The action analyzes:

✅ **Supported Files**
- Source code files (`.ts`, `.js`, `.tsx`, `.jsx`, `.py`, `.java`, `.go`, `.rs`, `.c`, `.cpp`, etc.)
- Markup files (`.md`, `.html`, `.css`, `.scss`, `.json`, `.yaml`, etc.)
- Configuration files (`.env.example`, Dockerfile, etc.)

❌ **Automatically Excluded**
- Binary files (images, PDFs, executables)
- Minified files (`.min.js`, `.min.css`)
- Lock files (`package-lock.json`, `yarn.lock`, `Gemfile.lock`)
- Files matching `exclude-patterns`

### Supported Languages

The action detects and provides language-specific feedback for:

**Web/Scripting**
- TypeScript, JavaScript, JSX, TSX
- Python, Ruby, PHP
- HTML, CSS, SCSS, LESS

**Systems/Compiled**
- Go, Rust, C, C++
- C#, Java, Kotlin, Swift
- Dart, Haskell, Lua

**Data/Config**
- JSON, YAML, TOML
- SQL, GraphQL
- Dockerfile, Makefile

And many more!

## Review Comments

The action posts comments in a structured format:

```markdown
## 🔍 Code Review Report

### Summary
Reviewed **5 files** with **127 changes**. Found **8 issues**.

### 📊 Issues by Severity
| Severity | Count |
|----------|-------|
| 🔴 Critical | 1 |
| 🟠 High | 2 |
| 🟡 Medium | 4 |
| 🔵 Low | 1 |

### 🔴 Critical Issues

#### `src/utils/auth.ts:45`

**Issue:** Potential security vulnerability - hardcoded credentials

**Reason:** Hardcoding API keys in source code is a security risk. If this code is exposed publicly, your credentials are compromised.

**Suggestion:** Move credentials to environment variables:
```typescript
const apiKey = process.env.API_KEY;
if (!apiKey) {
  throw new Error('API_KEY environment variable is required');
}
```

### 🟠 High Issues

#### `src/components/User.tsx:123`

**Issue:** Performance: Missing React.memo optimization

**Reason:** This component re-renders unnecessarily on every parent update...

[... more issues ...]

### ✅ Positive Feedback
- Great error handling in `src/services/api.ts`
- Clean component structure in `src/pages/Dashboard.tsx`
```

## Troubleshooting

### Action fails with "Authentication Failed"

**Problem:** Invalid GLM API key
**Solution:**
1. Verify your API key at [https://bigmodel.cn/](https://bigmodel.cn/)
2. Check that `GLM_API_KEY` secret is correctly set in repository settings
3. Ensure the API key hasn't expired or been revoked

### Action doesn't trigger on PR

**Problem:** Workflow conditions not met
**Solution:**
1. Verify the workflow file is in `.github/workflows/code-review.yml`
2. Check that PR targets configured branches (default: `main`, `develop`, `dev`)
3. Ensure workflow is enabled in repository Actions settings

### No review comments posted

**Problem:** Action ran successfully but no comments appeared
**Solution:**
1. Check Action logs for warnings about skipped files
2. Verify the action has `pull-requests: write` permission
3. Check if all files were excluded by `exclude-patterns`
4. Ensure PR has actual code changes (not just merge commits)

### "File too large" warning

**Problem:** A file exceeds token limits
**Solution:**
1. The action will skip the file and continue with others
2. Consider breaking large files into smaller modules
3. Add the file to `exclude-patterns` if it shouldn't be reviewed

### Rate limit errors

**Problem:** Too many API calls to GLM 4.7
**Solution:**
1. The action automatically implements exponential backoff
2. Reduce `max-files` to review fewer files per PR
3. Consider reviewing only changed files in critical paths

## Best Practices

### 1. Start Conservative

Begin with strict settings to reduce noise:

```yaml
severity: error
max-files: 5
exclude-patterns: '*.min.js,*.lock,package-lock.json,yarn.lock,test/,spec/,mocks/'
```

### 2. Gradually Expand

Once comfortable, expand coverage:

```yaml
severity: warning
max-files: 15
exclude-patterns: '*.min.js,*.lock,dist/,build/'
```

### 3. Use Branch Protection

Require code review to pass before merging:

1. Go to **Settings** → **Branches**
2. Add rule for your protected branch (e.g., `main`)
3. Check **Require status checks to pass before merging**
4. Add `code-review` job to required status checks

### 4. Combine with Other Checks

Use alongside linters and tests:

```yaml
jobs:
  lint-test:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
      - run: npm test

  code-review:
    needs: lint-test
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/code-reviewer
```

### 5. Monitor API Usage

GLM 4.7 API usage costs money based on tokens. Monitor:

```yaml
- name: Check API Usage
  run: |
    echo "Tokens used: ${{ steps.review.outputs.review-summary }}"
```

## Performance

### Typical Performance

- **Small PRs** (1-5 files): ~10-20 seconds
- **Medium PRs** (5-15 files): ~30-60 seconds
- **Large PRs** (15-50 files): ~1-3 minutes

### Optimization Tips

1. **Reduce max-files** - Only review critical files
2. **Use exclude-patterns** - Skip generated files, tests, mocks
3. **Increase severity** - Focus on critical/high issues only
4. **Enable concurrency** - Workflow already uses `concurrency` to cancel stale runs

## Security

### API Key Protection

- ✅ API key stored in GitHub Secrets (encrypted)
- ✅ Never logged in action output
- ✅ Only passed to GLM 4.7 API via HTTPS
- ✅ Automatically rotated if compromised

### Code Safety

- ✅ No code execution in your repository
- ✅ Read-only access to repository files
- ✅ Only writes PR comments (no code modifications)
- ✅ Bundled dependencies (no external npm calls during execution)

### Permissions

The action requires minimal GitHub permissions:

```yaml
permissions:
  pull-requests: write  # To post review comments
  issues: write         # PRs are issues in GitHub API
  contents: read        # To read repository files
```

## Contributing

Contributions are welcome! This action is part of the [Termul Manager](https://github.com/gnoviawan/termul) project.

### Development

```bash
# Clone the repository
git clone https://github.com/gnoviawan/termul.git
cd termul/.github/actions/code-reviewer

# Install dependencies
npm install

# Run tests
npm test

# Build the action
npm run build

# Run linter
npm run lint
```

### Project Structure

```
.github/actions/code-reviewer/
├── src/
│   ├── index.ts                # Main entry point
│   ├── glm-client.ts           # GLM 4.7 API client
│   ├── github-client.ts        # GitHub API wrapper
│   ├── diff-parser.ts          # Diff parsing logic
│   ├── prompts.ts              # Review prompt generation
│   ├── comment-formatter.ts    # Comment formatting
│   └── review-orchestrator.ts  # Main review orchestration
├── tests/                      # Unit and integration tests
├── dist/                       # Bundled output (generated)
├── action.yml                  # Action metadata
├── package.json
├── tsconfig.json
└── README.md                   # This file
```

## License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/gnoviawan/termul/issues)
- **Discussions**: [GitHub Discussions](https://github.com/gnoviawan/termul/discussions)
- **GLM API Docs**: [https://open.bigmodel.cn/](https://open.bigmodel.cn/)

## Acknowledgments

- [GLM 4.7](https://open.bigmodel.cn/) - Advanced language model for code analysis
- [Coderabbit](https://coderabbit.ai/) - Inspiration for automated PR review workflows
- [GitHub Actions](https://github.com/features/actions) - CI/CD platform
