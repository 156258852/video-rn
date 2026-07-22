import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Platform, View} from 'react-native';
import Video, {ViewType} from 'react-native-video';

type OnLoadData = {
  duration: number;
};

type UseVideoDurationsResult = {
  durations: number[];
  recordDuration: (idx: number, durationSeconds: number) => void;
  preloadNode: React.ReactNode;
};

type UseVideoDurationsOptions = {
  enabled?: boolean;
  preloadConcurrency?: number;
  preloadTimeoutMs?: number;
  maxRetryRounds?: number;
};

type DurationPreloadVideoProps = {
  url: string;
  timeoutMs: number;
  onLoaded: (url: string, durationSeconds: number) => void;
  onFailed: (url: string) => void;
};

const preloadVideoStyle = {
  width: 1,
  height: 1,
  opacity: 0,
};

const MAX_PARALLEL_PRELOADS = 3;
const DEFAULT_MAX_RETRY_ROUNDS = 3;
const DEFAULT_PRELOAD_TIMEOUT_MS = 30000;

// Module-level cache: durations survive component remounts (e.g. key changes)
const durationCache = new Map<string, number>();

const DurationPreloadVideo = ({
  url,
  timeoutMs,
  onLoaded,
  onFailed,
}: DurationPreloadVideoProps): React.ReactElement => {
  const settledRef = useRef(false);

  const handleLoad = useCallback(
    (event: OnLoadData) => {
      if (settledRef.current) {
        return;
      }

      const duration = Number(event.duration);
      settledRef.current = true;

      if (!Number.isFinite(duration) || duration <= 0) {
        onFailed(url);
        return;
      }

      onLoaded(url, duration);
    },
    [onFailed, onLoaded, url],
  );

  const handleError = useCallback(() => {
    if (settledRef.current) {
      return;
    }

    settledRef.current = true;
    onFailed(url);
  }, [onFailed, url]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (settledRef.current) {
        return;
      }

      settledRef.current = true;
      onFailed(url);
    }, timeoutMs);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [onFailed, timeoutMs, url]);

  return (
    <Video
      pointerEvents="none"
      source={{
        uri: url,
        bufferConfig: {
          cacheSizeMB: 200,
        },
      }}
      paused
      muted
      controls={false}
      playInBackground={false}
      playWhenInactive={false}
      viewType={Platform.OS === 'android' ? ViewType.TEXTURE : undefined}
      onLoad={handleLoad}
      onError={handleError}
      style={preloadVideoStyle}
    />
  );
};

