import React, {useCallback, useEffect, useState, useMemo} from 'react';
import Video from 'react-native-video';

type UseVideoDurationsResult = {
  durations: number[];
  recordDuration: (idx: number, durationSeconds: number) => void;
  preloadNode: React.ReactNode;
};

/**
 * Preloads each URL (one at a time) to read its duration from <Video onLoad>.
 * Also exposes recordDuration(idx, duration) so your "real" players can fill gaps.
 */
const preloadVideoStyle = {width: 1, height: 1, opacity: 0};

export function useVideoDurations(urls: string[]): UseVideoDurationsResult {
  const [durations, setDurations] = useState<number[]>(() =>
    Array(urls.length).fill(NaN),
  );

  // Reset whenever the URL list changes.
  useEffect(() => {
    setDurations(Array(urls.length).fill(NaN));
  }, [urls]);

  const recordDuration = useCallback(
    (idx: number, durationSeconds: number) => {
      if (idx < 0 || idx >= urls.length) {
        return;
      }

      const d = Number(durationSeconds);
      if (!Number.isFinite(d) || d <= 0) {
        return;
      }

      setDurations(prev => {
        const next =
          prev.length === urls.length
            ? [...prev]
            : Array(urls.length).fill(NaN);

        // Keep the larger value if we ever get multiple reports.
        const prevD = next[idx];
        next[idx] = Number.isFinite(prevD) ? Math.max(prevD, d) : d;

        return next;
      });
    },
    [urls.length],
  );

  // Find the first missing duration; preload it.
  const preloadIndex = useMemo(() => {
    if (!urls.length) {
      return -1;
    }
    return durations.findIndex(d => !Number.isFinite(d));
  }, [durations, urls.length]);

  const done = urls.length === 0 || preloadIndex === -1;

  const preloadNode = !done ? (
    <Video
      // force remount per URL to avoid stale onLoad behaviour
      key={`dur-preload-${preloadIndex}-${urls[preloadIndex]}`}
      source={{uri: urls[preloadIndex], bufferConfig: {cacheSizeMB: 200}}}
      paused={true}
      muted={true}
      controls={false}
      playInBackground={false}
      playWhenInactive={false}
      onLoad={(e: any) => recordDuration(preloadIndex, e?.duration)}
      style={preloadVideoStyle}
    />
  ) : null;

  return {
    durations,
    recordDuration,
    preloadNode,
  };
}
