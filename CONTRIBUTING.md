# Contributing to Termul Manager

Thank you for your interest in contributing to Termul Manager! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## How to Contribute

### Reporting Bugs

Before submitting a bug report:

1. Check the [existing issues](https://github.com/gnoviawan/termul/issues) to avoid duplicates
2. Use the latest version to see if the bug still exists

When submitting a bug report, include:

- A clear, descriptive title
- Steps to reproduce the issue
- Expected behavior vs actual behavior
- Your environment (OS, Node.js version, etc.)
- Screenshots if applicable
- Error messages or logs

### Suggesting Features

Feature requests are welcome! Please:

1. Check existing issues for similar suggestions
2. Provide a clear use case
3. Explain why this feature would benefit users

### Pull Requests

#### Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/termul.git
   cd termul
   ```
3. Install dependencies:
   ```bash
   bun install
   ```
4. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

#### Development Workflow

1. Before making architectural or implementation changes, review the AI agent project context at `docs/project-context.md` for repo-specific rules, boundaries, and anti-patterns.
2. Make your changes
3. Run tests:
   ```bash
   bun run test
   ```
4. Run type checking:
   ```bash
   bun run typecheck
   ```
5. Run linting:
   ```bash
   bun run lint
   ```
6. Test the app manually:
   ```bash
   bun run dev
   ```

#### Commit Guidelines

We follow conventional commit messages:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

Examples:

```
feat: add workspace export functionality
fix: terminal not resizing correctly on window resize
docs: update installation instructions
```

#### Submitting Your PR

1. Push your branch:
   ```bash
   git push origin feature/your-feature-name
   ```
2. Open a Pull Request on GitHub
3. Fill in the PR template with:
   - Description of changes
   - Related issue (if any)
   - Screenshots (for UI changes)
   - Testing steps

### Code Style

- Use TypeScript for all new code
- Follow the existing code patterns
- Keep components focused and single-purpose
- Use meaningful variable and function names
- Add comments only when the logic isn't self-evident

### Project Structure

```
src/
├── renderer/       # React frontend
│   ├── components/ # UI components
│   ├── hooks/      # Custom hooks
│   ├── pages/      # Page components
│   └── stores/     # Zustand stores
├── shared/         # Shared types
src-tauri/          # Tauri Rust code, configuration, and bundling
docs/electron-old/  # Archived Electron docs and migration history
```

### Testing

- Write tests for new functionality
- Ensure existing tests pass before submitting
- Place test files next to the code they test (e.g., `component.tsx` and `component.test.tsx`)

### Documentation

- Update README.md if you add new features
- Add JSDoc comments for public APIs
- Update type definitions as needed

## Development Setup

### Prerequisites

- Bun 1.3+
- Git

### Running Locally

> **Prerequisite:** Before running `bun run dev`, install the Rust toolchain (`rustup`, `rustc`, and `cargo`) plus any platform-specific Tauri dependencies listed in the README [Prerequisites](README.md#prerequisites) section.

```bash
# Install dependencies
bun install

# Start the Tauri app in development mode
bun run dev

# Run tests
bun run test

# Build for production
bun run build
```

### Platform Builds

> **Prerequisite:** Platform-specific Tauri builds require the Rust toolchain, the required compilation targets, and the OS dependencies documented in the README [Prerequisites](README.md#prerequisites) section.

```bash
bun run build:tauri:win        # Windows (x64)
bun run build:tauri:mac-arm    # macOS (Apple Silicon)
bun run build:tauri:mac-x64    # macOS (Intel)
bun run build:tauri:linux      # Linux (x64)
```

## Release Management (Maintainers Only)

### Creating a Release

Releases are automated via GitHub Actions when a version tag is pushed:

1. Ensure version numbers match in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`
2. Push a version tag: `git tag v0.3.7 && git push origin v0.3.7`
3. CI will build, sign, and publish a draft release
4. Verify the release assets include `.sig` files and `latest.json`
5. Publish the draft release

### Signing Key Management

Update signing is secured with a minisign keypair. The public key is embedded in the app at `src-tauri/tauri.conf.json` (line 39), and the private key is stored in the GitHub secret `TAURI_SIGNING_PRIVATE_KEY`.

**Important**: If you need to rotate signing keys, follow the procedure documented in [docs/auto-update-release-verification.md](docs/auto-update-release-verification.md#key-rotation-procedure). The key rotation must ship the new public key in a release signed with the old key BEFORE rotating the private key in CI, otherwise existing users will fail to verify future updates.

Current key ID: `6E47FAD95783D992`

## Questions?

Feel free to open an issue for any questions or concerns.

Thank you for contributing!
