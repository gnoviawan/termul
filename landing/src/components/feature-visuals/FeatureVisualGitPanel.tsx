export function FeatureVisualGitPanel() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
      <div className="relative w-[90%] max-w-md bg-[#0a0a0a] rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden min-h-[180px]">
        <div className="h-8 bg-[#161616] border-b border-white/10 flex items-center px-3 gap-2">
          <div className="text-[10px] text-emerald-400/90 font-mono">Git</div>
          <div className="text-[9px] text-gray-600">•</div>
          <div className="text-[10px] text-gray-500 font-mono flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80"></span>
            main
          </div>
          <div className="ml-auto text-[9px] text-gray-500 font-mono">↑ 2</div>
        </div>
        <div className="flex flex-1 min-h-[150px]">
          <div className="flex-1 bg-[#0d0d0d] p-3 font-mono text-[10px] flex flex-col gap-1 border-r border-white/5">
            <div className="text-[9px] text-gray-500 uppercase tracking-wide mb-1">Staged</div>
            <div className="flex items-center gap-2 text-gray-300">
              <span className="text-emerald-400">M</span> src/App.tsx
            </div>
            <div className="flex items-center gap-2 text-gray-300">
              <span className="text-emerald-400">A</span> features.ts
            </div>
            <div className="text-[9px] text-gray-500 uppercase tracking-wide mt-2 mb-1">
              Changes
            </div>
            <div className="flex items-center gap-2 text-gray-500">
              <span className="text-amber-400">M</span> README.md
            </div>
          </div>
          <div className="flex-1 bg-[#0a0a0a] p-3 flex flex-col gap-2">
            <div className="text-[9px] text-gray-500 font-mono uppercase tracking-wide">
              History
            </div>
            <div className="flex flex-col gap-2 mt-1">
              {['feat: landing videos', 'fix: git panel', 'chore: deps'].map((msg, i) => (
                <div key={msg} className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      i === 0 ? 'bg-emerald-400' : 'bg-white/20'
                    }`}
                  ></span>
                  <span className="text-[9px] text-gray-400 font-mono truncate">{msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="h-7 border-t border-white/10 bg-[#161616] flex items-center px-3 gap-3">
          <span className="text-[9px] text-emerald-300/90 font-mono">Commit</span>
          <span className="text-[9px] text-gray-600">|</span>
          <span className="text-[9px] text-gray-500 font-mono">Amend</span>
          <span className="text-[9px] text-gray-600">|</span>
          <span className="text-[9px] text-gray-500 font-mono">Push</span>
        </div>
      </div>
    </div>
  );
}
