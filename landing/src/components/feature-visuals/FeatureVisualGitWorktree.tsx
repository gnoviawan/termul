export function FeatureVisualGitWorktree() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
      <div className="relative w-[90%] max-w-md bg-graphite rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex overflow-hidden min-h-[180px]">
        <div className="w-32 shrink-0 bg-pitch-black border-r border-white/10 flex flex-col py-3">
          <div className="px-3 mb-2 text-[9px] text-gray-500 font-mono tracking-wider uppercase">
            Projects
          </div>
          <div className="px-2 flex flex-col gap-0.5">
            <div className="px-2 py-1.5 rounded-md bg-rose-500/15 border border-rose-500/25 text-[10px] text-rose-300 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
              termul
            </div>
            <div className="pl-3 flex flex-col gap-0.5">
              <div className="px-2 py-1.5 rounded-md text-[10px] text-gray-300 flex items-center gap-2 bg-white/[0.04] border border-white/10">
                <span className="text-rose-400/70">⌐</span>
                main
              </div>
              <div className="px-2 py-1.5 rounded-md text-[10px] text-gray-500 flex items-center gap-2">
                <span className="text-gray-600">⌐</span>
                feat/git-ui
              </div>
              <div className="px-2 py-1.5 rounded-md text-[10px] text-gray-500 flex items-center gap-2">
                <span className="text-gray-600">⌐</span>
                fix/restore
              </div>
            </div>
          </div>
        </div>
        <div className="flex-1 flex flex-col bg-deep-slate">
          <div className="flex-1 p-4 font-mono text-[10px] text-gray-400 flex flex-col gap-1.5 justify-center">
            <div className="text-gray-500">~/termul/.worktrees/feat-git-ui</div>
            <div>
              <span className="text-green-400">➜</span> git status
            </div>
            <div className="text-rose-400/80">On branch feat/git-ui</div>
          </div>
          <div className="h-6 border-t border-white/10 bg-deep-slate flex items-center px-3">
            <span className="text-[9px] text-gray-500 font-mono">
              Worktree: <span className="text-rose-400">feat/git-ui</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
