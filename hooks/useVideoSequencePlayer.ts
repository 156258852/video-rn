import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import {useLatestRef} from '../utils';

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

type ClipEndPayload = {idx: number; uri: string; duration: number};

type Params = {
  urls: string[];
  durations: number[];
  recordDuration?: (idx: number, durationSeconds: number) => void;
  isSeeking: boolean;
  getClipForTime?: (t: number) => ClipForTime;
  onClipEnd?: (payload: ClipEndPayload) => void;
};

type SeekOptions = {play?: boolean};

const BUFFER_CONFIG = {cacheSizeMB: 200};
const MAX_PROGRESS_STEP = 1.5;

type Slot = 0 | 1;
type Phase =
  | 'idle'
  | 'loading'
  | 'loadedPendingSeek'
  | 'seeking'
  | 'ready'
  | 'ended'
  | 'error';

type SlotInfo = {
  clipIdx: number;
  uri: string;
  loadKey: number;
};

type State = {
  urlsLength: number;

  activeSlot: Slot;
  slots: [SlotInfo | null, SlotInfo | null];
  slotLoadedKey: [number | null, number | null];

  phase: Phase;
  wantPlaying: boolean;

  // External user gesture state (e.g. user is dragging the seek bar)
  externalSeeking: boolean;

  currentIndex: number;
  currentTime: number;

  times: number[];

  isLoading: boolean;
  needsProgressClear: boolean;
  isBuffering: boolean;
  error: any;

  sequenceEndCount: number;

  loadKeySeed: number;
  seekToken: number;
  appliedSeekToken: number;
  pendingSeekTime: number | null;

  playedSeconds: number;
};

type Action =
  | {
      type: 'INIT';
      urlsLength: number;
      firstUri: string;
      externalSeeking: boolean;
    }
  | {type: 'SET_PLAYING'; playing: boolean}
  | {type: 'SET_EXTERNAL_SEEKING'; isSeeking: boolean}
  | {
      type: 'SEEK_TO_CLIP';
      nextIdx: number;
      time: number;
      uri: string;
      play: boolean;
    }
  | {type: 'SEEK_WITHIN_CLIP'; time: number; play: boolean}
  | {type: 'SEEK_APPLIED'; seekToken: number}
  | {type: 'PRELOAD_SLOT'; slot: Slot; clipIdx: number; uri: string}
  | {
      type: 'RELOAD_ACTIVE';
      idx: number;
      time: number;
      newUri: string;
    }
  | {
      type: 'LOAD_SUCCESS';
      slot: Slot;
      clipIdx: number;
      uri: string;
      loadKey: number;
    }
  | {
      type: 'PROGRESS';
      slot: Slot;
      clipIdx: number;
      uri: string;
      loadKey: number;
      time: number;
    }
  | {
      type: 'END';
      slot: Slot;
      clipIdx: number;
      uri: string;
      loadKey: number;
      clipDuration: number;
      nextIdx: number | null;
      nextUri?: string;
    }
  | {
      type: 'BUFFER';
      slot: Slot;
      clipIdx: number;
      uri: string;
      loadKey: number;
      isBuffering: boolean;
    }
  | {
      type: 'ERROR';
      slot: Slot;
      clipIdx: number;
      uri: string;
      loadKey: number;
      error: any;
    };

function otherSlot(s: Slot): Slot {
  return s === 0 ? 1 : 0;
}

function ensureTimesLen(prev: number[], len: number): number[] {
  if (prev.length === len) return prev;
  return Array(len).fill(0);
}

function isValidAssignedEvent(
  state: State,
  slot: Slot,
  clipIdx: number,
  uri: string,
  loadKey: number,
) {
  const info = state.slots[slot];
  return (
    !!info &&
    info.clipIdx === clipIdx &&
    info.uri === uri &&
    info.loadKey === loadKey
  );
}

function isValidActiveEvent(
  state: State,
  slot: Slot,
  clipIdx: number,
  uri: string,
  loadKey: number,
) {
  if (slot !== state.activeSlot) return false;
  return isValidAssignedEvent(state, slot, clipIdx, uri, loadKey);
}

