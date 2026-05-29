import { defineReactSsgConfig } from 'vite-plugin-react-ssg'

import { App } from './src/App'

export default defineReactSsgConfig({
  app: App,
  logLevel: 'normal',
})
