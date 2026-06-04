import { FeatureVisualFrameRoot, FeatureVisualFrameWindow } from './FeatureVisualFrame';

export function FeatureVisualSplitPanes() {
  return (
    <FeatureVisualFrameRoot>
      <FeatureVisualFrameWindow size="md" className="flex min-h-[180px] flex-col overflow-hidden">
        <div className="h-7 bg-deep-slate border-b border-white/10 flex items-center px-3 gap-2">
          <div className="text-[9px] text-gray-500 font-mono">SPLIT LAYOUT</div>
        </div>
        <div className="flex flex-1 min-h-[150px]">
          <div className="flex-1 bg-deep-slate p-3 font-mono text-[10px] text-gray-400 flex flex-col gap-1 border-r border-white/5">
            <div className="text-[9px] text-cyan-500/70 mb-1 uppercase tracking-wide">Terminal</div>
            <div className="text-gray-500">~/Projects/termul</div>
            <div>
              <span className="text-green-400">➜</span> npm test
            </div>
            <div className="text-green-400/80">✓ 12 tests passed</div>
          </div>
          <div className="w-1 bg-white/10 relative shrink-0">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-8 rounded-full bg-white/20 border border-white/10"></div>
          </div>
          <div className="flex-1 bg-deep-slate p-3 font-mono text-[10px] flex flex-col gap-0.5">
            <div className="text-[9px] text-amber-500/70 mb-1 uppercase tracking-wide">Editor</div>
            <div>
              <span className="text-purple-400">fn</span>{' '}
              <span className="text-blue-400">main</span>
              <span className="text-gray-400">()</span>{' '}
              <span className="text-gray-400">{'{'}</span>
            </div>
            <div className="pl-3 text-gray-400">
              <span className="text-purple-400">println!</span>
              <span className="text-green-400">(&quot;Hello&quot;)</span>;
            </div>
            <div className="text-gray-400">{'}'}</div>
          </div>
        </div>
      </FeatureVisualFrameWindow>
    </FeatureVisualFrameRoot>
  );
}
