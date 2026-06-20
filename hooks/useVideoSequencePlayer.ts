import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useLatestRef} from './useLatestRef';

type SeekRequest = {idx: number; time: number};

type ClipForTime = {
  idx: number;
  local: number;
};

export type VideoSlotProps = {
  ref: React.RefObject<any>;
  source?: {uri: string; bufferConfig?: {cacheSizeMB?: number}};
  paused: boolean;
  onLoad?: (e: any) => void;
  onProgress?: (e: any) => void;
  onEnd?: () => void;
};

type UseVideoSequencePlayerParams = {
  urls: string[];
  durations: number[];
  recordDuration?: (idx: number, durationSeconds: number) => void;
  isSeeking: boolean;
  getClipForTime?: (t: number) => ClipForTime;
};

type SeekToClipOptions = {
  play?: boolean;
};

export function useVideoSequencePlayer({
  urls,
  durations,
  recordDuration,
  isSeeking,
  getClipForTime,
}: UseVideoSequencePlayerParams) {
  const COMPLETION_WATCH_RATIO = 0.98;
  const MAX_NATURAL_PROGRESS_STEP_SECONDS = 1.5;

  // ---------------- refs ----------------
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
    return () => clearTimer(); // ✅ 防内存泄漏
  }, [clearTimer]);

  // ---------------- player state ----------------
  const [activePlayer, setActivePlayer] = useState(0);
  const activePlayerRef = useLatestRef(activePlayer);

  const [playing, setPlaying] = useState(false);
  const playingRef = useLatestRef(playing);

  const [hasCompletedPlayback, setHasCompletedPlayback] = useState(false);

  const [currentIndex, setCurrentIndex] = useState(0);
  const currentIndexRef = useLatestRef(currentIndex);

  const currentTimeRef = useRef(0);

  // version is only bumped on meaningful state changes (seek / clip switch),
  // NOT on every progress tick, to avoid unnecessary re-renders.
  const [version, setVersion] = useState(0);
  const bumpVersion = useCallback(() => {
    setVersion(v => v + 1);
  }, []);

  const [times, setTimes] = useState<number[]>([]);

  const pendingSeekRef = useRef<SeekRequest | null>(null);
  const pendingResumeRef = useRef<SeekRequest | null>(null);
  const isSeekingInternalRef = useRef(false);
  // Tracks which clip each player slot has loaded, keyed by player index.
  // Used to detect when a pending seek target is already preloaded so we can
  // seek immediately without waiting for another onLoad that will never come.
  const loadedSlotRef = useRef<
    Record<number, {clipIdx: number; uri: string} | null>
  >({0: null, 1: null});
  const watchedSecondsRef = useRef(0);
  const lastProgressRef = useRef<{idx: number; time: number} | null>(null);

  const getKnownTotalDuration = useCallback(() => {
    return durations.reduce((sum, d) => {
      const dd = Number(d);
      return Number.isFinite(dd) && dd > 0 ? sum + dd : sum;
    }, 0);
  }, [durations]);

  const finalizeClipWatch = useCallback(
    (clipIdx: number) => {
      const d = Number(durations[clipIdx]);
      const lp = lastProgressRef.current;

      if (!Number.isFinite(d) || d <= 0 || !lp || lp.idx !== clipIdx) {
        return;
      }

      // Only top-up short tail near the end; large gaps are likely seek jumps.
      const tail = d - lp.time;
      if (tail > 0 && tail <= MAX_NATURAL_PROGRESS_STEP_SECONDS) {
        watchedSecondsRef.current += tail;
      }

      lastProgressRef.current = {idx: clipIdx, time: d};
    },
    [durations],
  );

  // ---------------- reset ----------------
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
    loadedSlotRef.current = {0: null, 1: null};

    setTimes(Array(urls.length).fill(0));

    bumpVersion();
  }, [urls, bumpVersion, clearTimer]);

  // ---------------- helpers ----------------
  const applyLocalTime = useCallback(
    (clipIdx: number, t: number) => {
      // Bounds check to prevent out-of-range writes
      if (clipIdx < 0 || clipIdx >= urls.length) {
        return;
      }

      currentTimeRef.current = t;

      // Only update state (triggering re-render) — no bumpVersion here.
      // bumpVersion is reserved for seek / clip-switch events.
      setTimes(prev => {
        const next =
          prev.length === urls.length ? [...prev] : Array(urls.length).fill(0);
        next[clipIdx] = t;
        return next;
      });
    },
    [urls.length],
  );

  const seekOnActivePlayer = useCallback(
    (t: number) => {
      const player = playerRefs[activePlayerRef.current]?.current;
      player?.seek?.(t);
    },
    [activePlayerRef, playerRefs],
  );

  // When seekToClip or onEnd targets a cross-clip switch, check immediately
  // whether the target player already has that clip loaded from preload.
  // If so, seek it without waiting for an onLoad that will never fire again.
  const checkAndFlushPendingSeek = useCallback(
    (targetPlayerIdx: number, targetClipIdx: number) => {
      const loaded = loadedSlotRef.current[targetPlayerIdx];
      if (
        loaded?.clipIdx === targetClipIdx &&
        loaded.uri === (urls[targetClipIdx] ?? '')
      ) {
        const time = pendingSeekRef.current?.time ?? 0;
        pendingSeekRef.current = null;
        applyLocalTime(targetClipIdx, time);
        lastProgressRef.current = {idx: targetClipIdx, time};
        isSeekingInternalRef.current = true;
        playerRefs[targetPlayerIdx]?.current?.seek?.(time);
        if (typeof queueMicrotask === 'function') {
          queueMicrotask(() => {
            isSeekingInternalRef.current = false;
          });
        } else {
          Promise.resolve().then(() => {
            isSeekingInternalRef.current = false;
          });
        }
      }
    },
    [applyLocalTime, playerRefs, urls],
  );

  // ---------------- events ----------------

  const onClipLoad = useCallback(
    (playerIdx: number, clipIdx: number, e: any) => {
      // Record that this player slot has finished loading this clip.
      loadedSlotRef.current[playerIdx] = {clipIdx, uri: urls[clipIdx] ?? ''};

      const d = Number(e?.duration);
      if (recordDuration && Number.isFinite(d)) {
        recordDuration(clipIdx, d);
      }

      // Pending seek — source just loaded for a cross-clip seek or auto-advance.
      // Seek immediately now that the player is ready (no setTimeout needed).
      if (pendingSeekRef.current?.idx === clipIdx) {
        if (clipIdx === currentIndexRef.current) {
          const time = pendingSeekRef.current.time;
          pendingSeekRef.current = null;
          applyLocalTime(clipIdx, time);
          lastProgressRef.current = {idx: clipIdx, time};
          // Block onClipProgress from updating times while we seek.
          // Use a flag rather than state to avoid setState overhead.
          // The flag is cleared synchronously after seek to minimize lag.
          isSeekingInternalRef.current = true;
          seekOnActivePlayer(time);
          // Clear immediately in next microtask to unblock onClipProgress quickly.
          // queueMicrotask may be unavailable in some RN/Jest runtimes.
          if (typeof queueMicrotask === 'function') {
            queueMicrotask(() => {
              isSeekingInternalRef.current = false;
            });
          } else {
            Promise.resolve().then(() => {
              isSeekingInternalRef.current = false;
            });
          }
        }
        return;
      }

      // Pending resume (after fullscreen toggle / remount).
      if (pendingResumeRef.current?.idx === clipIdx) {
        if (clipIdx === currentIndexRef.current) {
          const time = pendingResumeRef.current.time;
          pendingResumeRef.current = null;
          applyLocalTime(clipIdx, time);
          lastProgressRef.current = {idx: clipIdx, time};
          seekOnActivePlayer(time);
        }
      }
    },
    [applyLocalTime, currentIndexRef, recordDuration, seekOnActivePlayer, urls],
  );

  const onClipProgress = useCallback(
    (clipIdx: number, e: any) => {
      if (isSeeking || isSeekingInternalRef.current) {
        return;
      }
      if (clipIdx !== currentIndexRef.current) {
        return;
      }

      const t = Number(e?.currentTime ?? 0);

      const prev = lastProgressRef.current;
      if (prev && prev.idx === clipIdx) {
        const delta = t - prev.time;
        if (delta > 0 && delta <= MAX_NATURAL_PROGRESS_STEP_SECONDS) {
          watchedSecondsRef.current += delta;
        }
      }

      lastProgressRef.current = {idx: clipIdx, time: t};
      applyLocalTime(clipIdx, t);
    },
    [applyLocalTime, currentIndexRef, isSeeking],
  );

  const onEnd = useCallback(
    (clipIdx: number) => {
      // Guard against stale onEnd callbacks from a clip that is no longer active.
      if (clipIdx !== currentIndexRef.current) {
        return;
      }
      const idx = clipIdx;

      if (idx < urls.length - 1) {
        const nextIndex = idx + 1;
        const nextPlayer = activePlayerRef.current === 0 ? 1 : 0;

        clearTimer();
        finalizeClipWatch(idx);

        // Pin current clip's time to its full duration so the UI shows 100%.
        setTimes(prev => {
          const next =
            prev.length === urls.length
              ? [...prev]
              : Array(urls.length).fill(0);
          const dur = durations[idx];
          next[idx] = Number.isFinite(dur) ? dur : next[idx] ?? 0;
          next[nextIndex] = 0;
          return next;
        });

        currentTimeRef.current = 0;

        // Queue a seek to t=0 on the new clip — onClipLoad will apply it once
        // the source is ready, avoiding the race condition of seeking before load.
        pendingSeekRef.current = {idx: nextIndex, time: 0};

        setActivePlayer(nextPlayer);
        setCurrentIndex(nextIndex);

        // If the inactive player already has this clip loaded (preload finished
        // before the switch), seek immediately — onLoad won't fire again.
        checkAndFlushPendingSeek(nextPlayer, nextIndex);

        bumpVersion();
      } else {
        clearTimer();
        finalizeClipWatch(idx);

        // ✅ 最后一段结束：把 time 推到 duration（如果已知），让 UI 贴底
        const dur = durations[idx];
        const endT = Number.isFinite(dur) ? dur : currentTimeRef.current;
        currentTimeRef.current = endT;

        setTimes(prev => {
          const next =
            prev.length === urls.length
              ? [...prev]
              : Array(urls.length).fill(0);
          next[idx] = endT;
          return next;
        });

        bumpVersion();
        setPlaying(false);

        const totalDuration = getKnownTotalDuration();
        const watched = watchedSecondsRef.current;
        setHasCompletedPlayback(
          totalDuration > 0 &&
            watched >= totalDuration * COMPLETION_WATCH_RATIO,
        );
      }
    },
    [
      activePlayerRef,
      bumpVersion,
      checkAndFlushPendingSeek,
      clearTimer,
      currentIndexRef,
      durations,
      finalizeClipWatch,
      getKnownTotalDuration,
      urls.length,
    ],
  );

  // ---------------- public API ----------------

  const seekToClip = useCallback(
    (idx: number, localSeconds: number, opts?: SeekToClipOptions) => {
      if (urls.length === 0) {
        return;
      }

      const play = opts?.play ?? true;

      const nextIdx = Math.max(0, Math.min(urls.length - 1, idx));

      let t = Math.max(0, Number(localSeconds) || 0);

      // ✅ clamp
      const dur = durations[nextIdx];
      if (Number.isFinite(dur) && t > dur) {
        t = dur;
      }

      applyLocalTime(nextIdx, t);
      lastProgressRef.current = {idx: nextIdx, time: t};

      if (nextIdx !== currentIndexRef.current) {
        const nextPlayer = activePlayerRef.current === 0 ? 1 : 0;
        pendingSeekRef.current = {idx: nextIdx, time: t};
        setActivePlayer(nextPlayer);
        setCurrentIndex(nextIdx);
        // If the inactive player already loaded this clip, seek immediately
        // rather than waiting for an onLoad that will never fire again.
        checkAndFlushPendingSeek(nextPlayer, nextIdx);
      } else {
        seekOnActivePlayer(t);
      }

      if (play) {
        setPlaying(true);
      }
    },
    [
      activePlayerRef,
      applyLocalTime,
      checkAndFlushPendingSeek,
      currentIndexRef,
      durations,
      seekOnActivePlayer,
      urls.length,
    ],
  );

  const queueResumeForCurrentClip = useCallback((): SeekRequest => {
    const idx = currentIndex;

    // Prefer ref for the freshest playback time; fall back to state snapshot.
    const localT =
      Number.isFinite(currentTimeRef.current) && currentTimeRef.current >= 0
        ? currentTimeRef.current
        : times[idx] ?? 0;

    const payload = {idx, time: localT};
    pendingResumeRef.current = payload;

    return payload;
  }, [currentIndex, times]);

  const seekVirtual = useCallback(
    (t: number, opts?: SeekToClipOptions) => {
      if (!getClipForTime) {
        return;
      }
      const r = getClipForTime(t);
      seekToClip(r.idx, r.local, opts);
    },
    [getClipForTime, seekToClip],
  );

  // Compute inactive player's preload target: either currentIndex+1 (normal flow)
  // or explicit pending seek target if cross-clip seek is in flight.
  // NOTE: We intentionally do NOT include pendingSeekRef in deps because React cannot
  // track ref.current changes. However, pendingSeekRef mutations are always paired with
  // currentIndex state changes, so we capture updates indirectly via currentIndex.
  const inactiveTargetIndex = useMemo(() => {
    if (urls.length === 0) {
      return -1;
    }

    if (pendingSeekRef.current && pendingSeekRef.current.idx !== currentIndex) {
      // Cross-clip seek in flight: preload the seek target + 1.
      return Math.min(pendingSeekRef.current.idx + 1, urls.length - 1);
    }
    // Normal case: preload next segment.
    return Math.min(currentIndex + 1, urls.length - 1);
  }, [currentIndex, urls.length]);

  // ---------------- video slots ----------------

  const videoSlots: VideoSlotProps[] = useMemo(() => {
    return [0, 1].map(i => {
      const isActive = i === activePlayer;

      // Inactive player preloads inactiveTargetIndex (computed from currentIndex
      // and pending seek, so always stays in sync without needing a separate state).
      const videoIndex = isActive ? currentIndex : inactiveTargetIndex;

      if (videoIndex < 0 || videoIndex >= urls.length) {
        return {
          ref: playerRefs[i],
          source: undefined,
          paused: true,
          onLoad: undefined,
          onProgress: undefined,
          onEnd: undefined,
        };
      }

      const uri = urls[videoIndex];
      const source = uri
        ? {uri, bufferConfig: {cacheSizeMB: 200}}
        : undefined;

      return {
        ref: playerRefs[i],
        source,
        paused: isActive ? !playing : true,
        // Both slots bind onLoad so loadedSlotRef stays accurate for preloaded clips.
        onLoad: (e: any) => onClipLoad(i, videoIndex, e),
        onProgress: isActive
          ? (e: any) => onClipProgress(videoIndex, e)
          : undefined,
        onEnd: isActive ? () => onEnd(videoIndex) : undefined,
      };
    });
  }, [
    activePlayer,
    currentIndex,
    inactiveTargetIndex,
    onClipLoad,
    onClipProgress,
    onEnd,
    playerRefs,
    playing,
    urls,
  ]);

  return {
    videoSlots,
    activePlayer,

    playing,
    setPlaying,
    playingRef,
    hasCompletedPlayback,

    currentIndex,
    currentTimeRef,
    times,
    version,

    seekToClip,
    seekVirtual,
    queueResumeForCurrentClip,
  };
}
