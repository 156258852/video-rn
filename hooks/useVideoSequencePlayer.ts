import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';

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
  getClipForTime?: (t: number) => ClipForTime;
  /** 播放完成所需观看比例 (默认 0.98) */
  completionRatio?: number;
};

type SeekOptions = {play?: boolean};

// ======================= 常量 =======================
const BUFFER_CONFIG = {cacheSizeMB: 200};
const MAX_PROGRESS_STEP = 1.5;

// ======================= 状态机类型 =======================

/**
 * 播放器生命周期阶段（互斥）
 *
 * Idle → Loading ─→ Playing ───→ Completed
 *               ↓   ↕        ↗
 *             Error  Paused
 *                    ↕
 *               Buffering
 *                    ↓
 *               Error
 *
 * Loading: 等待首帧 onProgress（或 PLAY 可跳过直接进入 Playing）
 * 注意：同 clip seek 不会改变 phase，仅更新 times/version。
 *       跨 clip seek 只有当目标 clip 尚未加载到目标 slot 时才会进入 Loading。
 */
type PlayerPhase =
  | 'Idle'
  | 'Loading' // Waiting for first onProgress or user press PLAY
  | 'Playing' // Actively playing (progress flowing)
  | 'Paused' // User paused
  | 'Buffering' // Playing but stalled for data
  | 'Completed' // Entire sequence watched (≥98%)
  | 'Error';

type PendingAction =
  | {type: 'seek'; clipIdx: number; time: number; play: boolean}
  | {type: 'resume'; clipIdx: number; time: number; play: boolean};

interface SlotInfo {
  clipIdx: number;
  uri: string;
  duration?: number;
}

interface SlotAssignments {
  [slot: number]: SlotInfo | null;
}

interface PlayerState {
  phase: PlayerPhase;
  preBufferPhase: PlayerPhase; // Phase to restore after buffering ends

  activePlayer: 0 | 1;
  currentIndex: number;
  slotAssignments: SlotAssignments;

  times: number[];
  currentTime: number;
  watchedSeconds: number;
  lastProgressClipIdx: number | null;
  lastProgressTime: number;

  version: number;
  resumeKey: number;

  isSeeking: boolean; // External scrub state (from useScrubber)
  pendingAction: PendingAction | null;
  error: any | null;
}

type PlayerEvent =
  // Video callbacks → reducer
  | {type: 'LOAD_COMPLETE'; slotIdx: number; clipIdx: number; duration: number}
  | {type: 'PROGRESS'; slotIdx: number; clipIdx: number; currentTime: number}
  | {
      type: 'END_REACHED';
      slotIdx: number;
      clipIdx: number;
      clipDuration: number;
      totalDuration: number;
      allDurationsKnown: boolean;
      completionRatio: number;
    }
  | {type: 'BUFFER_CHANGE'; slotIdx: number; isBuffering: boolean}
  | {type: 'ERROR'; slotIdx: number; error: any}
  // Consumer → reducer
  | {type: 'PLAY'}
  | {type: 'PAUSE'}
  | {type: 'SET_SEEKING'; value: boolean}
  // seekToClip callback decides which event to dispatch
  | {type: 'UPDATE_CLIP_TIME'; clipIdx: number; time: number} // Same-clip seek: no phase change
  | {
      type: 'SWITCH_TO_CLIP';
      player: 0 | 1;
      index: number;
      time: number;
      play: boolean;
    } // Cross-clip, already loaded in target slot
  | {type: 'SEEK_TO_LOAD'; clipIdx: number; time: number; play: boolean} // Cross-clip, NOT loaded — enter Loading
  | {type: 'QUEUE_RESUME'; clipIdx: number; time: number}
  | {type: 'RESET'; clipCount: number};

// ======================= Reducer =======================

function isActiveSlot(state: PlayerState, slotIdx: number): boolean {
  return slotIdx === state.activePlayer;
}

