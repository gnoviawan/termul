import { Check, Copy, FileText, Folder, RefreshCw, Search, X } from 'lucide-react'
import type { WsAdapter } from '@shared/types/ws.types'
import { FileTree } from './web-file-tree'

export interface DirectoryEntry {
  name: string
  path: string
  type: 'directory' | 'file'
  extension?: string
  size?: number
  modifiedAt?: number
}

export function ExplorerPanel(props: {
  ws: WsAdapter
  showExplorer: boolean
  activeProjectPath?: string
  directoryContents: Map<string, DirectoryEntry[]>
  expandedDirs: Set<string>
  explorerSearch: string
  setExplorerSearch: (value: string) => void
  isRefreshing: boolean
  onRefreshWorkspace: () => void
  onToggleExpand: (path: string) => void
  onSelectFile: (path: string) => void
}): React.JSX.Element {
  const { ws, activeProjectPath, directoryContents, expandedDirs, explorerSearch, setExplorerSearch, isRefreshing, onRefreshWorkspace, onToggleExpand, onSelectFile } = props

  return (
    <>
      <div className="p-4 border-b border-zinc-900 flex items-center justify-between shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest select-none">Explorer</span>
        <button
          onClick={onRefreshWorkspace}
          disabled={isRefreshing}
          className={`p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-all ${isRefreshing ? 'animate-spin' : ''}`}
          title="Refresh Files"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="p-3 shrink-0">
        <div className="relative">
          <input
            type="text"
            value={explorerSearch}
            onChange={(e) => setExplorerSearch(e.target.value)}
            placeholder="Filter files by name..."
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl pl-8.5 pr-4 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:ring-1 focus:ring-blue-500/30 focus:border-blue-500 outline-none transition-all shadow-inner"
          />
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-600">
            <Search size={12} />
          </div>
          {explorerSearch && (
            <button onClick={() => setExplorerSearch('')} className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-500 hover:text-white transition-colors">
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
        {activeProjectPath ? (
          directoryContents.has(activeProjectPath) ? (
            <FileTree
              ws={ws}
              dirPath={activeProjectPath}
              level={0}
              directoryContents={directoryContents}
              expandedDirs={expandedDirs}
              searchQuery={explorerSearch}
              onToggleExpand={onToggleExpand}
              onSelectFile={onSelectFile}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center shrink-0">
              <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin mb-3" />
              <span className="text-xs text-zinc-500 font-medium">Mounting directory...</span>
            </div>
          )
        ) : (
          <div className="py-12 text-center text-xs text-zinc-600 italic select-none">Select a workspace to explore files.</div>
        )}
      </div>
    </>
  )
}

export function PreviewModal(props: {
  previewFile: string | null
  previewContent: string | null
  isPreviewLoading: boolean
  copiedFile: boolean
  onCopyPreview: () => void
  onClose: () => void
}): React.JSX.Element | null {
  const { previewFile, previewContent, isPreviewLoading, copiedFile, onCopyPreview, onClose } = props
  if (!previewFile) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/75 backdrop-blur-sm p-4 md:p-8 animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="px-6 py-4 bg-zinc-900/90 border-b border-zinc-800/80 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-xl">
              <FileText size={16} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white tracking-tight truncate max-w-xs md:max-w-md">{previewFile.split('/').pop()}</h3>
              <p className="text-[10px] text-zinc-500 font-mono truncate max-w-xs md:max-w-md mt-0.5">{previewFile}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {previewContent && (
              <button onClick={onCopyPreview} className="p-2 bg-zinc-800 hover:bg-zinc-700 hover:text-white rounded-xl border border-zinc-700 text-zinc-400 transition-all active:scale-95 flex items-center justify-center" title="Copy File Content">
                {copiedFile ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
            )}
            <button onClick={onClose} className="p-2 bg-zinc-800 hover:bg-zinc-700 hover:text-white rounded-xl border border-zinc-700 text-zinc-400 transition-all active:scale-95 flex items-center justify-center">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-[#0a0a0f] p-6 font-mono text-xs leading-relaxed text-zinc-300">
          {isPreviewLoading ? (
            <div className="h-full flex flex-col items-center justify-center gap-3">
              <div className="w-6 h-6 border-2 border-zinc-800 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-xs text-zinc-500 font-medium">Fetching file contents from host...</span>
            </div>
          ) : previewContent !== null ? (
            <pre className="whitespace-pre overflow-x-auto text-[#a6adc8] bg-[#0a0a0f] select-text"><code>{previewContent}</code></pre>
          ) : (
            <div className="h-full flex items-center justify-center text-zinc-600 italic select-none">Empty file or binary preview not supported.</div>
          )}
        </div>
      </div>
    </div>
  )
}
