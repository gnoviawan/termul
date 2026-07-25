# Termul public documentation plan

## Purpose

Termul needs a public documentation site for users who want to install the app, create a workspace, and learn its main workflows.

The repository already contains detailed engineering documentation in `docs/`. That material is written for maintainers and contributors. The public site has a different audience and should focus on tasks users perform in the desktop app.

Public documentation will live in `website-docs/` and deploy to:

```text
https://docs.termul.dev
```

The landing page remains at:

```text
https://termul.dev
```

## Principles

Every page should follow these rules:

1. Document current, verified behavior.
2. Write for users before contributors.
3. Start with a task, not an implementation detail.
4. Keep one main task per page.
5. Use screenshots only when they make a step easier to understand.
6. Link to the latest release instead of hardcoding a release version.
7. Do not copy archived Electron documentation.
8. Do not make security claims without checking the current implementation.
9. Do not describe planned features as shipped features.
10. Keep internal architecture documentation in the repository `docs/` directory.

## Technical foundation

The public site uses:

- Fumadocs
- React Router
- MDX
- static prerendering
- local Orama search
- Cloudflare Pages

The current foundation includes:

- a documentation home page
- an installation guide at `/docs`
- static HTML output
- local search
- `llms.txt` and Markdown output
- Cloudflare Pages configuration
- a deployment workflow
- root development and validation scripts

## Proposed navigation

```text
Introduction
└── Install Termul

Getting started
├── Create a project
├── Workspace basics
├── Keyboard shortcuts
└── Platform requirements

Core workflow
├── Terminals
├── Shells
├── Split panes
├── Workspace tabs
└── Snapshots

Files and editing
├── File explorer
├── Project search
├── Code editor
└── Markdown and Mermaid

Git
├── Git panel
├── Changes and staging
├── Commits and push
├── History
└── Worktrees

Remote
├── SSH connections
├── Authentication
├── SFTP
├── Port forwarding
└── Browser access

Browser
├── Browser tabs
└── Annotations

Agents
├── Overview
├── Install and configure agents
├── Chat sessions
├── Permissions
├── Tools and skills
└── History and resume

Reference
├── Application settings
├── Project settings
├── Keyboard shortcut reference
└── Supported shells

Troubleshooting
├── Installation
├── Terminals
├── Git
├── SSH
├── Browser
└── Agents
```

## Delivery plan

Documentation should be delivered in small pull requests. Each pull request should solve one clear documentation problem and remain easy to review.

### Phase 1: documentation foundation

#### Task 1.1: Fumadocs shell and installation guide

Status: in progress

Scope:

- create the standalone `website-docs/` app
- add Fumadocs and React Router
- configure MDX content
- enable static prerendering
- enable local search
- add the installation guide
- add first workspace steps
- add root docs scripts
- add Cloudflare Pages configuration
- add the docs deployment workflow
- document local development

Initial page:

```text
content/docs/index.mdx
```

The page covers:

- Homebrew installation on macOS
- curl installation on macOS and Linux
- Windows `.exe` and `.msi` installation
- Linux `~/.local/bin` behavior
- creating the first project workspace

#### Task 1.2: production domain integration

Scope:

- create or confirm the Cloudflare Pages project named `termul-docs`
- configure `docs.termul.dev`
- verify HTTPS and direct route loading
- update landing header and footer links
- verify the deployed search endpoint
- verify `llms.txt`

Maintainer action required:

- Cloudflare account access
- Pages project creation
- DNS configuration
- deployment secret access

The landing Docs link should not point to `docs.termul.dev` in production until the domain is ready.

### Phase 2: getting started

#### Task 2.1: create a project

Create:

```text
content/docs/getting-started/create-a-project.mdx
```

Cover:

- opening the new project dialog
- selecting a workspace directory
- choosing a project name and color
- selecting a default shell
- project templates, if currently available to users
- Git initialization, if currently available to users
- what Termul stores for a project

#### Task 2.2: workspace basics

Create:

```text
content/docs/getting-started/workspace-basics.mdx
```

Cover:

- project sidebar
- opening a terminal
- switching projects
- restoring workspace state
- tabs and panes
- file explorer visibility
- project settings

#### Task 2.3: keyboard shortcuts