function updateTimes(
  arr: number[],
  len: number,
  idx: number,
  t: number,
): number[] {
  const next = arr.length === len ? [...arr] : Array(len).fill(0);
  next[idx] = t;
  return next;
}

function sumFinite(arr: number[]): number {
  return arr.reduce((s, d) => (Number.isFinite(d) && d > 0 ? s + d : s), 0);
}

function createInitialState(clipCount: number): PlayerState {
  return {
    phase: clipCount > 0 ? 'Loading' : 'Idle',
    preBufferPhase: 'Paused',

    activePlayer: 0,
    currentIndex: 0,
    slotAssignments: {0: null, 1: null},

    times: Array(clipCount).fill(0),
    currentTime: 0,
    watchedSeconds: 0,
    lastProgressClipIdx: null,
    lastProgressTime: 0,

    version: 0,
    resumeKey: 0,

    isSeeking: false,
    pendingAction: null,
    error: null,
  };
}

function playerReducer(state: PlayerState, event: PlayerEvent): PlayerState {
  switch (event.type) {
    // ==========================================================
    // RESET: URL list changed
    // ==========================================================
    case 'RESET': {
      return {
        ...createInitialState(event.clipCount),
        version: state.version + 1, // bust videoSlots memo
      };
    }

    // ==========================================================
    // LOAD_COMPLETE: Video onLoad fired
    // ==========================================================
    case 'LOAD_COMPLETE': {
      // Always update this slot's assignment so preload tracking works.
      // (Previously this only updated when existing.clipIdx matched, but
      // existing was always null from createInitialState, so slotAssignments
      // was never populated — preload was never recognized by seekToClip.)
      const newSlots = {...state.slotAssignments};
      newSlots[event.slotIdx] = {
        clipIdx: event.clipIdx,
        uri: '',
        duration: Number.isFinite(event.duration) ? event.duration : undefined,
      };

      // Pending action consumed — this slot loaded the expected clip.
      // Honor the play flag so the state machine exits Loading correctly.
      if (
        state.pendingAction &&
        state.pendingAction.clipIdx === event.clipIdx &&
        isActiveSlot(state, event.slotIdx)
      ) {
        const nextPhase =
          state.phase === 'Loading'
            ? state.pendingAction.play
              ? 'Playing'
              : 'Paused'
            : state.phase;
        return {
          ...state,
          slotAssignments: newSlots,
          phase: nextPhase,
          pendingAction: null, // cleared; the seek was already executed in callback
        };
      }

      // Inactive slot loaded — just update the slot record
      if (!isActiveSlot(state, event.slotIdx)) {
        return {
          ...state,
          slotAssignments: newSlots,
        };
      }

      // Active slot, no pending action: stay in Loading (wait for first PROGRESS)
      // but record the successful load.
      return {
        ...state,
        slotAssignments: newSlots,
      };
    }

    // ==========================================================
    // PROGRESS: Time update from a video slot
    // ==========================================================
    case 'PROGRESS': {
      // Guard: reject progress for non-active clip or non-active slot
      if (event.clipIdx !== state.currentIndex) return state;
      if (!isActiveSlot(state, event.slotIdx)) return state;

      // Guard: suppress progress during external scrub (user dragging scrubber)
      if (state.isSeeking) return state;

      const t = Math.max(
        0,
        Number.isFinite(event.currentTime) ? event.currentTime : 0,
      );

      // --- Loading → Playing: first valid progress (transition if not already Playing) ---
      if (state.phase === 'Loading') {
        return {
          ...state,
          phase: 'Playing',
          times: updateTimes(state.times, state.times.length, event.clipIdx, t),
          lastProgressClipIdx: event.clipIdx,
          lastProgressTime: t,
          currentTime: t,
        };
      }

      // --- Playing / Buffering: normal progress tracking ---
      if (state.phase === 'Playing' || state.phase === 'Buffering') {
        let watchedSeconds = state.watchedSeconds;
        if (
          state.lastProgressClipIdx === event.clipIdx &&
          state.lastProgressTime > 0
        ) {
          const delta = t - state.lastProgressTime;
          if (delta > 0 && delta <= MAX_PROGRESS_STEP) {
            watchedSeconds += delta;
          }
        }

        return {
          ...state,
          times: updateTimes(state.times, state.times.length, event.clipIdx, t),
          lastProgressClipIdx: event.clipIdx,
          lastProgressTime: t,
          currentTime: t,
          watchedSeconds,
        };
      }

      return state;
    }

    // ==========================================================
    // END_REACHED: Clip ended
    // ==========================================================
    case 'END_REACHED': {
      // Guard: must be the active slot playing the current clip
      if (event.slotIdx !== state.activePlayer) return state;
      if (event.clipIdx !== state.currentIndex) return state;
      if (state.phase !== 'Playing' && state.phase !== 'Buffering')
        return state;
      // Don't auto-advance if a seek is pending
      if (state.pendingAction) return state;

      const clipIdx = state.currentIndex;

      // Finalize watched seconds for this clip (add the "tail").
      // Use clipDuration for the tail — currentTime equals lastProgressTime
      // (both set to the same value in PROGRESS), so currentTime - lastProgressTime
      // would always be 0.
      let watchedSeconds = state.watchedSeconds;

      const clipEnd =
        event.clipDuration > 0 && Number.isFinite(event.clipDuration)
          ? event.clipDuration
          : state.currentTime;
      if (state.lastProgressClipIdx === clipIdx && state.lastProgressTime > 0) {
        const tail = clipEnd - state.lastProgressTime;
        if (tail > 0 && tail <= MAX_PROGRESS_STEP) {
          watchedSeconds += tail;
        }
      }

      if (clipIdx < state.times.length - 1) {
        // ── Advance to next clip ──
        const nextIdx = clipIdx + 1;
        const nextPlayer = state.activePlayer === 0 ? 1 : 0;

        // Only skip Loading if the target slot already has the next clip loaded
        const preloadReady =
          state.slotAssignments[nextPlayer]?.clipIdx === nextIdx;

        const newTimes = [...state.times];
        newTimes[clipIdx] = clipEnd;
        newTimes[nextIdx] = 0;

        return {
          ...state,
          phase: preloadReady ? 'Playing' : 'Loading',
          activePlayer: nextPlayer,
          currentIndex: nextIdx,
          times: newTimes,
          currentTime: 0,
          watchedSeconds,
          lastProgressClipIdx: null,
          lastProgressTime: 0,
          pendingAction: preloadReady
            ? state.pendingAction
            : {type: 'seek', clipIdx: nextIdx, time: 0, play: true},
          version: state.version + 1,
        };
      } else {
        // ── Last clip ended ──
        const endT = clipEnd;
        const newTimes = [...state.times];
        newTimes[clipIdx] = endT;

        const isComplete =
          event.allDurationsKnown &&
          event.totalDuration > 0 &&
          watchedSeconds >= event.totalDuration * event.completionRatio;

        return {
          ...state,
          phase: isComplete ? 'Completed' : 'Paused',
          times: newTimes,
          currentTime: endT,
          watchedSeconds,
          version: state.version + 1,
        };
      }
    }

    // ==========================================================
    // BUFFER_CHANGE: Buffer state changed
    // ==========================================================
    case 'BUFFER_CHANGE': {
      if (!isActiveSlot(state, event.slotIdx)) return state;

      if (event.isBuffering && state.phase === 'Playing') {
        return {...state, phase: 'Buffering', preBufferPhase: 'Playing'};
      }
      if (event.isBuffering && state.phase === 'Paused') {
        return {...state, phase: 'Buffering', preBufferPhase: 'Paused'};
      }
      // Dedup: already in Buffering with same isBuffering=true
      if (event.isBuffering && state.phase === 'Buffering') return state;
      // End buffering
      if (!event.isBuffering && state.phase === 'Buffering') {
        return {...state, phase: state.preBufferPhase};
      }
      return state;
    }

    // ==========================================================
    // ERROR: Video error
    // ==========================================================
    case 'ERROR': {
      if (!isActiveSlot(state, event.slotIdx)) return state;
      return {...state, phase: 'Error', error: event.error};
    }

    // ==========================================================
    // PLAY / PAUSE: Consumer actions
    // ==========================================================
    case 'PLAY': {
      // NOTE: Loading is NOT included here. During Loading the video is
      // already unpaused (playing includes Loading), so PLAY is a no-op.
      // This allows the loading overlay to stay visible during cross-clip
      // seeks instead of being immediately overridden to Playing.
      // Exit from Loading happens via LOAD_COMPLETE or first PROGRESS.
      if (state.phase === 'Paused') {
        return {...state, phase: 'Playing'};
      }
      // Allow user to request play during buffering — update preBufferPhase
      // so when data arrives the video resumes instead of staying paused.
      if (state.phase === 'Buffering') {
        return {...state, preBufferPhase: 'Playing'};
      }
      // Retry after error — use 'resume' type so the cache-bust query param
      // is appended, forcing react-native-video to reload the source.
      if (state.phase === 'Error') {
        return {
          ...state,
          phase: 'Loading',
          pendingAction: {
            type: 'resume',
            clipIdx: state.currentIndex,
            time: state.currentTime,
            play: true,
          },
          resumeKey: state.resumeKey + 1,
          version: state.version + 1,
          error: null,
        };
      }
      // Replay from beginning when completed.
      // Use 'resume' pendingAction to force remount + seek to 0,
      // and let LOAD_COMPLETE transition to Playing (play: true).
      if (state.phase === 'Completed') {
        return {
          ...createInitialState(state.times.length),
          pendingAction: {
            type: 'resume',
            clipIdx: 0,
            time: 0,
            play: true,
          },
          resumeKey: state.resumeKey + 1,
          version: state.version + 1,
        };
      }
      return state;
    }

    case 'PAUSE': {
      if (state.phase === 'Playing' || state.phase === 'Loading') {
        return {...state, phase: 'Paused'};
      }
      if (state.phase === 'Buffering') {
        return {...state, phase: 'Paused', preBufferPhase: 'Paused'};
      }
      return state;
    }

    // ==========================================================
    // SET_SEEKING: External scrub state (from useScrubber)
    // ==========================================================
    case 'SET_SEEKING': {
      if (state.isSeeking === event.value) return state;
      return {...state, isSeeking: event.value};
    }

    // ==========================================================
    // UPDATE_CLIP_TIME: Same-clip seek — update time, no phase change
    // ==========================================================
    case 'UPDATE_CLIP_TIME': {
      const newTimes = updateTimes(
        state.times,
        state.times.length,
        event.clipIdx,
        event.time,
      );
      return {
        ...state,
        times: newTimes,
        currentTime: event.time,
        lastProgressClipIdx: event.clipIdx,
        lastProgressTime: event.time,
        version: state.version + 1,
      };
    }

    // ==========================================================
    // SWITCH_TO_CLIP: Cross-clip, target ALREADY loaded in target slot
    //                  Go to Playing/Paused directly (do NOT inherit
    //                  Buffering from the previous clip).
    // ==========================================================
    case 'SWITCH_TO_CLIP': {
      const newTimes = updateTimes(
        state.times,
        state.times.length,
        event.index,
        event.time,
      );
      const nextPhase = event.play ? 'Playing' : 'Paused';
      return {
        ...state,
        phase: nextPhase,
        activePlayer: event.player,
        currentIndex: event.index,
        times: newTimes,
        currentTime: event.time,
        lastProgressClipIdx: event.index,
        lastProgressTime: event.time,
        pendingAction: null,
        version: state.version + 1,
      };
    }

    // ==========================================================
    // SEEK_TO_LOAD: Cross-clip, target NOT loaded — enter Loading,
    //               set pendingAction so onLoad can seek there.
    // ==========================================================
    case 'SEEK_TO_LOAD': {
      const nextPlayer = state.activePlayer === 0 ? 1 : 0;
      const newTimes = updateTimes(
        state.times,
        state.times.length,
        event.clipIdx,
        event.time,
      );
      return {
        ...state,
        phase: 'Loading',
        activePlayer: nextPlayer,
        currentIndex: event.clipIdx,
        times: newTimes,
        currentTime: event.time,
        lastProgressClipIdx: event.clipIdx,
        lastProgressTime: event.time,
        pendingAction: {
          type: 'seek',
          clipIdx: event.clipIdx,
          time: event.time,
          play: event.play,
        },
        version: state.version + 1,
      };
    }

    // ==========================================================
    // QUEUE_RESUME: Fullscreen resume (remount Video, resume at time)
    // Does NOT change phase — keep Playing/Paused so video doesn't
    // get stuck in Loading after being primed by PLAY.
    // ==========================================================
    case 'QUEUE_RESUME': {
      return {
        ...state,
        currentTime: event.time,
        pendingAction: {
          type: 'resume',
          clipIdx: event.clipIdx,
          time: event.time,
          play: true,
        },
        resumeKey: state.resumeKey + 1,
        version: state.version + 1,
      };
    }

    default:
      return state;
  }
}

