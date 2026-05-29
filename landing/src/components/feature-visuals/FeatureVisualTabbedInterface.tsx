import { HugeiconsIcon } from '@hugeicons/react';
import { ConsoleIcon } from '@hugeicons/core-free-icons';

export function FeatureVisualTabbedInterface() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
      <div className="relative w-[85%] max-w-sm bg-[#0a0a0a] rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden">
        <div className="h-10 bg-[#000] border-b border-white/10 flex items-end px-2 pt-2 gap-1">
          <div className="bg-[#161616] border border-b-0 border-white/10 rounded-t-lg px-4 h-full text-[10px] text-gray-300 flex items-center gap-2">
            <HugeiconsIcon icon={ConsoleIcon} className="w-3 h-3 text-blue-400" />
            termul
          </div>
          <div className="px-4 h-full text-[10px] text-gray-500 flex items-center gap-2 rounded-t-lg">
            <HugeiconsIcon icon={ConsoleIcon} className="w-3 h-3" />
            server
          </div>
          <div className="px-4 h-full text-[10px] text-gray-500 flex items-center gap-2 rounded-t-lg">
            <HugeiconsIcon icon={ConsoleIcon} className="w-3 h-3" />
            client
          </div>
        </div>
        <div className="p-5 font-mono text-[10px] sm:text-xs text-gray-400 min-h-[140px] bg-[#0d0d0d] flex flex-col gap-1.5">
          <div className="text-gray-500">~/Projects/termul</div>
          <div>
            <span className="text-green-400">➜</span> npm run dev
          </div>
          <div className="text-blue-400 mt-2">VITE v5.0.0 ready in 345 ms</div>
          <div className="text-gray-400">➜ Local: http://localhost:5173/</div>
        </div>
      </div>
    </div>
  );
}
