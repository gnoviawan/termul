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
   npm install
   ```
4. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

#### Development Workflow

1. Make your changes
2. Run tests:
   ```bash
   npm test
   ```
3. Run type checking:
   ```bash
   npm run typecheck
   ```
4. Run linting:
   ```bash
   npm run lint
   ```
5. Test the app manually:
   ```bash
   npm run dev
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
├── main/           # Electron main process
│   ├── ipc/        # IPC handlers
│   └── services/   # Backend services
├── preload/        # Preload scripts
├── renderer/       # React frontend
│   ├── components/ # UI components
│   ├── hooks/      # Custom hooks
│   ├── pages/      # Page components
│   └── stores/     # Zustand stores
└── shared/         # Shared types
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

- Node.js 18+
- npm or bun
- Git

### Running Locally

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

### Building Installers

```bash
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

## Questions?

Feel free to open an issue for any questions or concerns.

Thank you for contributing!
