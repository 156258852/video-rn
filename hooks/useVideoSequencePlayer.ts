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

  // External user gesture state (e.g. user is dragging the seek bar).
  // Orthogonal to playback phase; only gates PROGRESS ingestion.
  isSeeking: boolean;

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
  | {type: 'INIT'; urlsLength: number; firstUri: string}
  | {type: 'SET_PLAYING'; playing: boolean}
  | {type: 'SET_SEEKING'; isSeeking: boolean}
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
  | {type: 'RELOAD_ACTIVE'; idx: number; time: number; newUri: string}
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

// Action subtype aliases for type-safe guard/patch helpers.
type AInit = Extract<Action, {type: 'INIT'}>;
type ASetPlaying = Extract<Action, {type: 'SET_PLAYING'}>;
type ASetSeeking = Extract<Action, {type: 'SET_SEEKING'}>;
type ASeekToClip = Extract<Action, {type: 'SEEK_TO_CLIP'}>;
type ASeekWithin = Extract<Action, {type: 'SEEK_WITHIN_CLIP'}>;
type ASeekApplied = Extract<Action, {type: 'SEEK_APPLIED'}>;
type APreload = Extract<Action, {type: 'PRELOAD_SLOT'}>;
type AReload = Extract<Action, {type: 'RELOAD_ACTIVE'}>;
type ALoadSuccess = Extract<Action, {type: 'LOAD_SUCCESS'}>;
type AProgress = Extract<Action, {type: 'PROGRESS'}>;
type AEnd = Extract<Action, {type: 'END'}>;
type ABuferr = Extract<Action, {type: 'BUFFER'}>;
type AError = Extract<Action, {type: 'ERROR'}>;
// Any action carrying a {slot, clipIdx, uri, loadKey} identity payload.
type EvtAction = Extract<Action, {slot: Slot; loadKey: number}>;

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
    isSeeking: false,
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

// ---------------------------------------------------------------------------
// 2D phase x phase transition matrix
// ---------------------------------------------------------------------------
// TRANSITIONS[from][to] = Rule[] — a true 2D grid where rows = source phase,
// columns = target phase. Each Rule fires when its `action` matches and
// (optional) `guard` passes; the reducer applies `patch` and sets `phase = to`.
// Empty cells = rejected transitions (illegal). Diagonal cells (to === from)
// hold side-effect-only rules that don't change phase.
// ---------------------------------------------------------------------------

type Rule = {
  action: Action['type'];
  guard?: (s: State, a: Action) => boolean;
  patch: (s: State, a: Action) => Partial<State>;
};
type Matrix = Record<Phase, Partial<Record<Phase, Rule[]>>>;

// Phase iteration order for the reducer. Multi-target actions (e.g. SEEK_TO_CLIP,
// LOAD_SUCCESS, END) use exclusive guards, so iteration order does not affect
// which rule fires — it only determines which cell is visited first.
const PHASE_ORDER: Phase[] = [
  'idle',
  'loading',
  'loadedPendingSeek',
  'seeking',
  'ready',
  'ended',
  'error',
];

// ---- guards ----
const assignedGuard = (s: State, a: Action): boolean => {
  const e = a as EvtAction;
  return isValidAssignedEvent(s, e.slot, e.clipIdx, e.uri, e.loadKey);
};
const activeGuard = (s: State, a: Action): boolean => {
  const e = a as EvtAction;
  return isValidActiveEvent(s, e.slot, e.clipIdx, e.uri, e.loadKey);
};
const inactiveAssignedGuard = (s: State, a: Action): boolean =>
  assignedGuard(s, a) && (a as EvtAction).slot !== s.activeSlot;
const hasPending = (s: State) => s.seekToken !== s.appliedSeekToken;
const noPending = (s: State) => s.seekToken === s.appliedSeekToken;
const playGuard = (s: State, a: Action) => (a as ASetPlaying).playing;
const pauseGuard = (s: State, a: Action) => !(a as ASetPlaying).playing;
const preloadGuard = (s: State, a: Action) =>
  (a as APreload).slot !== s.activeSlot;
