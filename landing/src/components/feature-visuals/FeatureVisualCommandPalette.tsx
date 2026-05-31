export function FeatureVisualCommandPalette() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
      <div className="relative w-[90%] max-w-md bg-[#0a0a0a] rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden min-h-[180px]">
        <div className="h-7 bg-[#161616] border-b border-white/10 flex items-center px-3 gap-2">
          <div className="text-[9px] text-gray-500 font-mono">termul</div>
        </div>
        <div className="relative flex-1 bg-[#0d0d0d] flex items-start justify-center pt-5 min-h-[150px]">
          <div className="w-[85%] rounded-lg border border-white/15 bg-[#111] shadow-[0_20px_40px_rgba(0,0,0,0.6)] overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/10">
              <span className="text-[10px] text-indigo-400 font-mono">⌘K</span>
              <span className="text-[11px] text-gray-300 font-mono">switch project…</span>
              <span className="ml-1 w-px h-3 bg-indigo-400 animate-pulse"></span>
            </div>
            <div className="py-1.5">
              <div className="px-3 py-1 text-[8px] text-gray-600 font-mono uppercase tracking-wider">
                Projects
              </div>
              <div className="px-3 py-1.5 flex items-center gap-2 bg-indigo-500/15 border-l-2 border-indigo-400">
                <span className="text-[10px] text-indigo-300 font-mono">📌 termul</span>
                <span className="ml-auto text-[8px] text-gray-500 font-mono">↵</span>
              </div>
              <div className="px-3 py-1.5 flex items-center gap-2">
                <span className="text-[10px] text-gray-400 font-mono">📌 server-api</span>
              </div>
              <div className="px-3 py-1 text-[8px] text-gray-600 font-mono uppercase tracking-wider mt-1">
                Actions
              </div>
              <div className="px-3 py-1.5 flex items-center gap-2">
                <span className="text-[10px] text-gray-400 font-mono">New terminal</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