// ======================= Hook =======================

export function useVideoSequencePlayer({
  urls,
  durations,
  recordDuration,
  getClipForTime,
  completionRatio = 0.98,
}: Params) {
  // ======================= 基础 Refs =======================
  const playerRef0 = useRef<any>(null);
  const playerRef1 = useRef<any>(null);
  const playerRefs = useMemo(() => [playerRef0, playerRef1] as const, []);

  // ── Refs for external values that the reducer/closures need ──
  const recordDurationRef = useRef(recordDuration);
  recordDurationRef.current = recordDuration;

  // Refs for durations and completionRatio so onEnd always reads the latest
  // values without adding them to the videoSlots memo dependency array
  // (which would cause unnecessary re-computation on every duration update).
  const durationsRef = useRef(durations);
  durationsRef.current = durations;

  const completionRatioRef = useRef(completionRatio);
  completionRatioRef.current = completionRatio;

  // ======================= 状态机 =======================
  const [state, dispatch] = useReducer(
    playerReducer,
    urls.length,
    createInitialState,
  );

  // Sync latest state to a ref so callbacks (especially onLoad) can read it
  const stateRef = useRef(state);
  stateRef.current = state;

  // ======================= Effect: 可靠执行 seek =======================
  // 当 pendingAction 变化时，确保 active slot 执行 seek。
  // 解决了 SEEK_TO_LOAD 路径中 onLoad 可能不触发导致 seek 丢失的问题。
  useEffect(() => {
    const action = state.pendingAction;
    if (!action || action.type !== 'seek') return;
    const slot = state.activePlayer;
    playerRefs[slot]?.current?.seek?.(action.time);
  }, [state.pendingAction, state.activePlayer, playerRefs]);

  // ======================= Refs for consumer backward compatibility =======================
  // Include Loading so the video is unpaused during Loading — this allows
  // the native player to load data and fire onProgress (which transitions
  // Loading→Playing). isLoading is tracked separately for the loading overlay.
  const playingRef = useRef(
    state.phase === 'Playing' ||
      state.phase === 'Buffering' ||
      state.phase === 'Loading',
  );
  playingRef.current =
    state.phase === 'Playing' ||
    state.phase === 'Buffering' ||
    state.phase === 'Loading';

  const currentTimeRef = useRef(state.currentTime);
  currentTimeRef.current = state.currentTime;

  // ======================= Derived booleans =======================
  const playing =
    state.phase === 'Playing' ||
    state.phase === 'Buffering' ||
    state.phase === 'Loading';
  const isLoading = state.phase === 'Loading';
  const isBuffering = state.phase === 'Buffering';
  const hasCompletedPlayback = state.phase === 'Completed';

  // ======================= Helper: compute inactive slot preload index =======================
  const computeInactiveIndex = useCallback((s: PlayerState): number => {
    if (s.times.length === 0) return -1;
    if (
      s.pendingAction?.type === 'seek' &&
      s.pendingAction.clipIdx !== s.currentIndex
    ) {
      return Math.min(s.pendingAction.clipIdx + 1, s.times.length - 1);
    }
    return Math.min(s.currentIndex + 1, s.times.length - 1);
  }, []);

  // ======================= videoSlots memo =======================
  // We create inline closures here that capture slotIdx and clipIdx at memo time.
  // For high-frequency callbacks (onBuffer, onError), we use stable dispatch wrappers.
  const dispatchBufferChange0 = useRef((e: any) =>
    dispatch({
      type: 'BUFFER_CHANGE',
      slotIdx: 0,
      isBuffering: !!e?.isBuffering,
    }),
  ).current;
  const dispatchBufferChange1 = useRef((e: any) =>
    dispatch({
      type: 'BUFFER_CHANGE',
      slotIdx: 1,
      isBuffering: !!e?.isBuffering,
    }),
  ).current;
  const dispatchError0 = useRef((e: any) =>
    dispatch({type: 'ERROR', slotIdx: 0, error: e}),
  ).current;
  const dispatchError1 = useRef((e: any) =>
    dispatch({type: 'ERROR', slotIdx: 1, error: e}),
  ).current;

  const videoSlots: VideoSlotProps[] = useMemo(() => {
    return [0, 1].map(i => {
      const isActive = i === state.activePlayer;
      const videoIndex = isActive
        ? state.currentIndex
        : computeInactiveIndex(state);

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
      // Cache-bust for resume: force Video remount by appending a unique query param
      if (isActive && state.pendingAction?.type === 'resume') {
        const sep = uri.includes('?') ? '&' : '?';
        uri = `${uri}${sep}_resume=${state.resumeKey}`;
      }

      // ── onLoad: the one callback that needs imperative logic ──
      const onLoad = (e: any) => {
        const s0 = stateRef.current;
        const dur = Number(e?.duration);

        if (recordDurationRef.current && Number.isFinite(dur)) {
          recordDurationRef.current(videoIndex, dur);
        }

        // Imperative seek if pending action targets this slot's clip
        if (s0.pendingAction && s0.pendingAction.clipIdx === videoIndex) {
          playerRefs[i].current?.seek?.(s0.pendingAction.time);
        } else if (s0.activePlayer !== i) {
          // Inactive slot: seek to 0 for proper preload positioning
          playerRefs[i].current?.seek?.(0);
        }

        dispatch({
          type: 'LOAD_COMPLETE',
          slotIdx: i,
          clipIdx: videoIndex,
          duration: dur,
        });
      };

      // ── onProgress ──
      const onProgress = isActive
        ? (e: any) => {
            dispatch({
              type: 'PROGRESS',
              slotIdx: i,
              clipIdx: videoIndex,
              currentTime: e?.currentTime ?? 0,
            });
          }
        : undefined;

      // ── onEnd ──
      // Read durations/completionRatio from refs to avoid stale closures
      // (these props are NOT in the memo dependency array by design).
      const onEnd = isActive
        ? () => {
            const d = durationsRef.current;
            const rawCd = d[videoIndex];
            const cd = Number.isFinite(rawCd) && rawCd > 0 ? rawCd : 0;
            const total = sumFinite(d);
            const allKnown =
              d.length > 0 && d.every(dd => Number.isFinite(dd) && dd > 0);
            dispatch({
              type: 'END_REACHED',
              slotIdx: i,
              clipIdx: videoIndex,
              clipDuration: cd,
              totalDuration: total,
              allDurationsKnown: allKnown,
              completionRatio: completionRatioRef.current,
            });
          }
        : undefined;

      return {
        ref: playerRefs[i],
        source: uri ? {uri, bufferConfig: BUFFER_CONFIG} : undefined,
        paused: isActive ? !playing : true,
        onLoad,
        onProgress,
        onEnd,
        onBuffer: i === 0 ? dispatchBufferChange0 : dispatchBufferChange1,
        onError: i === 0 ? dispatchError0 : dispatchError1,
      };
    });
  }, [
    state.phase,
    state.activePlayer,
    state.currentIndex,
    state.pendingAction,
    state.resumeKey,
    state.times.length,
    playerRefs,
    playing,
    urls,
    computeInactiveIndex,
  ]);

  // ======================= URL reset effect =======================
  // Use a stable string key so the effect only fires when the URL list
  // content actually changes, not when the array reference differs.
  const urlsKey = urls.join('\n');
  useEffect(() => {
    dispatch({type: 'RESET', clipCount: urls.length});
    // Reset imperative player state
    playerRef0.current?.seek?.(0);
    playerRef1.current?.seek?.(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlsKey]);

  // ======================= 公共 API =======================
  const setPlaying = useCallback((value: boolean) => {
    dispatch({type: value ? 'PLAY' : 'PAUSE'});
  }, []);

  const setIsLoading = useCallback((_value: boolean) => {
    // Loading phase is managed internally by the state machine.
    // This is a no-op kept for consumer backward compatibility.
  }, []);

  const seekToClip = useCallback(
    (idx: number, localSeconds: number, opts?: SeekOptions) => {
      if (urls.length === 0) return;
      const play = opts?.play ?? true;
      const t = Math.max(0, Number(localSeconds) || 0);
      const safeIdx = Math.max(0, Math.min(idx, urls.length - 1));
      const s = stateRef.current;

      if (safeIdx === s.currentIndex) {
        // Same clip: imperative seek + update time, no phase change
        playerRefs[s.activePlayer]?.current?.seek?.(t);
        dispatch({type: 'UPDATE_CLIP_TIME', clipIdx: safeIdx, time: t});
        if (play) {
          if (s.phase === 'Paused') dispatch({type: 'PLAY'});
        } else {
          if (s.phase === 'Playing' || s.phase === 'Buffering') {
            dispatch({type: 'PAUSE'});
          }
        }
      } else {
        // Cross-clip: check if target clip is already loaded in target slot
        const nextPlayer = s.activePlayer === 0 ? 1 : 0;
        const loaded = s.slotAssignments[nextPlayer];

        if (loaded && loaded.clipIdx === safeIdx) {
          // Already loaded — imperative seek + switch slot, no Loading phase
          playerRefs[nextPlayer]?.current?.seek?.(t);
          dispatch({
            type: 'SWITCH_TO_CLIP',
            player: nextPlayer as 0 | 1,
            index: safeIdx,
            time: t,
            play,
          });
        } else {
          // Not loaded yet — enter Loading, onLoad will handle the seek
          dispatch({type: 'SEEK_TO_LOAD', clipIdx: safeIdx, time: t, play});
        }
      }
    },
    [urls.length, playerRefs, stateRef],
  );

  const queueResumeForCurrentClip = useCallback((): SeekRequest => {
    const payload = {
      idx: stateRef.current.currentIndex,
      time:
        Number.isFinite(stateRef.current.currentTime) &&
        stateRef.current.currentTime >= 0
          ? stateRef.current.currentTime
          : 0,
    };
    dispatch({
      type: 'QUEUE_RESUME',
      clipIdx: payload.idx,
      time: payload.time,
    });
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

  const setIsSeeking = useCallback(
    (value: boolean) => dispatch({type: 'SET_SEEKING', value}),
    [],
  );
  console.log('🚀 >>> state', state);

  return {
    videoSlots,
    activePlayer: state.activePlayer,
    playing,
    setPlaying,
    playingRef,
    hasCompletedPlayback,
    isLoading,
    setIsLoading,
    isBuffering,
    error: state.error,
    currentIndex: state.currentIndex,
    currentTimeRef,
    times: state.times,
    version: state.version,
    isSeeking: state.isSeeking,
    setIsSeeking,
    seekToClip,
    seekVirtual,
    queueResumeForCurrentClip,
  };
}
