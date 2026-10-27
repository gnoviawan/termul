/**
 * The MCP catalog facade (spine AD-1, AD-5): the desktop impl inside a Tauri
 * webview, the HTTP impl in a browser. Both return the same `IpcResult` for
 * the same search, form, plan, commit or cancel request.
 */

import type { McpCatalogApi } from '@shared/types/mcp-catalog.types'
import { createDesktopMcpCatalogApi } from './desktop-mcp-catalog-api'
import { isTauriContext } from './tauri-runtime'
import { webMcpCatalogApi } from './web-mcp-catalog-api'

export const mcpCatalogApi: McpCatalogApi = isTauriContext()
  ? createDesktopMcpCatalogApi()
  : webMcpCatalogApi
