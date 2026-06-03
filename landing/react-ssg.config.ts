import { defineReactSsgConfig } from 'vite-plugin-react-ssg'

import { routes } from './src/routes'

export default defineReactSsgConfig({
  history: 'browser',
  origin: 'https://termul.dev',
  routes,
  logLevel: 'normal',
})
