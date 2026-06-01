/**
 * lint-staged configuration
 * Runs ESLint on staged files only
 * Uses `bun x` for consistency with CI (bun-based)
 * TypeScript typecheck runs separately in pre-commit hook
 */
export default {
  // TypeScript files - run ESLint with no warnings allowed
  '*.{ts,tsx}': 'bun x eslint --max-warnings=0',

  // JavaScript files - run ESLint with no warnings allowed
  '*.{js,jsx}': 'bun x eslint --max-warnings=0',
}
