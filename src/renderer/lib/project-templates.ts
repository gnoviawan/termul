import type { IpcResult } from '@shared/types/ipc.types'
import type { ProjectTemplate } from '@shared/types/project-template.types'
import { filesystemApi } from './api'

export const BUILT_IN_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'empty',
    name: 'Empty Project',
    description: 'Create an empty project directory with no boilerplate files.'
  },
  {
    id: 'node',
    name: 'Node.js Project',
    description: 'A basic Node.js project structure with package.json, src/, and env vars.',
    defaultShell: undefined,
    envVars: [
      { key: 'PORT', value: '3000' },
      { key: 'NODE_ENV', value: 'development' }
    ],
    dirs: ['src'],
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "{{projectName}}",
  "version": "1.0.0",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {}
}
`
      },
      {
        path: 'src/index.js',
        content: `console.log("Hello from Termul Node.js project!");
`
      },
      {
        path: '.gitignore',
        content: `node_modules/
.env
.env.local
`
      },
      {
        path: '.env.example',
        content: `PORT=3000
NODE_ENV=development
`
      }
    ]
  },
  {
    id: 'rust',
    name: 'Rust Project',
    description: 'A standard Cargo Rust project structure with src/main.rs.',
    dirs: ['src'],
    files: [
      {
        path: 'Cargo.toml',
        content: `[package]
name = "{{projectName}}"
version = "0.1.0"
edition = "2021"

[dependencies]
`
      },
      {
        path: 'src/main.rs',
        content: `fn main() {
    println!("Hello from Termul Rust project!");
}
`
      },
      {
        path: '.gitignore',
        content: `/target
**/*.rs.bk
`
      }
    ]
  },
  {
    id: 'react',
    name: 'React App (Vite)',
    description: 'React + TypeScript SPA scaffolded using Vite configuration.',
    dirs: ['src'],
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "{{projectName}}",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.2.2",
    "vite": "^5.3.1"
  }
}
`
      },
      {
        path: 'vite.config.ts',
        content: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`
      },
      {
        path: 'tsconfig.json',
        content: `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2020"],
    "module": "ESNext",
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
`
      },
      {
        path: 'index.html',
        content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React + TS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
      },
      {
        path: 'src/main.tsx',
        content: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`
      },
      {
        path: 'src/App.tsx',
        content: `import React from 'react'

function App() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Hello from React + Vite!</h1>
      <p>Created with Termul Manager</p>
    </div>
  )
}

export default App
`
      },
      {
        path: 'src/index.css',
        content: `:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
}
body {
  margin: 0;
}
`
      },
      {
        path: '.gitignore',
        content: `node_modules/
dist/
dist-ssr/
*.local
`
      }
    ]
  },
  {
    id: 'python',
    name: 'Python Project',
    description: 'A clean Python structure with requirements.txt and virtualenv gitignore.',
    dirs: ['src'],
    files: [
      {
        path: 'main.py',
        content: `import os

def main():
    port = os.getenv("PORT", "5000")
    print(f"Hello from Python project! Running on port: {port}")

if __name__ == "__main__":
    main()
`
      },
      {
        path: 'requirements.txt',
        content: `# Add dependencies here, e.g.:
# requests>=2.31.0
`
      },
      {
        path: '.env.example',
        content: `PORT=5000
`
      },
      {
        path: '.gitignore',
        content: `__pycache__/
*.py[cod]
*$py.class
.env
venv/
env/
ENV/
`
      }
    ]
  }
]

function interpolate(content: string, projectName: string): string {
  const safeName = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  return content.replace(/{{projectName}}/g, safeName)
}

export async function scaffoldProject(
  projectPath: string,
  projectName: string,
  template: ProjectTemplate
): Promise<IpcResult<void>> {
  try {
    const normalizedPath = projectPath.replace(/\\/g, '/')

    const baseDirResult = await filesystemApi.createDirectory(normalizedPath)
    if (!baseDirResult.success) {
      return {
        success: false,
        error: `Failed to create base directory: ${baseDirResult.error}`,
        code: 'SCAFFOLD_BASE_DIR_ERROR'
      }
    }

    if (template.dirs) {
      for (const dir of template.dirs) {
        const subPath = `${normalizedPath}/${dir}`.replace(/\/+/g, '/')
        const dirResult = await filesystemApi.createDirectory(subPath)
        if (!dirResult.success) {
          return {
            success: false,
            error: `Failed to create directory ${dir}: ${dirResult.error}`,
            code: 'SCAFFOLD_DIR_ERROR'
          }
        }
      }
    }

    if (template.files) {
      for (const file of template.files) {
        const filePath = `${normalizedPath}/${file.path}`.replace(/\/+/g, '/')
        const content = interpolate(file.content, projectName)
        const fileResult = await filesystemApi.createFile(filePath, content)
        if (!fileResult.success) {
          return {
            success: false,
            error: `Failed to create file ${file.path}: ${fileResult.error}`,
            code: 'SCAFFOLD_FILE_ERROR'
          }
        }
      }
    }

    return { success: true, data: undefined }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'SCAFFOLD_EXCEPTION'
    }
  }
}
