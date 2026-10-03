import { useEffect, useRef, useState } from 'react';

export function isRectInView(
  rect: { top: number; bottom: number },
  viewportHeight: number,
): boolean {
  return rect.bottom > 0 && rect.top < viewportHeight;
}

/**
 * Section copy starts shown so prerendered HTML is readable.
 * Off-screen blocks drop `.is-shown` after hydration, then play the
 * stagger once when they enter the viewport.
 */
export function useInViewOnce<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return;
    }

    if (isRectInView(node.getBoundingClientRect(), window.innerHeight)) {
      setShown(true);
      return;
    }

    setShown(false);

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.01 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, shown };
}
