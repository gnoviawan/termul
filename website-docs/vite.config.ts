import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import mdx from 'fumadocs-mdx/vite'
import { defineConfig } from 'vite'
import { docsRoute } from './app/lib/shared'

export default defineConfig({
  base: `${docsRoute}/`,
  plugins: [mdx(), tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true
  }
})