const reloadGuard = (s: State, a: Action) => {
  const act = a as AReload;
  const existing = s.slots[s.activeSlot];
  return !!existing && existing.clipIdx === act.idx;
};
const seekToClipHitGuard = (s: State, a: Action) => {
  const act = a as ASeekToClip;
  const inactive = otherSlot(s.activeSlot);
  const preload = s.slots[inactive];
  return (
    !!preload &&
    preload.clipIdx === act.nextIdx &&
    preload.uri === act.uri &&
    s.slotLoadedKey[inactive] === preload.loadKey
  );
};
const seekToClipMissGuard = (s: State, a: Action) => !seekToClipHitGuard(s, a);
const tokenGuard = (s: State, a: Action) =>
  (a as ASeekApplied).seekToken === s.seekToken;
// SEEK_APPLIED branches on state.wantPlaying (not an action field), matching the
// original `nextPhase = state.wantPlaying ? 'seeking' : 'ready'`.
const seekAppliedPlayGuard = (s: State, a: Action) =>
  tokenGuard(s, a) && s.wantPlaying;
const seekAppliedPauseGuard = (s: State, a: Action) =>
  tokenGuard(s, a) && !s.wantPlaying;
const loadSuccessActiveGuard = (s: State, a: Action) => {
  const act = a as ALoadSuccess;
  return (
    isValidAssignedEvent(s, act.slot, act.clipIdx, act.uri, act.loadKey) &&
    act.slot === s.activeSlot
  );
};
const loadSuccessInactiveRecordGuard = (s: State, a: Action) => {
  const act = a as ALoadSuccess;
  return (
    isValidAssignedEvent(s, act.slot, act.clipIdx, act.uri, act.loadKey) &&
    act.slot !== s.activeSlot &&
    s.slotLoadedKey[act.slot] !== act.loadKey
  );
};
const loadSuccessAdvancePendGuard = (s: State, a: Action) =>
  loadSuccessActiveGuard(s, a) && hasPending(s);
const loadSuccessAdvanceReadyGuard = (s: State, a: Action) =>
  loadSuccessActiveGuard(s, a) && noPending(s);
const progressGuard = (s: State, a: Action) => {
  if (!activeGuard(s, a)) return false;
  if (s.isSeeking) return false;
  if (s.seekToken !== s.appliedSeekToken) return false;
  const act = a as AProgress;
  if (s.currentIndex !== act.clipIdx) return false;
  const t = act.time;
  const target = s.currentTime;
  const EPS = 0.5;
  if (target > EPS && t < target - EPS) return false;
  // Also reject progress significantly AHEAD of current time — catches stale
  // events after a backward seek where oldTime > newTime (currentTime).
  if (t > target + MAX_PROGRESS_STEP) return false;
  return true;
};
const endHasNextGuard = (s: State, a: Action) => {
  const act = a as AEnd;
  return act.nextIdx != null && !!act.nextUri;
};
// Pure preload-hit check for END's next clip (no active guard semantics).
const endPreloadHit = (s: State, a: Action) => {
  const act = a as AEnd;
  const nextSlot = otherSlot(s.activeSlot);
  const preload = s.slots[nextSlot];
  return (
    !!preload &&
    preload.clipIdx === act.nextIdx &&
    preload.uri === act.nextUri &&
    s.slotLoadedKey[nextSlot] === preload.loadKey
  );
};
// All END transitions require an active-slot event (matches original guard).
const endNoNextGuard = (s: State, a: Action) =>
  activeGuard(s, a) && !endHasNextGuard(s, a);
const endHitGuard = (s: State, a: Action) =>
  activeGuard(s, a) && endHasNextGuard(s, a) && endPreloadHit(s, a);
const endMissGuard = (s: State, a: Action) =>
  activeGuard(s, a) && endHasNextGuard(s, a) && !endPreloadHit(s, a);
// In `seeking`, END additionally requires the seek to have settled.
const endNoNextSeekingGuard = (s: State, a: Action) =>
  activeGuard(s, a) && noPending(s) && !endHasNextGuard(s, a);
const endHitSeekingGuard = (s: State, a: Action) =>
  activeGuard(s, a) &&
  noPending(s) &&
  endHasNextGuard(s, a) &&
  endPreloadHit(s, a);
const endMissSeekingGuard = (s: State, a: Action) =>
  activeGuard(s, a) &&
  noPending(s) &&
  endHasNextGuard(s, a) &&
  !endPreloadHit(s, a);