Create:

```text
content/docs/getting-started/keyboard-shortcuts.mdx
```

Cover:

- opening the command palette
- creating a terminal
- moving between tabs
- opening shortcut settings
- recording custom shortcuts
- platform differences between Windows, Linux, and macOS

Read shortcut defaults from the current source before writing the page.

#### Task 2.4: platform requirements

Create:

```text
content/docs/getting-started/platform-requirements.mdx
content/docs/getting-started/installation-troubleshooting.mdx
```

Cover:

- Windows WebView2
- macOS installation and Gatekeeper behavior
- Linux WebKit and system dependencies
- supported architectures
- installer checksum verification
- adding `~/.local/bin` to `PATH`

### Phase 3: terminals and workspace layout

#### Task 3.1: terminal guide

Create:

```text
content/docs/core/terminals.mdx
content/docs/core/shells.mdx
```

Cover:

- creating terminal tabs
- choosing a shell
- renaming and reordering tabs
- closing a tab or killing its process
- terminal search
- URL and file path handling
- command history
- WebGL rendering and DOM fallback
- exit notifications

#### Task 3.2: panes and tabs

Create:

```text
content/docs/core/split-panes.mdx
content/docs/core/workspace-tabs.mdx
```

Cover:

- splitting a workspace
- resizing panes
- moving tabs between panes
- pane fullscreen mode
- terminal, editor, and browser tabs
- restoring layout state

#### Task 3.3: snapshots

Create:

```text
content/docs/core/snapshots.mdx
```

Cover:

- creating a snapshot
- what a snapshot stores
- restoring a snapshot
- deleting a snapshot
- limitations and expected behavior

### Phase 4: files and editors

#### Task 4.1: file explorer

Create:

```text
content/docs/files/file-explorer.mdx
```

Cover:

- browsing folders
- creating files and directories
- rename and delete operations
- clipboard operations
- drag and drop
- live file watching
- context menus

#### Task 4.2: project search

Create:

```text
content/docs/files/project-search.mdx
```

Cover:

- filename search
- content search
- ripgrep-backed behavior
- opening search results
- common reasons a file may not appear

#### Task 4.3: code editor

Create:

```text
content/docs/files/code-editor.mdx
```

Cover:

- opening files
- syntax highlighting
- dirty state
- saving and reloading
- handling files changed on disk
- closing unsaved tabs

#### Task 4.4: Markdown and Mermaid

Create:

```text
content/docs/files/markdown-and-mermaid.mdx
```

Cover:

- Markdown editing
- live preview behavior
- heading navigation
- table of contents
- Mermaid rendering
- Mermaid zoom and pan behavior
- syntax error handling

### Phase 5: Git workflows

#### Task 5.1: Git panel overview

Create:

```text
content/docs/git/overview.mdx
content/docs/git/changes-and-staging.mdx
```

Cover:

- opening the Git panel
- reading repository status
- staged and unstaged changes
- inline and side-by-side diffs
- staging and unstaging
- discard warnings

#### Task 5.2: commits and history

Create:

```text
content/docs/git/commits-and-push.mdx
content/docs/git/history.mdx
```

Cover:

- creating a commit
- amending a commit
- publishing or pushing a branch
- selecting branches
- reading the history graph

#### Task 5.3: Git worktrees

Create:

```text
content/docs/git/worktrees.mdx
```

Cover:

- creating a worktree
- worktrees as sub-projects
- working on multiple branches
- removing and restoring worktrees
- merge previews
- conflict resolution

Issue `#254` requests broader README coverage for Git, SSH, worktrees, agents, remote access, and search. Public guides may support that work, but they do not close the issue unless its README acceptance criteria are also completed.

### Phase 6: remote workflows

#### Task 6.1: SSH connections

Create:

```text
content/docs/remote/ssh-connections.mdx
content/docs/remote/authentication.mdx
```

Cover:

- creating an SSH profile
- password, key, and SSH agent authentication
- connecting and reconnecting
- host-key verification
- stored profile data
- OS keychain behavior

Verify each security statement against current code before publishing it.

#### Task 6.2: SFTP

Create:

```text
content/docs/remote/sftp.mdx
```

Cover:

- remote file explorer
- opening remote files
- creating, renaming, and deleting remote files
- upload and download behavior
- connection error handling

#### Task 6.3: port forwarding

Create:

```text
content/docs/remote/port-forwarding.mdx
```

Cover only the forwarding modes supported by the current implementation. Do not describe remote or reverse forwarding unless it ships.

#### Task 6.4: browser remote access

Create:

```text
content/docs/remote/browser-access.mdx
```

Cover:

- starting the remote server
- publishing a project
- browser access
- authentication
- network exposure
- stopping access

This page needs security review before publication.

### Phase 7: browser and annotations

#### Task 7.1: browser tabs

Create:

```text
content/docs/browser/browser-tabs.mdx
```

Cover:

- opening a browser tab
- navigation controls
- internal versus external browser behavior
- tab lifecycle
- known webview limitations

#### Task 7.2: annotations

Create:

```text
content/docs/browser/annotations.mdx
```

Cover:

- starting an annotation session
- selecting an element
- adding severity and intent
- reviewing annotations
- exporting annotations
- output format

### Phase 8: agents

#### Task 8.1: agent overview and setup

Create:

```text
content/docs/agents/overview.mdx
content/docs/agents/configuration.mdx
```

Cover:

- what an agent is in Termul
- built-in and custom agents
- installation and runtime checks
- launching an agent in a pane
- agent settings

#### Task 8.2: chat sessions

Create:

```text
content/docs/agents/chat-sessions.mdx
content/docs/agents/history-and-resume.mdx
```

Cover:

- starting a session
- sending prompts
- attachments and mentions
- cancelling a turn
- chat history
- reopening and continuing a session

#### Task 8.3: permissions, tools, and skills

Create:

```text
content/docs/agents/permissions.mdx
content/docs/agents/tools-and-skills.mdx
```

Cover:

- permission prompts
- tool call status
- plans and task progress
- MCP integrations
- agent skills
- filesystem boundaries visible to users

Internal ACP architecture work belongs in repository engineering docs and should remain separate from public guides. Issue `#356` tracks that work.

### Phase 9: reference and troubleshooting

#### Task 9.1: settings reference

Create:

```text
content/docs/reference/application-settings.mdx
content/docs/reference/project-settings.mdx
content/docs/reference/keyboard-shortcuts.mdx
content/docs/reference/supported-shells.mdx
```

Reference pages should be generated or checked against current settings and shortcut definitions whenever possible.

#### Task 9.2: troubleshooting

Create:

```text
content/docs/troubleshooting/installation.mdx
content/docs/troubleshooting/terminals.mdx
content/docs/troubleshooting/git.mdx
content/docs/troubleshooting/ssh.mdx
content/docs/troubleshooting/browser.mdx
content/docs/troubleshooting/agents.mdx
```

Troubleshooting advice must come from confirmed issues, current tests, or reproducible behavior. Avoid speculative fixes.

### Phase 10: documentation contributor guide

Create:

```text
content/docs/contributing/documentation.mdx
```

Cover:

- running the docs site locally
- creating a page
- MDX frontmatter
- navigation metadata
- adding images
- link conventions
- validation commands
- preview deployment
- writing standards

## Page template

Use this structure for task-based guides:

```mdx
---
title: Page title
description: One sentence describing the task and result.
---

Short introduction explaining when the user needs this page.

## Before you start

List only real prerequisites.

## Complete the task

1. First action.
2. Next action.
3. Expected result.

## Related settings

Explain settings that directly affect the task.

## Troubleshooting

Include confirmed problems and fixes only.

## Next steps

Link to one or two related guides.
```

Reference pages may use tables, but task guides should prefer numbered steps and short explanations.

## Screenshot standards

Add screenshots when labels, placement, or visual state matter.

Each screenshot should:

- use the current UI
- show only the relevant area
- avoid private project names, paths, tokens, or credentials
- include useful alternative text
- remain readable on the docs page
- use a stable file name

Store documentation images under:

```text
website-docs/public/images/docs/
```

Suggested naming format:

```text
new-project-dialog.webp
terminal-shell-selector.webp
git-changes-panel.webp
ssh-profile-form.webp
```

## Writing standards

### Voice