function appendResumeParam(uri: string, key: number) {
  const sep = uri.includes('?') ? '&' : '?';
  return `${uri}${sep}_resume=${key}`;
}

function shouldPauseActive(state: State) {
  switch (state.phase) {
    case 'idle':
    case 'ended':
    case 'error':
      return true;
    case 'loading':
      // Keep active slot unpaused while loading to avoid implementations that don't emit load callbacks when paused.
      return false;
    case 'loadedPendingSeek':
    case 'seeking':
    case 'ready':
      return !state.wantPlaying;
    default:
      return true;
  }
}

function initialState(): State {
  return {
    urlsLength: 0,
    activeSlot: 0,
    slots: [null, null],
    slotLoadedKey: [null, null],
    phase: 'idle',
    wantPlaying: false,
    externalSeeking: false,
    currentIndex: 0,
    currentTime: 0,
    times: [],
    isLoading: false,
    needsProgressClear: false,
    isBuffering: false,
    error: null,
    sequenceEndCount: 0,
    loadKeySeed: 0,
    seekToken: 0,
    appliedSeekToken: 0,
    pendingSeekTime: null,
    playedSeconds: 0,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'INIT': {
      const {urlsLength} = action;
      if (urlsLength <= 0) return initialState();

      const first: SlotInfo = {
        clipIdx: 0,
        uri: action.firstUri,
        loadKey: 1,
      };

      return {
        ...initialState(),
        urlsLength,
        slots: [first, null],
        slotLoadedKey: [null, null],
        activeSlot: 0,
        phase: action.firstUri ? 'loading' : 'idle',
        isLoading: !!action.firstUri,
        needsProgressClear: !!action.firstUri,
        loadKeySeed: 1,
        times: Array(urlsLength).fill(0),
        externalSeeking: action.externalSeeking,
      };
    }

    case 'SET_PLAYING': {
      // If the user pauses while we're waiting for a "settling" PROGRESS after seek,
      // we should not rely on PROGRESS to exit the intermediate state.
      if (!action.playing && state.phase === 'seeking') {
        return {
          ...state,
          wantPlaying: false,
          phase: 'ready',
          isLoading: false,
          needsProgressClear: false,
          pendingSeekTime: null,
        };
      }

      // Prevent "playing intent" from being set in terminal/error states.
      if (
        action.playing &&
        (state.phase === 'idle' ||
          state.phase === 'ended' ||
          state.phase === 'error')
      ) {
        return state;
      }

      return {...state, wantPlaying: action.playing};
    }

    case 'SET_EXTERNAL_SEEKING': {
      return {...state, externalSeeking: action.isSeeking};
    }

    case 'SEEK_WITHIN_CLIP': {
      if (state.phase === 'idle' || state.phase === 'error') return state;

      const times = ensureTimesLen(state.times, state.urlsLength).slice();
      times[state.currentIndex] = action.time;

      const seekToken = state.seekToken + 1;
      const wantPlaying = action.play ? true : state.wantPlaying;

      return {
        ...state,
        // If we're currently loading, keep `loading` but remember the pending seek.
        phase: state.phase === 'loading' ? 'loading' : 'loadedPendingSeek',
        wantPlaying,
        currentTime: action.time,
        times,
        seekToken,
        pendingSeekTime: action.time,
        isBuffering: false,
        error: null,
      };
    }

    case 'SEEK_APPLIED': {
      // Only accept the current seekToken that matches the imperative seek() call.
      if (state.phase !== 'loadedPendingSeek') return state;
      if (action.seekToken !== state.seekToken) return state;

      const nextPhase = state.wantPlaying ? 'seeking' : 'ready';

      return {
        ...state,
        phase: nextPhase,
        appliedSeekToken: action.seekToken,
        pendingSeekTime: state.wantPlaying ? state.pendingSeekTime : null,
        isLoading: state.wantPlaying ? state.isLoading : false,
        needsProgressClear: state.wantPlaying
          ? state.needsProgressClear
          : false,
      };
    }

    case 'SEEK_TO_CLIP': {
      const inactiveSlot = otherSlot(state.activeSlot);
      const preload = state.slots[inactiveSlot];
      const hitPreload =
        !!preload &&
        preload.clipIdx === action.nextIdx &&
        preload.uri === action.uri &&
        state.slotLoadedKey[inactiveSlot] === preload.loadKey;

      const times = ensureTimesLen(state.times, state.urlsLength).slice();
      times[action.nextIdx] = action.time;

      // Fast-path: preload is already loaded; swap activeSlot and seek without entering loading.
      if (hitPreload) {
        const wantPlaying = action.play ? true : state.wantPlaying;
        const seekToken = state.seekToken + 1;

        return {
          ...state,
          wantPlaying,
          activeSlot: inactiveSlot,
          phase: 'loadedPendingSeek',
          isLoading: false,
          needsProgressClear: false,
          isBuffering: false,
          error: null,
          currentIndex: action.nextIdx,
          currentTime: action.time,
          times,
          seekToken,
          pendingSeekTime: action.time,
        };
      }

      // Fallback: preload not hit (or not loaded yet); follow the normal loading path.
      const nextLoadKey = state.loadKeySeed + 1;

      const nextSlots: [SlotInfo | null, SlotInfo | null] = [
        ...state.slots,
      ] as any;
      nextSlots[inactiveSlot] = {
        clipIdx: action.nextIdx,
        uri: action.uri,
        loadKey: nextLoadKey,
      };

      const slotLoadedKey: [number | null, number | null] = [
        ...state.slotLoadedKey,
      ] as any;
      slotLoadedKey[inactiveSlot] = null;

      return {
        ...state,
        wantPlaying: action.play ? true : state.wantPlaying,
        activeSlot: inactiveSlot,
        slots: nextSlots,
        slotLoadedKey,
        phase: 'loading',
        isLoading: true,
        needsProgressClear: true,
        isBuffering: false,
        error: null,
        currentIndex: action.nextIdx,
        currentTime: action.time,
        times,
        loadKeySeed: nextLoadKey,
        seekToken: state.seekToken + 1,
        pendingSeekTime: action.time,
      };
    }

    case 'PRELOAD_SLOT': {
      if (action.slot === state.activeSlot) return state;

      // Allow preload refresh even for the same (clipIdx, uri) to support retry.
      const nextLoadKey = state.loadKeySeed + 1;
      const nextSlots: [SlotInfo | null, SlotInfo | null] = [
        ...state.slots,
      ] as any;
      nextSlots[action.slot] = {
        clipIdx: action.clipIdx,
        uri: action.uri,
        loadKey: nextLoadKey,
      };

      const slotLoadedKey: [number | null, number | null] = [
        ...state.slotLoadedKey,
      ] as any;
      slotLoadedKey[action.slot] = null;

      return {
        ...state,
        slots: nextSlots,
        slotLoadedKey,
        loadKeySeed: nextLoadKey,
      };
    }

    case 'RELOAD_ACTIVE': {
      // Reload: change (uri, loadKey) on the active slot to force a native reload.
      const slot = state.activeSlot;
      const existing = state.slots[slot];
      if (!existing || existing.clipIdx !== action.idx) return state;

      const nextLoadKey = state.loadKeySeed + 1;
      const nextSlots: [SlotInfo | null, SlotInfo | null] = [
        ...state.slots,
      ] as any;
      nextSlots[slot] = {
        clipIdx: action.idx,
        uri: action.newUri,
        loadKey: nextLoadKey,
      };

      const slotLoadedKey: [number | null, number | null] = [
        ...state.slotLoadedKey,
      ] as any;
      slotLoadedKey[slot] = null;

      const times = ensureTimesLen(state.times, state.urlsLength).slice();
      times[action.idx] = action.time;

      return {
        ...state,
        slots: nextSlots,
        slotLoadedKey,
        phase: 'loading',
        isLoading: true,
        needsProgressClear: true,
        isBuffering: false,
        error: null,
        currentTime: action.time,
        times,
        loadKeySeed: nextLoadKey,
        seekToken: state.seekToken + 1,
        pendingSeekTime: action.time,
      };
    }

    case 'LOAD_SUCCESS': {
      if (
        !isValidAssignedEvent(
          state,
          action.slot,
          action.clipIdx,
          action.uri,
          action.loadKey,
        )
      ) {
        return state;
      }

      // Inactive slot: only record that this slot's current loadKey has loaded.
      if (action.slot !== state.activeSlot) {
        if (state.slotLoadedKey[action.slot] === action.loadKey) return state;
        const slotLoadedKey: [number | null, number | null] = [
          ...state.slotLoadedKey,
        ] as any;
        slotLoadedKey[action.slot] = action.loadKey;
        return {...state, slotLoadedKey};
      }

      // Active slot: record loadedKey for consistency.
      const slotLoadedKey: [number | null, number | null] = [
        ...state.slotLoadedKey,
      ] as any;
      slotLoadedKey[action.slot] = action.loadKey;

      // Some implementations may fire onLoad multiple times; ignore extra events once we're past loading.
      if (
        state.phase === 'ready' ||
        state.phase === 'loadedPendingSeek' ||
        state.phase === 'seeking'
      ) {
        return {...state, slotLoadedKey};
      }

      // Only loading is allowed to advance on LOAD_SUCCESS.
      // Prevent stale LOAD_SUCCESS from resurrecting ended/error/idle.
      if (state.phase !== 'loading') {
        return {...state, slotLoadedKey};
      }

      const hasPendingSeek = state.seekToken !== state.appliedSeekToken;
      const shouldWaitProgress = state.wantPlaying || hasPendingSeek;

      return {
        ...state,
        slotLoadedKey,
        phase: hasPendingSeek ? 'loadedPendingSeek' : 'ready',
        error: null,
        isBuffering: false,
        isLoading: shouldWaitProgress ? state.isLoading : false,
        needsProgressClear: shouldWaitProgress
          ? state.needsProgressClear
          : false,
      };
    }

    case 'PROGRESS': {
      if (
        !isValidActiveEvent(
          state,
          action.slot,
          action.clipIdx,
          action.uri,
          action.loadKey,
        )
      ) {
        return state;
      }
      if (state.phase !== 'ready' && state.phase !== 'seeking') {
        return state;
      }
      if (state.externalSeeking) {
        return state;
      }
      if (state.seekToken !== state.appliedSeekToken) {
        return state;
      }

      // Extra guard: only allow the active clip to update `times`.
      if (state.currentIndex !== action.clipIdx) {
        return state;
      }

      const t = action.time;
      const target = state.currentTime;
      const EPS = 0.5;
      // Ignore stale progress emitted before seek has settled.
      if (target > EPS && t < target - EPS) {
        return state;
      }

      const times = ensureTimesLen(state.times, state.urlsLength).slice();
      const prevT = state.currentTime;

      let {playedSeconds} = state;
      const delta = t - prevT;
      if (delta > 0 && delta <= MAX_PROGRESS_STEP) {
        playedSeconds += delta;
      }

      times[action.clipIdx] = t;

      return {
        ...state,
        phase: 'ready',
        currentTime: t,
        times,
        playedSeconds,
        isLoading: state.needsProgressClear ? false : state.isLoading,
        needsProgressClear: false,
        pendingSeekTime: null,
      };
    }

    case 'END': {
      if (
        !isValidActiveEvent(
          state,
          action.slot,
          action.clipIdx,
          action.uri,
          action.loadKey,
        )
      ) {
        return state;
      }
      if (state.phase !== 'ready' && state.phase !== 'seeking') {
        return state;
      }
      if (
        state.phase === 'seeking' &&
        state.seekToken !== state.appliedSeekToken
      ) {
        return state;
      }

      const times = ensureTimesLen(state.times, state.urlsLength).slice();
      const prevT = times[action.clipIdx] ?? state.currentTime;

      let {playedSeconds} = state;
      if (Number.isFinite(action.clipDuration) && action.clipDuration > 0) {
        const tail = action.clipDuration - prevT;
        if (tail > 0 && tail <= MAX_PROGRESS_STEP) {
          playedSeconds += tail;
        }
      }

      if (action.nextIdx == null || !action.nextUri) {
        const endT =
          Number.isFinite(action.clipDuration) && action.clipDuration > 0
            ? action.clipDuration
            : prevT;

        times[action.clipIdx] = endT;

        return {
          ...state,
          phase: 'ended',
          wantPlaying: false,
          currentTime: endT,
          times,
          playedSeconds,
          isLoading: false,
          needsProgressClear: false,
          isBuffering: false,
          sequenceEndCount: state.sequenceEndCount + 1,
        };
      }

      const nextSlot = otherSlot(state.activeSlot);
      const preload = state.slots[nextSlot];
      const hitPreload =
        !!preload &&
        preload.clipIdx === action.nextIdx &&
        preload.uri === action.nextUri &&
        state.slotLoadedKey[nextSlot] === preload.loadKey;

      // Finalize: write current clip to duration; reset next clip to 0.
      if (Number.isFinite(action.clipDuration) && action.clipDuration > 0) {
        times[action.clipIdx] = action.clipDuration;
      }
      times[action.nextIdx] = 0;

      if (hitPreload) {
        return {
          ...state,
          activeSlot: nextSlot,
          phase: 'loadedPendingSeek',
          isLoading: false,
          needsProgressClear: false,
          isBuffering: false,
          error: null,
          currentIndex: action.nextIdx,
          currentTime: 0,
          times,
          playedSeconds,
          seekToken: state.seekToken + 1,
          pendingSeekTime: 0,
        };
      }

      const nextLoadKey = state.loadKeySeed + 1;

      const nextSlots: [SlotInfo | null, SlotInfo | null] = [
        ...state.slots,
      ] as any;
      nextSlots[nextSlot] = {
        clipIdx: action.nextIdx,
        uri: action.nextUri,
        loadKey: nextLoadKey,
      };

      const slotLoadedKey: [number | null, number | null] = [
        ...state.slotLoadedKey,
      ] as any;
      slotLoadedKey[nextSlot] = null;

      return {
        ...state,
        activeSlot: nextSlot,
        slots: nextSlots,
        slotLoadedKey,
        phase: 'loading',
        isLoading: true,
        needsProgressClear: true,
        isBuffering: false,
        error: null,
        currentIndex: action.nextIdx,
        currentTime: 0,
        times,
        playedSeconds,
        loadKeySeed: nextLoadKey,
        seekToken: state.seekToken + 1,
        pendingSeekTime: 0,
      };
    }

    case 'BUFFER': {
      if (
        !isValidActiveEvent(
          state,
          action.slot,
          action.clipIdx,
          action.uri,
          action.loadKey,
        )
      ) {
        return state;
      }
      if (
        state.phase === 'idle' ||
        state.phase === 'ended' ||
        state.phase === 'error'
      ) {
        return state;
      }
      return {...state, isBuffering: action.isBuffering};
    }

    case 'ERROR': {
      // Active slot error => terminal error.
      if (
        isValidActiveEvent(
          state,
          action.slot,
          action.clipIdx,
          action.uri,
          action.loadKey,
        )
      ) {
        return {
          ...state,
          phase: 'error',
          wantPlaying: false,
          isLoading: false,
          needsProgressClear: false,
          isBuffering: false,
          error: action.error,
        };
      }

      // Inactive/preload slot error => invalidate preload only.
      // Do not retry here.
      // This prevents a previously loaded preload from being used after it later errors.
      if (
        isValidAssignedEvent(
          state,
          action.slot,
          action.clipIdx,
          action.uri,
          action.loadKey,
        )
      ) {
        const nextSlots: [SlotInfo | null, SlotInfo | null] = [
          ...state.slots,
        ] as any;
        const slotLoadedKey: [number | null, number | null] = [
          ...state.slotLoadedKey,
        ] as any;
        nextSlots[action.slot] = null;
        slotLoadedKey[action.slot] = null;
        return {
          ...state,
          slots: nextSlots,
          slotLoadedKey,
        };
      }

      return state;
    }

    default:
      return state;
  }
}

