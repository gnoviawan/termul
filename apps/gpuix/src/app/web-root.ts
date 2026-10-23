/**
 * The browser root, `src/renderer/App.tsx`, unchanged: its providers, the
 * headless hook list and the hash router all come from there. Kept behind
 * `#app/web-root` so tsc checks it as a DOM component (the web build does)
 * and the native program sees only `web-root-contract.ts`.
 */

export { default as WebApp } from '@/App'
