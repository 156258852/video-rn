import {useCallback, useState} from 'react';

import {useVideoDurations} from './useVideoDurations';
import {useVideoSequencePlayer} from './useVideoSequencePlayer';
import {useVirtualTimeline} from './useVirtualTimeline';

type ClipEndPayload = {idx: number; uri: string; duration: number};

type RecordDuration = (idx: number, durationSeconds: number) => void;

type UseVideoSequenceTimelinePlayerParams = {
  urls: string[];
  onClipEnd?: (payload: ClipEndPayload) => void;
  durations?: number[];
  recordDuration?: RecordDuration;
  enablePreload?: boolean;
};

type SeekVirtualOptions = {
  play?: boolean;
};

export function useVideoSequenceTimelinePlayer({
  urls,
  onClipEnd,
  durations: externalDurations,
  recordDuration: externalRecordDuration,
  enablePreload = true,
}: UseVideoSequenceTimelinePlayerParams) {
  const [isSeeking, setIsSeeking] = useState(false);
  const durationState = useVideoDurations(urls, {enabled: enablePreload});
  const durations = externalDurations ?? durationState.durations;
  const recordDuration = externalRecordDuration ?? durationState.recordDuration;
  const {preloadNode} = durationState;

  const player = useVideoSequencePlayer({
    urls,
    durations,
    recordDuration,
    isSeeking,
    onClipEnd,
  });

  // Use times[currentIndex] (state) as currentTime so useVirtualTimeline
  // re-renders when progress updates. currentTimeRef.current is a plain ref
  // and does NOT trigger re-renders, causing virtualTime to lag one frame.
  const currentTime = player.times[player.currentIndex] ?? 0;

  const timeline = useVirtualTimeline({
    durations,
    currentIndex: player.currentIndex,
    currentTime,
  });

  // Override seekVirtual: resolve virtual time → clip+local via timeline,
  // then delegate to player.seekToClip. Explicit to avoid ambiguity with
  // player.seekVirtual (which requires getClipForTime prop, not wired here).
  const seekVirtual = useCallback(
    (t: number, opts?: SeekVirtualOptions) => {
      const {idx, local} = timeline.getClipForTime(t);
      player.seekToClip(idx, local, {play: opts?.play ?? true});
    },
    [player, timeline],
  );

  return {
    // preload
    preloadNode,
    durations,

    // player state
    videoSlots: player.videoSlots,
    activePlayer: player.activePlayer,
    playing: player.playing,
    setPlaying: player.setPlaying,
    playingRef: player.playingRef,
    sequenceEndCount: player.sequenceEndCount,
    playedSecondsRef: player.playedSecondsRef,
    getTotalDuration: player.getTotalDuration,
    allDurationsKnown: player.allDurationsKnown,
    isLoading: player.isLoading,
    isBuffering: player.isBuffering,
    currentIndex: player.currentIndex,
    currentTimeRef: player.currentTimeRef,

    // timeline state
    ready: timeline.ready,
    virtualTime: timeline.virtualTime,
    total: timeline.total,
    totalSafe: timeline.totalSafe,
    offsets: timeline.offsets,

    // scrubber / seek helpers
    isSeeking,
    setIsSeeking,
    seekVirtual,
    queueResumeForCurrentClip: player.queueResumeForCurrentClip,
  };
}
