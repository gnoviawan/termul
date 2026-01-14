/**
 * lint-staged configuration
 * Runs ESLint on staged files only
 * TypeScript typecheck runs separately in pre-commit hook
 */
export default {
  // TypeScript files - run ESLint with no warnings allowed
  '*.{ts,tsx}': 'eslint --max-warnings=0',

  // JavaScript files - run ESLint with no warnings allowed
  '*.{js,jsx}': 'eslint --max-warnings=0',
}
