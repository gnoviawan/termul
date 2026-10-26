import { defineReactSsgConfig } from 'vite-plugin-react-ssg'

import { routes } from './src/routes'

export default defineReactSsgConfig({
  history: 'browser',
  origin: 'https://termul.dev',
  routes,
  // The `*` route is not discovered automatically; prerender it once so the
  // build can ship it as dist/404.html (see scripts/write-404.ts).
  paths: ['/404'],
  logLevel: 'normal',
})
