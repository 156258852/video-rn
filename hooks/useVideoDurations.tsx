import React, {useCallback, useState, useMemo} from 'react';
import {Platform, View} from 'react-native';
import Video, {ViewType} from 'react-native-video';

type OnLoadData = {duration: number};

type UseVideoDurationsResult = {
  durations: number[];
  recordDuration: (idx: number, durationSeconds: number) => void;
  preloadNode: React.ReactNode;
};

type UseVideoDurationsOptions = {
  /**
   * When false, do not mount the hidden <Video> preloader node.
   * Useful when durations/preload are managed by an outer provider layer.
   */
  enabled?: boolean;
};

/**
 * Preloads each URL (one at a time) to read its duration from <Video onLoad>.
 * Also exposes recordDuration(idx, duration) so your "real" players can fill gaps.
 */
const preloadVideoStyle = {width: 1, height: 1, opacity: 0};

export function useVideoDurations(
  urls: string[],
  options?: UseVideoDurationsOptions,
): UseVideoDurationsResult {
  const enabled = options?.enabled ?? true;

  const [durations, setDurations] = useState<number[]>(() =>
    Array(urls.length).fill(NaN),
  );

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

  const done = !enabled || urls.length === 0 || preloadIndex === -1;

  const preloadNode = !done ? (
    <View pointerEvents="none">
      <Video
        // force remount per URL to avoid stale onLoad behaviour
        key={`dur-preload-${preloadIndex}-${urls[preloadIndex]}`}
        pointerEvents="none"
        source={{uri: urls[preloadIndex], bufferConfig: {cacheSizeMB: 200}}}
        paused
        muted
        controls={false}
        playInBackground={false}
        playWhenInactive={false}
        viewType={Platform.OS === 'android' ? ViewType.TEXTURE : undefined}
        onLoad={(e: OnLoadData) => recordDuration(preloadIndex, e.duration)}
        style={preloadVideoStyle}
      />
    </View>
  ) : null;

  return {
    durations,
    recordDuration,
    preloadNode,
  };
}
