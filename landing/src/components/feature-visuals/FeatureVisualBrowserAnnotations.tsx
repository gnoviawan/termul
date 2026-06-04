import { FeatureVisualFrameRoot, FeatureVisualFrameWindow } from './FeatureVisualFrame';

export function FeatureVisualBrowserAnnotations() {
  return (
    <FeatureVisualFrameRoot>
      <FeatureVisualFrameWindow size="md" className="flex min-h-[180px] flex-col overflow-hidden">
        <div className="h-8 bg-deep-slate border-b border-white/10 flex items-center px-2 gap-2">
          <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-red-500/80"></div>
            <div className="w-2 h-2 rounded-full bg-yellow-500/80"></div>
            <div className="w-2 h-2 rounded-full bg-green-500/80"></div>
          </div>
          <div className="flex-1 bg-graphite border border-white/10 rounded px-2 py-0.5 text-[9px] text-gray-500 font-mono truncate">
            https://app.example.com/dashboard
          </div>
        </div>
        <div className="relative flex-1 bg-deep-slate p-4 min-h-[120px]">
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2">
            <div className="h-2 w-24 rounded bg-white/10"></div>
            <div className="h-2 w-full rounded bg-white/5"></div>
            <div className="h-2 w-3/4 rounded bg-white/5"></div>
            <div className="flex gap-2 mt-3">
              <div className="h-8 flex-1 rounded bg-rose-500/10 border border-rose-500/20"></div>
              <div className="h-8 flex-1 rounded bg-white/5 border border-white/10"></div>
            </div>
          </div>
          <div className="absolute bottom-3 right-3 bg-rose-500/15 border border-rose-500/30 rounded-full px-3 py-1.5 text-[9px] text-rose-300 font-mono shadow-lg">
            Critical · UI regression
          </div>
        </div>
        <div className="h-7 border-t border-white/10 bg-deep-slate flex items-center px-3 gap-3">
          <span className="text-[9px] text-gray-500 font-mono">Annotate</span>
          <span className="text-[9px] text-gray-600">|</span>
          <span className="text-[9px] text-gray-500 font-mono">Export package</span>
        </div>
      </FeatureVisualFrameWindow>
    </FeatureVisualFrameRoot>
  );
}
