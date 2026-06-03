import { useEffect, useRef, useState } from 'react';

import type { FeatureId, FeatureVideo as FeatureVideoData } from '../data/features';
import { FeatureVisual } from './feature-visuals';

type FeatureVideoProps = {
  id: FeatureId;
  video: FeatureVideoData;
  title: string;
};

/**
 * Plays a short, silent, looping screen recording inside the feature frame.
 * The clip is only loaded once the frame scrolls into view, plays while
 * visible, and pauses when it leaves the viewport. If the source is missing
 * or fails to load, the synthetic FeatureVisual is shown instead so the page
 * never renders an empty frame.
 */
export function FeatureVideo({ id, video, title }: FeatureVideoProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setShouldLoad(true);
          }
          setIsVisible(entry.isIntersecting);
        });
      },
      { rootMargin: '200px 0px', threshold: 0.1 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Load the clip once shouldLoad flips true and the <source> nodes are mounted.
  useEffect(() => {
    if (!shouldLoad) return;
    videoRef.current?.load();
  }, [shouldLoad]);

  // Play while visible, pause when scrolled away. Runs after sources exist.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !shouldLoad) return;
    if (isVisible) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [shouldLoad, isVisible]);

  if (failed) {
    return <FeatureVisual id={id} />;
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none p-3 sm:p-4"
    >
      <video
        ref={videoRef}
        className="w-full max-w-2xl max-h-full rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] object-contain bg-black/60"
        poster={video.poster}
        muted
        loop
        playsInline
        autoPlay
        preload="none"
        aria-label={`${title} demo`}
        onError={() => setFailed(true)}
      >
        {shouldLoad && <source src={video.src} type="video/webm" />}
      </video>
    </div>
  );
}

export default FeatureVideo;
