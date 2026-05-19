import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import type { WsAdapter } from '@shared/types/ws.types'

export interface DirectoryEntry {
  name: string
  path: string
  type: 'directory' | 'file'
  extension?: string
  size?: number
  modifiedAt?: number
}

export function FileTree(props: {
  ws: WsAdapter
  dirPath: string
  level: number
  directoryContents: Map<string, DirectoryEntry[]>
  expandedDirs: Set<string>
  searchQuery: string
  onToggleExpand: (path: string) => void
  onSelectFile: (path: string) => void
}): React.JSX.Element {
  const { ws, dirPath, level, directoryContents, expandedDirs, searchQuery, onToggleExpand, onSelectFile } = props
  const entries = directoryContents.get(dirPath) || []
  const filteredEntries = entries.filter((entry) => !searchQuery || entry.name.toLowerCase().includes(searchQuery.toLowerCase()))

  if (filteredEntries.length === 0 && entries.length > 0 && searchQuery) return <></>

  return (
    <div className="space-y-0.5">
      {filteredEntries.map((entry) => {
        const isDirectory = entry.type === 'directory'
        const isExpanded = expandedDirs.has(entry.path)

        return (
          <div key={entry.path}>
            <button
              onClick={() => (isDirectory ? onToggleExpand(entry.path) : onSelectFile(entry.path))}
              className="group flex w-full cursor-pointer items-center rounded-xl px-2 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-zinc-900/80 hover:text-white"
              style={{ paddingLeft: `${level * 12 + 8}px` }}
            >
              <span className="mr-1.5 shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-400">
                {isDirectory ? (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <FileText size={12} className="ml-3 text-zinc-600" />}
              </span>
              {isDirectory && <span className="mr-2 shrink-0 text-blue-400">{isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}</span>}
              <span className="flex-1 truncate font-medium select-none">{entry.name}</span>
            </button>

            {isDirectory && isExpanded && (
              <FileTree
                ws={ws}
                dirPath={entry.path}
                level={level + 1}
                directoryContents={directoryContents}
                expandedDirs={expandedDirs}
                searchQuery={searchQuery}
                onToggleExpand={onToggleExpand}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