Use direct, neutral language.

Prefer:

```text
Select New Project, then choose the project directory.
```

Avoid:

```text
Termul provides a seamless and powerful way to effortlessly create projects.
```

### Product naming

Use:

- `Termul` for the product
- `Termul Manager` when matching installer or package names
- `project workspace` for a project-specific workspace
- `terminal tab`, `browser tab`, and `editor tab` for tab types

### Commands

Commands must be safe to copy. State the directory they should run from when it is not obvious.

### Links

- use `https://github.com/gnoviawan/termul/releases/latest` for current downloads
- use relative links for pages inside the docs site
- link source files to the `dev` branch when documenting unreleased behavior
- use stable external documentation links

### Security

Do not claim that data is encrypted, isolated, secret, or secure without checking the implementation and persistence path.

Never include:

- real credentials
- real API tokens
- private hostnames
- private IP addresses
- personal directory paths

## Validation

Run docs-specific checks for every documentation change:

```bash
bun run docs:lint
bun run docs:typecheck
bun run docs:build
git diff --check
```

Manually verify:

- the page appears in navigation
- search finds the page
- internal links open correctly
- external links use the intended domain and branch
- direct page refresh works
- code blocks render and copy correctly
- headings have stable anchors
- light and dark themes remain readable
- mobile navigation works

Foundation and code-adjacent pull requests must also follow the repository validation requirements:

```bash
bun run ci
bun run typecheck
bun run test

cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo test
```

If a check is not applicable or cannot run locally, explain why in the pull request. Do not silently omit it.

## Contribution workflow

This repository is a fork-based contribution.

Local fork:

```text
Ficky-Dev/termul
```

Upstream repository:

```text
gnoviawan/termul
```

### One-time remote setup

```bash
git remote add upstream https://github.com/gnoviawan/termul.git
git fetch upstream
```

### Create a task branch

Create one branch per documentation task:

```bash
git switch dev
git fetch upstream
git reset --hard upstream/dev
git push origin dev --force-with-lease
git switch -c docs/<task-name>
```

Do not reset `dev` while uncommitted work is still on it. Move current work to a feature branch first.

Suggested foundation branch:

```bash
git switch -c docs/fumadocs-foundation
```

### Check for duplicate work

Before each task:

1. Search open and closed issues.
2. Search open and closed pull requests.
3. Confirm the task solves a real documentation problem.
4. Comment on or open an issue when the scope requires maintainer approval.

### Commit and push

Use conventional commits:

```bash
git add <task-files>
git commit -m "docs: add terminal usage guide"
git push -u origin docs/<task-name>
```

### Open the pull request

Target the upstream `dev` branch:

```bash
gh pr create \
  --repo gnoviawan/termul \
  --base dev \
  --head Ficky-Dev:docs/<task-name> \
  --title "docs: describe the documentation task"
```

Fill every section of `.github/PULL_REQUEST_TEMPLATE.md` with specific information.

The pull request must include:

- the user problem
- the issue or maintainer discussion
- the exact pages and behavior changed
- validation commands and results
- screenshots for visible site changes
- infrastructure requirements
- confirmation that no unrelated changes are included

Wait for all CI jobs and CodeRabbit or Claude review. Resolve every finding before asking for merge.

## Pull request sequence

Recommended order:

1. Fumadocs foundation and installation guide
2. Production domain and landing integration
3. Create a project
4. Workspace basics
5. Keyboard shortcuts and platform requirements
6. Terminals and shells
7. Panes, tabs, and snapshots
8. File explorer and search
9. Editors and Markdown
10. Git panel and worktrees
11. SSH, SFTP, and port forwarding
12. Browser tabs and annotations
13. Agent workflows
14. Settings reference
15. Troubleshooting
16. Documentation contributor guide

Pause after the foundation pull request. Use maintainer feedback to confirm the navigation, design, deployment model, and writing style before adding the remaining guides.

## Definition of done

A documentation task is complete when:

- the content matches current product behavior
- the page has a clear user task
- links and commands have been verified
- docs lint, typecheck, and build pass
- the page works in the static production output
- a human has reviewed the complete diff
- the upstream pull request targets `dev`
- all CI checks pass
- all review comments are resolved
