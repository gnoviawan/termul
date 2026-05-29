export function FeatureVisualSessionPersistence() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
      <div className="relative w-[85%] max-w-sm bg-[#0a0a0a] rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden">
        <div className="h-8 bg-[#161616] border-b border-white/10 flex items-center px-4">
          <div className="text-[10px] text-gray-400 font-medium tracking-wide">SNAPSHOT MANAGER</div>
        </div>
        <div className="p-4 bg-[#0d0d0d] flex flex-col gap-2 min-h-[140px]">
          <div className="bg-white/5 border border-blue-500/30 rounded p-3 flex justify-between items-center shadow-lg shadow-black">
            <div>
              <div className="text-xs text-white mb-0.5">Before Refactor</div>
              <div className="text-[10px] text-gray-500">May 18, 10:42 AM • 4 tabs</div>
            </div>
            <div className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-1 rounded border border-blue-500/20">
              RESTORE
            </div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded p-3 flex justify-between items-center opacity-60">
            <div>
              <div className="text-xs text-white mb-0.5">End of day</div>
              <div className="text-[10px] text-gray-500">May 17, 05:30 PM • 2 tabs</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
