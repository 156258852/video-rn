import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {useLatestRef} from './useLatestRef';

// ======================= 类型定义 =======================
type SeekRequest = {idx: number; time: number};
type ClipForTime = {idx: number; local: number};

export type VideoSlotProps = {
  ref: React.RefObject<any>;
  source?: {uri: string; bufferConfig?: {cacheSizeMB?: number}};
  paused: boolean;
  onLoad?: (e: any) => void;
  onProgress?: (e: any) => void;
  onEnd?: () => void;
  onBuffer?: (e: any) => void;
  onError?: (e: any) => void;
};

type Params = {
  urls: string[];
  durations: number[];
  recordDuration?: (idx: number, durationSeconds: number) => void;
  isSeeking: boolean;
  getClipForTime?: (t: number) => ClipForTime;
};

type SeekOptions = {play?: boolean};

// ======================= 常量 =======================
const BUFFER_CONFIG = {cacheSizeMB: 200};
const COMPLETION_RATIO = 0.98;
const MAX_PROGRESS_STEP = 1.5;

export function useVideoSequencePlayer({
  urls,
  durations,
  recordDuration,
  isSeeking,
  getClipForTime,
}: Params) {
  // ======================= 基础 Refs =======================
  const playerRef0 = useRef<any>(null);
  const playerRef1 = useRef<any>(null);
  const playerRefs = useMemo(() => [playerRef0, playerRef1] as const, []);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  // ======================= 核心状态 =======================
  const [activePlayer, setActivePlayer] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hasCompletedPlayback, setHasCompletedPlayback] = useState(false);
  const [version, setVersion] = useState(0);
  const [times, setTimes] = useState<number[]>([]);

  const activePlayerRef = useLatestRef(activePlayer);
  const currentIndexRef = useLatestRef(currentIndex);
  const playingRef = useLatestRef(playing);
  const isSeekingRef = useLatestRef(isSeeking);
  const timesRef = useLatestRef(times);

  const currentTimeRef = useRef(0);

  const [isLoading, setIsLoading] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState<any>(null);
  const prevBufferingRef = useRef(false);
  const needsProgressClearRef = useRef(true);

  const pendingSeekRef = useRef<SeekRequest | null>(null);
  const pendingResumeRef = useRef<SeekRequest | null>(null);
  const isSeekingInternalRef = useRef(false);

  const loadedSlotRef = useRef<
    Record<number, {clipIdx: number; uri: string} | null>
  >({
    0: null,
    1: null,
  });

  const watchedSecondsRef = useRef(0);
  const lastProgressRef = useRef<{idx: number; time: number} | null>(null);

  const [pendingSeekTarget, setPendingSeekTarget] = useState<number | null>(
    null,
  );

  const [resumeVersion, setResumeVersion] = useState(0);
  const [resumeCleanupVersion, setResumeCleanupVersion] = useState(0);
  const resumeKeyRef = useRef(0);

  // ======================= 辅助函数 =======================
  const bumpVersion = useCallback(() => setVersion(v => v + 1), []);

  const applyLocalTime = useCallback(
    (clipIdx: number, t: number) => {
      if (clipIdx < 0 || clipIdx >= urls.length) return;
      currentTimeRef.current = t;
      setTimes(prev => {
        const next =
          prev.length === urls.length ? [...prev] : Array(urls.length).fill(0);
        next[clipIdx] = t;
        return next;
      });
    },
    [urls.length],
  );

  const seekOnActive = useCallback(
    (t: number) => {
      playerRefs[activePlayerRef.current]?.current?.seek?.(t);
    },
    [activePlayerRef, playerRefs],
  );

  const getTotalDuration = useCallback(
    () =>
      durations.reduce((s, d) => (Number.isFinite(d) && d > 0 ? s + d : s), 0),
    [durations],
  );

  const allDurationsKnown = useCallback(
    () =>
      durations.length === urls.length &&
      durations.every(d => Number.isFinite(d) && d > 0),
    [durations, urls.length],
  );

  const finalizeClip = useCallback(
    (clipIdx: number) => {
      const d = durations[clipIdx] ?? 0;
      const lp = lastProgressRef.current;
      if (!Number.isFinite(d) || d <= 0 || !lp || lp.idx !== clipIdx) return;
      const tail = d - lp.time;
      if (tail > 0 && tail <= MAX_PROGRESS_STEP)
        watchedSecondsRef.current += tail;
      lastProgressRef.current = {idx: clipIdx, time: d};
    },
    [durations],
  );

  const flushPendingSeek = useCallback(
    (targetPlayerIdx: number, targetClipIdx: number) => {
      const loaded = loadedSlotRef.current[targetPlayerIdx];
      if (
        loaded?.clipIdx === targetClipIdx &&
        loaded.uri === urls[targetClipIdx]
      ) {
        const time = pendingSeekRef.current?.time ?? 0;
        pendingSeekRef.current = null;
        applyLocalTime(targetClipIdx, time);
        lastProgressRef.current = {idx: targetClipIdx, time};
        isSeekingInternalRef.current = true;
        playerRefs[targetPlayerIdx]?.current?.seek?.(time);
        const clear = () => {
          isSeekingInternalRef.current = false;
        };
        typeof queueMicrotask === 'function'
          ? queueMicrotask(clear)
          : Promise.resolve().then(clear);
        setPendingSeekTarget(null);
      }
    },
    [applyLocalTime, playerRefs, urls],
  );

  // ======================= 回调实现 =======================
  const onLoad = useCallback(
    (playerIdx: number, clipIdx: number, e: any) => {
      loadedSlotRef.current[playerIdx] = {clipIdx, uri: urls[clipIdx] ?? ''};

      const d = Number(e?.duration);
      if (recordDuration && Number.isFinite(d)) recordDuration(clipIdx, d);

      if (playerIdx === activePlayerRef.current) setError(null);

      if (pendingSeekRef.current?.idx === clipIdx) {
        const time = pendingSeekRef.current.time;
        pendingSeekRef.current = null;
        applyLocalTime(clipIdx, time);
        lastProgressRef.current = {idx: clipIdx, time};
        isSeekingInternalRef.current = true;
        playerRefs[playerIdx]?.current?.seek?.(time);
        const clear = () => {
          isSeekingInternalRef.current = false;
        };
        typeof queueMicrotask === 'function'
          ? queueMicrotask(clear)
          : Promise.resolve().then(clear);
        setPendingSeekTarget(null);
        return;
      }

      if (pendingResumeRef.current?.idx === clipIdx) {
        const time = pendingResumeRef.current.time;
        pendingResumeRef.current = null;
        applyLocalTime(clipIdx, time);
        lastProgressRef.current = {idx: clipIdx, time};
        playerRefs[playerIdx]?.current?.seek?.(time);
        setResumeCleanupVersion(v => v + 1);
        return;
      }

      if (playerIdx !== activePlayerRef.current) {
        playerRefs[playerIdx]?.current?.seek?.(0);
      }
    },
    [activePlayerRef, applyLocalTime, playerRefs, recordDuration, urls],
  );

  const onProgress = useCallback(
    (clipIdx: number, e: any) => {
      if (isSeekingRef.current || isSeekingInternalRef.current) return;
      if (clipIdx !== currentIndexRef.current) return;

      if (needsProgressClearRef.current) {
        needsProgressClearRef.current = false;
        setIsLoading(false);
      }

      const t = Number(e?.currentTime ?? 0);
      const prev = lastProgressRef.current;
      if (prev && prev.idx === clipIdx) {
        const delta = t - prev.time;
        if (delta > 0 && delta <= MAX_PROGRESS_STEP)
          watchedSecondsRef.current += delta;
      }
      lastProgressRef.current = {idx: clipIdx, time: t};
      applyLocalTime(clipIdx, t);
    },
    [applyLocalTime, currentIndexRef, isSeekingRef],
  );

  const onEnd = useCallback(
    (clipIdx: number, playerIdx: number) => {
      if (playerIdx !== activePlayerRef.current) return;
      if (pendingSeekRef.current && pendingSeekRef.current.idx !== clipIdx)
        return;
      if (clipIdx !== currentIndexRef.current) return;

      if (clipIdx < urls.length - 1) {
        const nextIdx = clipIdx + 1;
        const nextPlayer = activePlayerRef.current === 0 ? 1 : 0;

        clearTimer();
        finalizeClip(clipIdx);

        setTimes(prev => {
          const next =
            prev.length === urls.length
              ? [...prev]
              : Array(urls.length).fill(0);
          next[clipIdx] = durations[clipIdx] ?? prev[clipIdx] ?? 0;
          next[nextIdx] = 0;
          return next;
        });

        currentTimeRef.current = 0;
        pendingSeekRef.current = {idx: nextIdx, time: 0};
        setPendingSeekTarget(nextIdx);
        setIsLoading(true);
        needsProgressClearRef.current = true;

        setActivePlayer(nextPlayer);
        setCurrentIndex(nextIdx);
        flushPendingSeek(nextPlayer, nextIdx);
        bumpVersion();
      } else {
        clearTimer();
        finalizeClip(clipIdx);

        const dur = durations[clipIdx] ?? 0;
        const endT = Number.isFinite(dur) ? dur : currentTimeRef.current;
        currentTimeRef.current = endT;

        setTimes(prev => {
          const next =
            prev.length === urls.length
              ? [...prev]
              : Array(urls.length).fill(0);
          next[clipIdx] = endT;
          return next;
        });

        bumpVersion();
        setPlaying(false);

        const total = getTotalDuration();
        if (
          allDurationsKnown() &&
          total > 0 &&
          watchedSecondsRef.current >= total * COMPLETION_RATIO
        ) {
          setHasCompletedPlayback(true);
        }
      }
    },
    [
      activePlayerRef,
      currentIndexRef,
      bumpVersion,
      clearTimer,
      durations,
      finalizeClip,
      flushPendingSeek,
      getTotalDuration,
      allDurationsKnown,
      urls.length,
    ],
  );

  const onBuffer = useCallback(
    (playerIdx: number, e: any) => {
      if (playerIdx !== activePlayerRef.current) return;
      const buf = !!e?.isBuffering;
      if (prevBufferingRef.current !== buf) {
        prevBufferingRef.current = buf;
        setIsBuffering(buf);
      }
    },
    [activePlayerRef],
  );

  const onError = useCallback(
    (playerIdx: number, e: any) => {
      if (playerIdx !== activePlayerRef.current) return;
      setIsLoading(false);
      setError(e);
    },
    [activePlayerRef],
  );

  // ======================= 稳定回调包装（改用 useLatestRef） =======================
  const callbacksRef = useLatestRef({
    onLoad,
    onProgress,
    onEnd,
    onBuffer,
    onError,
  });

  const stableRef = useRef({
    onLoad: (pi: number, ci: number, e: any) =>
      callbacksRef.current.onLoad(pi, ci, e),
    onProgress: (ci: number, e: any) => callbacksRef.current.onProgress(ci, e),
    onEnd: (ci: number, pi: number) => callbacksRef.current.onEnd(ci, pi),
    onBuffer: (pi: number, e: any) => callbacksRef.current.onBuffer(pi, e),
    onError: (pi: number, e: any) => callbacksRef.current.onError(pi, e),
  });

  // ======================= 公共 API =======================
  const seekToClip = useCallback(
    (idx: number, localSeconds: number, opts?: SeekOptions) => {
      if (urls.length === 0) return;
      const play = opts?.play ?? true;
      const nextIdx = Math.max(0, Math.min(urls.length - 1, idx));
      let t = Math.max(0, Number(localSeconds) || 0);
      const dur = durations[nextIdx] ?? 0;
      if (Number.isFinite(dur) && t > dur) t = dur;

      setHasCompletedPlayback(false);
      applyLocalTime(nextIdx, t);
      lastProgressRef.current = {idx: nextIdx, time: t};

      if (nextIdx !== currentIndexRef.current) {
        const nextPlayer = activePlayerRef.current === 0 ? 1 : 0;
        pendingSeekRef.current = {idx: nextIdx, time: t};
        setPendingSeekTarget(nextIdx);
        setIsLoading(true);
        needsProgressClearRef.current = true;
        setActivePlayer(nextPlayer);
        setCurrentIndex(nextIdx);
        flushPendingSeek(nextPlayer, nextIdx);
      } else {
        seekOnActive(t);
      }

      if (play) setPlaying(true);
    },
    [
      applyLocalTime,
      flushPendingSeek,
      currentIndexRef,
      activePlayerRef,
      durations,
      seekOnActive,
      urls.length,
    ],
  );

  const queueResumeForCurrentClip = useCallback((): SeekRequest => {
    const idx = currentIndexRef.current;
    const localT =
      Number.isFinite(currentTimeRef.current) && currentTimeRef.current >= 0
        ? currentTimeRef.current
        : timesRef.current[idx] ?? 0;
    const payload = {idx, time: localT};
    pendingResumeRef.current = payload;
    setIsLoading(true);
    needsProgressClearRef.current = true;
    resumeKeyRef.current += 1;
    setResumeVersion(v => v + 1);
    return payload;
  }, []);

  const seekVirtual = useCallback(
    (t: number, opts?: SeekOptions) => {
      if (!getClipForTime) return;
      const r = getClipForTime(t);
      seekToClip(r.idx, r.local, opts);
    },
    [getClipForTime, seekToClip],
  );

  const inactiveIndex = useMemo(() => {
    if (urls.length === 0) return -1;
    if (pendingSeekTarget !== null && pendingSeekTarget !== currentIndex) {
      return Math.min(pendingSeekTarget + 1, urls.length - 1);
    }
    return Math.min(currentIndex + 1, urls.length - 1);
  }, [currentIndex, urls.length, pendingSeekTarget]);

  useLayoutEffect(() => {
    [0, 1].forEach(i => {
      const isActive = i === activePlayer;
      const videoIndex = isActive ? currentIndex : inactiveIndex;
      if (videoIndex < 0 || videoIndex >= urls.length) {
        loadedSlotRef.current[i] = null;
      }
    });
  }, [activePlayer, currentIndex, inactiveIndex, urls.length]);

  useEffect(() => {
    clearTimer();
    setActivePlayer(0);
    setCurrentIndex(0);
    setPlaying(false);
    setHasCompletedPlayback(false);
    currentTimeRef.current = 0;
    watchedSecondsRef.current = 0;
    lastProgressRef.current = null;
    pendingSeekRef.current = null;
    pendingResumeRef.current = null;
    setPendingSeekTarget(null);
    loadedSlotRef.current = {0: null, 1: null};
    setTimes(Array(urls.length).fill(0));
    setIsLoading(true);
    setIsBuffering(false);
    setError(null);
    prevBufferingRef.current = false;
    needsProgressClearRef.current = true;
    bumpVersion();
  }, [urls, bumpVersion, clearTimer]);

  const videoSlots: VideoSlotProps[] = useMemo(() => {
    return [0, 1].map(i => {
      const isActive = i === activePlayer;
      const videoIndex = isActive ? currentIndex : inactiveIndex;

      if (videoIndex < 0 || videoIndex >= urls.length) {
        return {
          ref: playerRefs[i],
          source: undefined,
          paused: true,
          onLoad: undefined,
          onProgress: undefined,
          onEnd: undefined,
          onBuffer: undefined,
          onError: undefined,
        };
      }

      let uri = urls[videoIndex] ?? '';
      if (isActive && pendingResumeRef.current) {
        const sep = uri.includes('?') ? '&' : '?';
        uri = `${uri}${sep}_resume=${resumeKeyRef.current}`;
      }

      return {
        ref: playerRefs[i],
        source: uri ? {uri, bufferConfig: BUFFER_CONFIG} : undefined,
        paused: isActive ? !playing : true,
        onLoad: (e: any) => stableRef.current.onLoad(i, videoIndex, e),
        onProgress: isActive
          ? (e: any) => stableRef.current.onProgress(videoIndex, e)
          : undefined,
        onEnd: isActive
          ? () => stableRef.current.onEnd(videoIndex, i)
          : undefined,
        onBuffer: (e: any) => stableRef.current.onBuffer(i, e),
        onError: (e: any) => stableRef.current.onError(i, e),
      };
    });
  }, [
    activePlayer,
    currentIndex,
    inactiveIndex,
    playerRefs,
    playing,
    urls,
    resumeVersion,
    resumeCleanupVersion,
  ]);

  return {
    videoSlots,
    activePlayer,
    playing,
    setPlaying,
    playingRef,
    hasCompletedPlayback,
    isLoading,
    setIsLoading,
    isBuffering,
    error,
    currentIndex,
    currentTimeRef,
    times,
    version,
    seekToClip,
    seekVirtual,
    queueResumeForCurrentClip,
  };
}