// ---- patches ----
const setSeekingPatch = (s: State, a: Action): Partial<State> => ({
  isSeeking: (a as ASetSeeking).isSeeking,
});
const setPlayingSelfPatch = (s: State, a: Action): Partial<State> => ({
  wantPlaying: (a as ASetPlaying).playing,
});
const setPlayingPauseSeekingPatch = (): Partial<State> => ({
  wantPlaying: false,
  isLoading: false,
  needsProgressClear: false,
  pendingSeekTime: null,
});
const preloadPatch = (s: State, a: Action): Partial<State> => {
  const act = a as APreload;
  const nextLoadKey = s.loadKeySeed + 1;
  const slots: [SlotInfo | null, SlotInfo | null] = [...s.slots] as any;
  slots[act.slot] = {clipIdx: act.clipIdx, uri: act.uri, loadKey: nextLoadKey};
  const slotLoadedKey: [number | null, number | null] = [
    ...s.slotLoadedKey,
  ] as any;
  slotLoadedKey[act.slot] = null;
  return {slots, slotLoadedKey, loadKeySeed: nextLoadKey};
};
const bufferPatch = (s: State, a: Action): Partial<State> => ({
  isBuffering: (a as ABuferr).isBuffering,
});
const recordLoadedKeyPatch = (s: State, a: Action): Partial<State> => {
  const act = a as ALoadSuccess;
  const slotLoadedKey: [number | null, number | null] = [
    ...s.slotLoadedKey,
  ] as any;
  slotLoadedKey[act.slot] = act.loadKey;
  return {slotLoadedKey};
};
const seekWithinPatch = (s: State, a: Action): Partial<State> => {
  const act = a as ASeekWithin;
  const times = ensureTimesLen(s.times, s.urlsLength).slice();
  times[s.currentIndex] = act.time;
  return {
    wantPlaying: act.play ? true : s.wantPlaying,
    currentTime: act.time,
    times,
    seekToken: s.seekToken + 1,
    pendingSeekTime: act.time,
    isBuffering: false,
    error: null,
  };
};
const seekToClipHitPatch = (s: State, a: Action): Partial<State> => {
  const act = a as ASeekToClip;
  const inactive = otherSlot(s.activeSlot);
  const times = ensureTimesLen(s.times, s.urlsLength).slice();
  times[act.nextIdx] = act.time;
  return {
    wantPlaying: act.play ? true : s.wantPlaying,
    activeSlot: inactive,
    isLoading: false,
    needsProgressClear: false,
    isBuffering: false,
    error: null,
    currentIndex: act.nextIdx,
    currentTime: act.time,
    times,
    seekToken: s.seekToken + 1,
    pendingSeekTime: act.time,
  };
};
const seekToClipMissPatch = (s: State, a: Action): Partial<State> => {
  const act = a as ASeekToClip;
  const inactive = otherSlot(s.activeSlot);
  const nextLoadKey = s.loadKeySeed + 1;
  const slots: [SlotInfo | null, SlotInfo | null] = [...s.slots] as any;
  slots[inactive] = {clipIdx: act.nextIdx, uri: act.uri, loadKey: nextLoadKey};
  const slotLoadedKey: [number | null, number | null] = [
    ...s.slotLoadedKey,
  ] as any;
  slotLoadedKey[inactive] = null;
  const times = ensureTimesLen(s.times, s.urlsLength).slice();
  times[act.nextIdx] = act.time;
  return {
    wantPlaying: act.play ? true : s.wantPlaying,
    activeSlot: inactive,
    slots,
    slotLoadedKey,
    isLoading: true,
    needsProgressClear: true,
    isBuffering: false,
    error: null,
    currentIndex: act.nextIdx,
    currentTime: act.time,
    times,
    loadKeySeed: nextLoadKey,
    seekToken: s.seekToken + 1,
    pendingSeekTime: act.time,
  };
};
const seekAppliedPatch = (s: State, a: Action): Partial<State> => {
  const act = a as ASeekApplied;
  // Clear isSeeking here (not on scrubber release) so that PROGRESS and END
  // events stay gated during the entire seek operation — from drag start
  // through SEEK_APPLIED. This prevents stale native events (old position)
  // from being accepted in the window between scrubber release and the
  // video player actually completing the seek.
  if (s.wantPlaying) {
    return {appliedSeekToken: act.seekToken, isSeeking: false};
  }
  return {
    appliedSeekToken: act.seekToken,
    isSeeking: false,
    pendingSeekTime: null,
    isLoading: false,
    needsProgressClear: false,
  };
};
const reloadActivePatch = (s: State, a: Action): Partial<State> => {
  const act = a as AReload;
  const slot = s.activeSlot;
  const nextLoadKey = s.loadKeySeed + 1;
  const slots: [SlotInfo | null, SlotInfo | null] = [...s.slots] as any;
  slots[slot] = {clipIdx: act.idx, uri: act.newUri, loadKey: nextLoadKey};
  const slotLoadedKey: [number | null, number | null] = [
    ...s.slotLoadedKey,
  ] as any;
  slotLoadedKey[slot] = null;
  const times = ensureTimesLen(s.times, s.urlsLength).slice();
  times[act.idx] = act.time;
  return {
    slots,
    slotLoadedKey,
    isLoading: true,
    needsProgressClear: true,
    isBuffering: false,
    error: null,
    currentTime: act.time,
    times,
    loadKeySeed: nextLoadKey,
    seekToken: s.seekToken + 1,
    pendingSeekTime: act.time,
  };
};
const loadSuccessAdvancePatch = (s: State, a: Action): Partial<State> => {
  const base = recordLoadedKeyPatch(s, a);
  if (hasPending(s)) {
    return {...base, error: null, isBuffering: false};
  }
  const shouldWait = s.wantPlaying;
  return {
    ...base,
    error: null,
    isBuffering: false,
    isLoading: shouldWait ? s.isLoading : false,
    needsProgressClear: shouldWait ? s.needsProgressClear : false,
  };
};
const progressPatch = (s: State, a: Action): Partial<State> => {
  const act = a as AProgress;
  const t = act.time;
  const times = ensureTimesLen(s.times, s.urlsLength).slice();
  const prevT = s.currentTime;
  let {playedSeconds} = s;
  const delta = t - prevT;
  if (delta > 0 && delta <= MAX_PROGRESS_STEP) {
    playedSeconds += delta;
  }
  times[act.clipIdx] = t;
  return {
    currentTime: t,
    times,
    playedSeconds,
    isLoading: s.needsProgressClear ? false : s.isLoading,
    needsProgressClear: false,
    pendingSeekTime: null,
  };
};
const endTailPlayed = (s: State, a: Action) => {
  const act = a as AEnd;
  const times = ensureTimesLen(s.times, s.urlsLength).slice();
  const prevT = times[act.clipIdx] ?? s.currentTime;
  let {playedSeconds} = s;
  if (Number.isFinite(act.clipDuration) && act.clipDuration > 0) {
    const tail = act.clipDuration - prevT;
    if (tail > 0 && tail <= MAX_PROGRESS_STEP) {
      playedSeconds += tail;
    }
  }
  return {times, prevT, playedSeconds};
};
const endEndedPatch = (s: State, a: Action): Partial<State> => {
  const act = a as AEnd;
  const {times, prevT, playedSeconds} = endTailPlayed(s, a);
  const endT =
    Number.isFinite(act.clipDuration) && act.clipDuration > 0
      ? act.clipDuration
      : prevT;
  times[act.clipIdx] = endT;
  return {
    wantPlaying: false,
    currentTime: endT,
    times,
    playedSeconds,
    isLoading: false,
    needsProgressClear: false,
    isBuffering: false,
    sequenceEndCount: s.sequenceEndCount + 1,
  };
};
const endHitPatch = (s: State, a: Action): Partial<State> => {
  const act = a as AEnd;
  const nextSlot = otherSlot(s.activeSlot);
  const {times, playedSeconds} = endTailPlayed(s, a);
  if (Number.isFinite(act.clipDuration) && act.clipDuration > 0) {
    times[act.clipIdx] = act.clipDuration;
  }
  times[act.nextIdx!] = 0;
  return {
    activeSlot: nextSlot,
    isLoading: false,
    needsProgressClear: false,
    isBuffering: false,
    error: null,
    currentIndex: act.nextIdx!,
    currentTime: 0,
    times,
    playedSeconds,
    seekToken: s.seekToken + 1,
    pendingSeekTime: 0,
  };
};
const endMissPatch = (s: State, a: Action): Partial<State> => {
  const act = a as AEnd;
  const nextSlot = otherSlot(s.activeSlot);
  const nextLoadKey = s.loadKeySeed + 1;
  const {times, playedSeconds} = endTailPlayed(s, a);
  if (Number.isFinite(act.clipDuration) && act.clipDuration > 0) {
    times[act.clipIdx] = act.clipDuration;
  }
  times[act.nextIdx!] = 0;
  const slots: [SlotInfo | null, SlotInfo | null] = [...s.slots] as any;
  slots[nextSlot] = {
    clipIdx: act.nextIdx!,
    uri: act.nextUri!,
    loadKey: nextLoadKey,
  };
  const slotLoadedKey: [number | null, number | null] = [
    ...s.slotLoadedKey,
  ] as any;
  slotLoadedKey[nextSlot] = null;
  return {
    activeSlot: nextSlot,
    slots,
    slotLoadedKey,
    isLoading: true,
    needsProgressClear: true,
    isBuffering: false,
    error: null,
    currentIndex: act.nextIdx!,
    currentTime: 0,
    times,
    playedSeconds,
    loadKeySeed: nextLoadKey,
    seekToken: s.seekToken + 1,
    pendingSeekTime: 0,
  };
};
const errorActivePatch = (s: State, a: Action): Partial<State> => ({
  wantPlaying: false,
  isLoading: false,
  needsProgressClear: false,
  isBuffering: false,
  error: (a as AError).error,
});
const errorInactivePatch = (s: State, a: Action): Partial<State> => {
  const act = a as AError;
  const slots: [SlotInfo | null, SlotInfo | null] = [...s.slots] as any;
  const slotLoadedKey: [number | null, number | null] = [
    ...s.slotLoadedKey,
  ] as any;
  slots[act.slot] = null;
  slotLoadedKey[act.slot] = null;
  return {slots, slotLoadedKey};
};

