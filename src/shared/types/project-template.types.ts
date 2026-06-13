export interface TemplateEnvVariable {
  key: string
  value: string
  isSecret?: boolean
}

export interface TemplateFile {
  path: string
  content: string
}

export interface ProjectTemplate {
  id: string
  name: string
  description: string
  defaultShell?: string
  envVars?: TemplateEnvVariable[]
  files?: TemplateFile[]
  dirs?: string[]
}
