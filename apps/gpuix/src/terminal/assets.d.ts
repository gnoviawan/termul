/** Bun's file loader: `import path from './x.ttf' with { type: 'file' }` yields the file's path. */
declare module '*.ttf' {
  const path: string
  export default path
}