// Shared side-effect-only self rules (referenced by every row's self cell).
const SET_SEEKING_RULE: Rule = {
  action: 'SET_SEEKING',
  patch: setSeekingPatch,
};
const PRELOAD_RULE: Rule = {
  action: 'PRELOAD_SLOT',
  guard: preloadGuard,
  patch: preloadPatch,
};
const ERROR_INACTIVE_RULE: Rule = {
  action: 'ERROR',
  guard: inactiveAssignedGuard,
  patch: errorInactivePatch,
};
const LOAD_SUCCESS_RECORD_INACTIVE: Rule = {
  action: 'LOAD_SUCCESS',
  guard: loadSuccessInactiveRecordGuard,
  patch: recordLoadedKeyPatch,
};
const LOAD_SUCCESS_RECORD_ACTIVE: Rule = {
  action: 'LOAD_SUCCESS',
  guard: loadSuccessActiveGuard,
  patch: recordLoadedKeyPatch,
};

const TRANSITIONS: Matrix = {
  idle: {
    loading: [
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipMissGuard,
        patch: seekToClipMissPatch,
      },
      {action: 'RELOAD_ACTIVE', guard: reloadGuard, patch: reloadActivePatch},
    ],
    loadedPendingSeek: [
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipHitGuard,
        patch: seekToClipHitPatch,
      },
    ],
    error: [{action: 'ERROR', guard: activeGuard, patch: errorActivePatch}],
    idle: [
      SET_SEEKING_RULE,
      PRELOAD_RULE,
      {action: 'SET_PLAYING', guard: pauseGuard, patch: setPlayingSelfPatch},
      LOAD_SUCCESS_RECORD_ACTIVE,
      LOAD_SUCCESS_RECORD_INACTIVE,
      ERROR_INACTIVE_RULE,
    ],
  },

  loading: {
    loadedPendingSeek: [
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipHitGuard,
        patch: seekToClipHitPatch,
      },
      {
        action: 'LOAD_SUCCESS',
        guard: loadSuccessAdvancePendGuard,
        patch: loadSuccessAdvancePatch,
      },
    ],
    ready: [
      {
        action: 'LOAD_SUCCESS',
        guard: loadSuccessAdvanceReadyGuard,
        patch: loadSuccessAdvancePatch,
      },
    ],
    error: [{action: 'ERROR', guard: activeGuard, patch: errorActivePatch}],
    loading: [
      SET_SEEKING_RULE,
      PRELOAD_RULE,
      {action: 'BUFFER', guard: activeGuard, patch: bufferPatch},
      {action: 'SET_PLAYING', patch: setPlayingSelfPatch},
      {action: 'SEEK_WITHIN_CLIP', patch: seekWithinPatch},
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipMissGuard,
        patch: seekToClipMissPatch,
      },
      {action: 'RELOAD_ACTIVE', guard: reloadGuard, patch: reloadActivePatch},
      LOAD_SUCCESS_RECORD_INACTIVE,
      ERROR_INACTIVE_RULE,
    ],
  },

  loadedPendingSeek: {
    loading: [
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipMissGuard,
        patch: seekToClipMissPatch,
      },
      {action: 'RELOAD_ACTIVE', guard: reloadGuard, patch: reloadActivePatch},
    ],
    seeking: [
      {
        action: 'SEEK_APPLIED',
        guard: seekAppliedPlayGuard,
        patch: seekAppliedPatch,
      },
    ],
    ready: [
      {
        action: 'SEEK_APPLIED',
        guard: seekAppliedPauseGuard,
        patch: seekAppliedPatch,
      },
    ],
    error: [{action: 'ERROR', guard: activeGuard, patch: errorActivePatch}],
    loadedPendingSeek: [
      SET_SEEKING_RULE,
      PRELOAD_RULE,
      {action: 'BUFFER', guard: activeGuard, patch: bufferPatch},
      {action: 'SET_PLAYING', patch: setPlayingSelfPatch},
      {action: 'SEEK_WITHIN_CLIP', patch: seekWithinPatch},
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipHitGuard,
        patch: seekToClipHitPatch,
      },
      LOAD_SUCCESS_RECORD_ACTIVE,
      LOAD_SUCCESS_RECORD_INACTIVE,
      ERROR_INACTIVE_RULE,
    ],
  },

  seeking: {
    loadedPendingSeek: [
      {action: 'SEEK_WITHIN_CLIP', patch: seekWithinPatch},
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipHitGuard,
        patch: seekToClipHitPatch,
      },
      {action: 'END', guard: endHitSeekingGuard, patch: endHitPatch},
    ],
    loading: [
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipMissGuard,
        patch: seekToClipMissPatch,
      },
      {action: 'RELOAD_ACTIVE', guard: reloadGuard, patch: reloadActivePatch},
      {action: 'END', guard: endMissSeekingGuard, patch: endMissPatch},
    ],
    ready: [
      {
        action: 'SET_PLAYING',
        guard: pauseGuard,
        patch: setPlayingPauseSeekingPatch,
      },
      {action: 'PROGRESS', guard: progressGuard, patch: progressPatch},
    ],
    ended: [
      {action: 'END', guard: endNoNextSeekingGuard, patch: endEndedPatch},
    ],
    error: [{action: 'ERROR', guard: activeGuard, patch: errorActivePatch}],
    seeking: [
      SET_SEEKING_RULE,
      PRELOAD_RULE,
      {action: 'BUFFER', guard: activeGuard, patch: bufferPatch},
      {action: 'SET_PLAYING', guard: playGuard, patch: setPlayingSelfPatch},
      LOAD_SUCCESS_RECORD_ACTIVE,
      LOAD_SUCCESS_RECORD_INACTIVE,
      ERROR_INACTIVE_RULE,
    ],
  },

  ready: {
    loading: [
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipMissGuard,
        patch: seekToClipMissPatch,
      },
      {action: 'RELOAD_ACTIVE', guard: reloadGuard, patch: reloadActivePatch},
      {action: 'END', guard: endMissGuard, patch: endMissPatch},
    ],
    loadedPendingSeek: [
      {action: 'SEEK_WITHIN_CLIP', patch: seekWithinPatch},
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipHitGuard,
        patch: seekToClipHitPatch,
      },
      {action: 'END', guard: endHitGuard, patch: endHitPatch},
    ],
    ended: [{action: 'END', guard: endNoNextGuard, patch: endEndedPatch}],
    error: [{action: 'ERROR', guard: activeGuard, patch: errorActivePatch}],
    ready: [
      SET_SEEKING_RULE,
      PRELOAD_RULE,
      {action: 'BUFFER', guard: activeGuard, patch: bufferPatch},
      {action: 'SET_PLAYING', patch: setPlayingSelfPatch},
      LOAD_SUCCESS_RECORD_ACTIVE,
      LOAD_SUCCESS_RECORD_INACTIVE,
      {action: 'PROGRESS', guard: progressGuard, patch: progressPatch},
      ERROR_INACTIVE_RULE,
    ],
  },

  ended: {
    loading: [
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipMissGuard,
        patch: seekToClipMissPatch,
      },
      {action: 'RELOAD_ACTIVE', guard: reloadGuard, patch: reloadActivePatch},
    ],
    loadedPendingSeek: [
      {action: 'SEEK_WITHIN_CLIP', patch: seekWithinPatch},
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipHitGuard,
        patch: seekToClipHitPatch,
      },
    ],
    error: [{action: 'ERROR', guard: activeGuard, patch: errorActivePatch}],
    ended: [
      SET_SEEKING_RULE,
      PRELOAD_RULE,
      {action: 'SET_PLAYING', guard: pauseGuard, patch: setPlayingSelfPatch},
      LOAD_SUCCESS_RECORD_ACTIVE,
      LOAD_SUCCESS_RECORD_INACTIVE,
      ERROR_INACTIVE_RULE,
    ],
  },

  error: {
    loading: [
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipMissGuard,
        patch: seekToClipMissPatch,
      },
      {action: 'RELOAD_ACTIVE', guard: reloadGuard, patch: reloadActivePatch},
    ],
    loadedPendingSeek: [
      {
        action: 'SEEK_TO_CLIP',
        guard: seekToClipHitGuard,
        patch: seekToClipHitPatch,
      },
    ],
    error: [
      SET_SEEKING_RULE,
      PRELOAD_RULE,
      {action: 'SET_PLAYING', guard: pauseGuard, patch: setPlayingSelfPatch},
      LOAD_SUCCESS_RECORD_ACTIVE,
      LOAD_SUCCESS_RECORD_INACTIVE,
      {action: 'ERROR', guard: activeGuard, patch: errorActivePatch},
      ERROR_INACTIVE_RULE,
    ],
  },
};

