import type { McpCatalogApi } from '@shared/types/mcp-catalog.types'
import { createDesktopMcpCatalogApi } from './desktop-mcp-catalog-api'
import { isTauriContext } from './tauri-runtime'
import { webMcpCatalogApi } from './web-mcp-catalog-api'

export const mcpCatalogApi: McpCatalogApi = isTauriContext()
  ? createDesktopMcpCatalogApi()
  : webMcpCatalogApi
