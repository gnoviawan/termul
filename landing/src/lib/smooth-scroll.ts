/** Ease-out cubic — decelerates into the target (corporate / premium landing feel). */
function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export const HEADER_SCROLL_OFFSET = 112;

/** Nearest scrollable ancestor (OverlayScrollbars viewport or overflow fallback). */
export function resolveScrollElement(from: HTMLElement): HTMLElement {
  let node: HTMLElement | null = from.parentElement;

  while (node) {
    const { overflowY } = getComputedStyle(node);
    const canScroll =
      node.scrollHeight > node.clientHeight + 1 &&
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay');

    if (canScroll) return node;
    node = node.parentElement;
  }

  return document.documentElement;
}

function getTargetScrollTop(
  target: HTMLElement,
  scrollEl: HTMLElement,
  offset: number,
): number {
  const scrollRect = scrollEl.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const next =
    scrollEl.scrollTop + (targetRect.top - scrollRect.top) - offset;

  const max = scrollEl.scrollHeight - scrollEl.clientHeight;
  return Math.max(0, Math.min(next, max));
}

let activeScrollCancel: (() => void) | null = null;

export type SmoothScrollOptions = {
  /** Pixels from top of scrollport (e.g. fixed header). */
  offset?: number;
};

export function smoothScrollToElement(
  target: HTMLElement,
  { offset = HEADER_SCROLL_OFFSET }: SmoothScrollOptions = {},
): void {
  activeScrollCancel?.();

  const scrollEl = resolveScrollElement(target);
  const start = scrollEl.scrollTop;
  const end = getTargetScrollTop(target, scrollEl, offset);

  if (Math.abs(end - start) < 2) {
    scrollEl.scrollTop = end;
    return;
  }

  if (prefersReducedMotion()) {
    scrollEl.scrollTop = end;
    return;
  }

  const distance = Math.abs(end - start);
  const duration = Math.min(720, Math.max(420, distance * 0.55));
  const startTime = performance.now();
  let frame = 0;
  let cancelled = false;

  activeScrollCancel = () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    activeScrollCancel = null;
  };

  const tick = (now: number) => {
    if (cancelled) return;

    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    scrollEl.scrollTop = start + (end - start) * easeOutCubic(progress);

    if (progress < 1) {
      frame = requestAnimationFrame(tick);
    } else {
      scrollEl.scrollTop = end;
      activeScrollCancel = null;
    }
  };

  frame = requestAnimationFrame(tick);
}

export function smoothScrollToHash(
  hash: string,
  options?: SmoothScrollOptions,
): boolean {
  const id = hash.replace(/^#/, '');
  if (!id) return false;

  const target = document.getElementById(id);
  if (!target) return false;

  smoothScrollToElement(target, options);
  return true;
}