export function useVideoSequencePlayer({
  urls,
  durations,
  recordDuration,
  isSeeking,
  getClipForTime,
  onClipEnd,
}: Params) {
  const playerRef0 = useRef<any>(null);
  const playerRef1 = useRef<any>(null);
  const playerRefs = useMemo(() => [playerRef0, playerRef1] as const, []);

  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useLatestRef(state);

  const isSeekingRef = useLatestRef(isSeeking);
  const playingRef = useLatestRef(state.wantPlaying);
  const currentTimeRef = useRef(0);
  const playedSecondsRef = useRef(0);

  useEffect(() => {
    currentTimeRef.current = state.currentTime;
  }, [state.currentTime]);

  useEffect(() => {
    playedSecondsRef.current = state.playedSeconds;
  }, [state.playedSeconds]);

  // We intentionally only re-init on `urls` changes.
  // `isSeekingRef.current` is only used to snapshot the latest external seeking state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    dispatch({
      type: 'INIT',
      urlsLength: urls.length,
      firstUri: urls[0] ?? '',
      externalSeeking: isSeekingRef.current,
    });
  }, [urls]);

  useEffect(() => {
    dispatch({type: 'SET_EXTERNAL_SEEKING', isSeeking});
  }, [isSeeking]);

  useEffect(() => {
    const s = stateRef.current;
    if (s.phase !== 'loadedPendingSeek') return;
    if (s.seekToken === s.appliedSeekToken) return;

    const player = playerRefs[s.activeSlot].current;
    if (typeof player?.seek !== 'function') return;

    player.seek(s.pendingSeekTime ?? s.currentTime);
    dispatch({type: 'SEEK_APPLIED', seekToken: s.seekToken});
  }, [
    playerRefs,
    stateRef,
    state.activeSlot,
    state.phase,
    state.seekToken,
    state.appliedSeekToken,
    state.pendingSeekTime,
    state.currentTime,
  ]);

  useEffect(() => {
    if (urls.length === 0) return;
    if (state.phase !== 'ready') return;

    const nextIdx = Math.min(state.currentIndex + 1, urls.length - 1);
    if (nextIdx === state.currentIndex) return;

    const slot = otherSlot(state.activeSlot);
    const uri = urls[nextIdx] ?? '';
    if (!uri) return;

    // Avoid repeating preload dispatches while already ready.
    const existing = state.slots[slot];
    if (existing && existing.clipIdx === nextIdx && existing.uri === uri)
      return;

    dispatch({type: 'PRELOAD_SLOT', slot, clipIdx: nextIdx, uri});
  }, [state.activeSlot, state.currentIndex, state.phase, state.slots, urls]);

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

  const setPlaying = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const n = typeof next === 'function' ? next(playingRef.current) : next;
      dispatch({type: 'SET_PLAYING', playing: n});
    },
    [playingRef],
  );

  const seekToClip = useCallback(
    (idx: number, localSeconds: number, opts?: SeekOptions) => {
      if (urls.length === 0) return;

      const play = opts?.play ?? true;
      const nextIdx = Math.max(0, Math.min(urls.length - 1, idx));

      let t = Math.max(0, Number(localSeconds) || 0);
      const dur = durations[nextIdx] ?? 0;
      if (Number.isFinite(dur) && dur > 0 && t > dur) t = dur;

      const s = stateRef.current;
      if (nextIdx === s.currentIndex) {
        dispatch({type: 'SEEK_WITHIN_CLIP', time: t, play});
        return;
      }

      const uri = urls[nextIdx] ?? '';
      if (!uri) return;

      dispatch({
        type: 'SEEK_TO_CLIP',
        nextIdx,
        time: t,
        uri,
        play,
      });
    },
    [durations, stateRef, urls],
  );

  const seekVirtual = useCallback(
    (t: number, opts?: SeekOptions) => {
      if (!getClipForTime) return;
      const r = getClipForTime(t);
      seekToClip(r.idx, r.local, opts);
    },
    [getClipForTime, seekToClip],
  );

  const resumeKeyRef = useRef(0);
  const queueResumeForCurrentClip = useCallback((): SeekRequest => {
    const s = stateRef.current;
    const idx = s.currentIndex;
    const localT =
      Number.isFinite(s.currentTime) && s.currentTime >= 0
        ? s.currentTime
        : s.times[idx] ?? 0;

    const payload = {idx, time: localT};

    const baseUri = urls[idx] ?? '';
    resumeKeyRef.current += 1;
    const newUri = baseUri
      ? appendResumeParam(baseUri, resumeKeyRef.current)
      : baseUri;

    if (newUri) {
      dispatch({
        type: 'RELOAD_ACTIVE',
        idx,
        time: localT,
        newUri,
      });
    }

    return payload;
  }, [stateRef, urls]);

  // Video slots (identity injected)
  const videoSlots: VideoSlotProps[] = useMemo(() => {
    return ([0, 1] as const).map(slot => {
      const info = state.slots[slot];
      const isActive = slot === state.activeSlot;

      if (!info || !info.uri) {
        return {
          ref: playerRefs[slot],
          source: undefined,
          paused: true,
          onLoad: undefined,
          onProgress: undefined,
          onEnd: undefined,
          onBuffer: undefined,
          onError: undefined,
        };
      }

      const {clipIdx, uri, loadKey} = info;

      return {
        ref: playerRefs[slot],
        source: {uri, bufferConfig: BUFFER_CONFIG},
        // Keep active slot unpaused while loading to avoid implementations that don't emit load callbacks when paused.
        paused: !isActive || shouldPauseActive(state),
        onLoad: (e: any) => {
          const d = Number(e?.duration);
          if (recordDuration && Number.isFinite(d)) recordDuration(clipIdx, d);

          dispatch({
            type: 'LOAD_SUCCESS',
            slot,
            clipIdx,
            uri,
            loadKey,
          });
        },
        onProgress: isActive
          ? (e: any) => {
              const t = Number(e?.currentTime ?? 0);
              if (!Number.isFinite(t)) return;

              dispatch({
                type: 'PROGRESS',
                slot,
                clipIdx,
                uri,
                loadKey,
                time: t,
              });
            }
          : undefined,
        onEnd: isActive
          ? () => {
              const s = stateRef.current;
              if (!isValidActiveEvent(s, slot, clipIdx, uri, loadKey)) return;
              if (s.phase !== 'ready' && s.phase !== 'seeking') return;
              if (s.phase === 'seeking' && s.seekToken !== s.appliedSeekToken) {
                return;
              }

              const clipDuration = Number(durations[clipIdx] ?? 0);
              const hasNext = clipIdx < urls.length - 1;
              const nextIdx = hasNext ? clipIdx + 1 : null;
              const nextUri = hasNext ? urls[clipIdx + 1] ?? '' : undefined;

              onClipEnd?.({idx: clipIdx, uri, duration: clipDuration});

              dispatch({
                type: 'END',
                slot,
                clipIdx,
                uri,
                loadKey,
                clipDuration,
                nextIdx,
                nextUri,
              });
            }
          : undefined,
        onBuffer: (e: any) => {
          dispatch({
            type: 'BUFFER',
            slot,
            clipIdx,
            uri,
            loadKey,
            isBuffering: !!e?.isBuffering,
          });
        },
        onError: (e: any) => {
          dispatch({
            type: 'ERROR',
            slot,
            clipIdx,
            uri,
            loadKey,
            error: e,
          });
        },
      };
    });
  }, [durations, onClipEnd, playerRefs, recordDuration, state, stateRef, urls]);

  return {
    videoSlots,
    activePlayer: state.activeSlot,
    playing: state.wantPlaying,
    setPlaying,
    playingRef,

    sequenceEndCount: state.sequenceEndCount,
    playedSecondsRef,
    getTotalDuration,
    allDurationsKnown,

    isLoading: state.isLoading,
    isBuffering: state.isBuffering,
    error: state.error,
    currentIndex: state.currentIndex,
    currentTimeRef,
    times: state.times,

    seekToClip,
    seekVirtual,
    queueResumeForCurrentClip,
  };
}