export function useVideoDurations(
  urls: string[],
  options?: UseVideoDurationsOptions,
): UseVideoDurationsResult {
  const isEnabled = options?.enabled ?? true;

  const requestedConcurrency =
    options?.preloadConcurrency ?? MAX_PARALLEL_PRELOADS;

  const preloadConcurrency =
    Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? Math.floor(requestedConcurrency)
      : MAX_PARALLEL_PRELOADS;

  const requestedMaxRetryRounds =
    options?.maxRetryRounds ?? DEFAULT_MAX_RETRY_ROUNDS;

  const maxRetryRounds =
    Number.isFinite(requestedMaxRetryRounds) && requestedMaxRetryRounds >= 0
      ? Math.floor(requestedMaxRetryRounds)
      : DEFAULT_MAX_RETRY_ROUNDS;

  const requestedTimeoutMs =
    options?.preloadTimeoutMs ?? DEFAULT_PRELOAD_TIMEOUT_MS;

  const preloadTimeoutMs =
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.floor(requestedTimeoutMs)
      : DEFAULT_PRELOAD_TIMEOUT_MS;

  const urlsKey = useMemo(() => JSON.stringify(urls), [urls]);

  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  const currentUrlSetRef = useRef<Set<string>>(new Set(urls));
  currentUrlSetRef.current = new Set(urls);

  const [durationByUrl, setDurationByUrl] = useState<Record<string, number>>(
    () => Object.fromEntries(durationCache),
  );

  const [roundFailedUrls, setRoundFailedUrls] = useState<Set<string>>(
    () => new Set(),
  );
  const [retryRound, setRetryRound] = useState(0);
  const [activePreloadUrls, setActivePreloadUrls] = useState<string[]>([]);

  const durations = useMemo(
    () =>
      urls.map(url => {
        const duration = durationByUrl[url];
        return Number.isFinite(duration) ? duration : NaN;
      }),
    [urls, durationByUrl],
  );

  const recordDurationForUrl = useCallback(
    (url: string, durationSeconds: number) => {
      const duration = Number(durationSeconds);

      if (!url || !Number.isFinite(duration) || duration <= 0) {
        return;
      }
      durationCache.set(url, duration);

      setDurationByUrl(prev => {
        if (prev[url] === duration) {
          return prev;
        }

        return {
          ...prev,
          [url]: duration,
        };
      });

      setRoundFailedUrls(prev => {
        if (!prev.has(url)) {
          return prev;
        }

        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    },
    [],
  );

  const recordDuration = useCallback(
    (idx: number, durationSeconds: number) => {
      if (!Number.isInteger(idx) || idx < 0 || idx >= urlsRef.current.length) {
        return;
      }

      const url = urlsRef.current[idx];

      if (!url) {
        return;
      }

      recordDurationForUrl(url, durationSeconds);
    },
    [recordDurationForUrl],
  );

  const recordFailureForUrl = useCallback((url: string) => {
    if (!currentUrlSetRef.current.has(url)) {
      return;
    }

    setRoundFailedUrls(prev => {
      if (prev.has(url)) {
        return prev;
      }

      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  const missingUrls = useMemo(() => {
    const seen = new Set<string>();

    return urls.filter(url => {
      if (!url || seen.has(url)) {
        return false;
      }

      seen.add(url);

      return !Number.isFinite(durationByUrl[url]) && !roundFailedUrls.has(url);
    });
  }, [urls, durationByUrl, roundFailedUrls]);

  useEffect(() => {
    setRoundFailedUrls(new Set());
    setRetryRound(0);
    setActivePreloadUrls([]);
  }, [urlsKey]);

  useEffect(() => {
    if (!isEnabled) {
      setActivePreloadUrls(prev => (prev.length === 0 ? prev : []));
      return;
    }

    setActivePreloadUrls(prev => {
      const missingUrlSet = new Set(missingUrls);
      const next = prev.filter(url => missingUrlSet.has(url));
      const nextSet = new Set(next);
      const availableSlots = preloadConcurrency - next.length;

      if (availableSlots > 0) {
        missingUrls
          .filter(url => !nextSet.has(url))
          .slice(0, availableSlots)
          .forEach(url => {
            next.push(url);
            nextSet.add(url);
          });
      }

      if (
        next.length === prev.length &&
        next.every((url, idx) => url === prev[idx])
      ) {
        return prev;
      }

      return next;
    });
  }, [isEnabled, missingUrls, preloadConcurrency]);

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    if (missingUrls.length > 0 || activePreloadUrls.length > 0) {
      return;
    }

    if (roundFailedUrls.size === 0 || retryRound >= maxRetryRounds) {
      return;
    }

    setRoundFailedUrls(new Set());
    setRetryRound(prev => prev + 1);
  }, [
    isEnabled,
    missingUrls,
    activePreloadUrls,
    roundFailedUrls,
    retryRound,
    maxRetryRounds,
  ]);

  const preloadNode =
    isEnabled && activePreloadUrls.length > 0 ? (
      <View pointerEvents="none">
        {activePreloadUrls.map(url => (
          <DurationPreloadVideo
            key={`${url}:${retryRound}`}
            url={url}
            timeoutMs={preloadTimeoutMs}
            onLoaded={recordDurationForUrl}
            onFailed={recordFailureForUrl}
          />
        ))}
      </View>
    ) : null;

  return {
    durations,
    recordDuration,
    preloadNode,
  };
}