function initFromAction(action: AInit): State {
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
    isSeeking: false,
  };
}

function reducer(state: State, action: Action): State {
  if (action.type === 'INIT') {
    return initFromAction(action as AInit);
  }
  const row = TRANSITIONS[state.phase];
  if (!row) {
    return state;
  }
  for (const to of PHASE_ORDER) {
    const rules = row[to];
    if (!rules) {
      continue;
    }
    for (const r of rules) {
      if (r.action !== action.type) {
        continue;
      }
      if (r.guard && !r.guard(state, action)) {
        continue;
      }
      return {...state, ...r.patch(state, action), phase: to};
    }
  }
  return state;
}

export function useVideoSequencePlayer({
  urls,
  durations,
  recordDuration,
  getClipForTime,
  onClipEnd,
}: Params) {
  const playerRef0 = useRef<any>(null);
  const playerRef1 = useRef<any>(null);
  const playerRefs = useMemo(() => [playerRef0, playerRef1] as const, []);

  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useLatestRef(state);

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
  useEffect(() => {
    dispatch({
      type: 'INIT',
      urlsLength: urls.length,
      firstUri: urls[0] ?? '',
    });
  }, [urls]);

  useEffect(() => {
    const s = stateRef.current;
    if (s.phase !== 'loadedPendingSeek') return;
    if (s.seekToken === s.appliedSeekToken) return;

    const player = playerRefs[s.activeSlot].current;
    if (typeof player?.seek === 'function') {
      player.seek(s.pendingSeekTime ?? s.currentTime);
    }
    // Always dispatch SEEK_APPLIED to unblock the state machine and clear
    // isSeeking — even if the player ref isn't ready (the seek is a no-op).
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

  const setIsSeeking = useCallback((v: boolean) => {
    dispatch({type: 'SET_SEEKING', isSeeking: v});
  }, []);

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
              if (s.isSeeking) return;
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
    isSeeking: state.isSeeking,
    setIsSeeking,

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
