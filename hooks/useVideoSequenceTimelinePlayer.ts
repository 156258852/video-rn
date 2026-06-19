import {useCallback, useMemo, useState} from 'react';

import {useVideoDurations} from './useVideoDurations';
import {useVideoSequencePlayer} from './useVideoSequencePlayer';
import {useVirtualTimeline} from './useVirtualTimeline';

type UseVideoSequenceTimelinePlayerParams = {
  urls: string[];
};

export function useVideoSequenceTimelinePlayer({
  urls,
}: UseVideoSequenceTimelinePlayerParams) {
  const [isSeeking, setIsSeeking] = useState(false);
  const {durations, recordDuration, preloadNode} = useVideoDurations(urls);

  const player = useVideoSequencePlayer({
    urls,
    durations,
    recordDuration,
    isSeeking,
  });

  // Use times[currentIndex] (state) as currentTime so useVirtualTimeline
  // re-renders when progress updates. currentTimeRef.current is a plain ref
  // and does NOT trigger re-renders, causing virtualTime to lag one frame.
  const currentTime = player.times[player.currentIndex] ?? 0;

  const timeline = useVirtualTimeline({
    durations,
    currentIndex: player.currentIndex,
    currentTime,
    version: player.version,
  });

  const totalSafe = useMemo(() => {
    return timeline.ready ? timeline.total : 1;
  }, [timeline.ready, timeline.total]);

  // Override seekVirtual: resolve virtual time → clip+local via timeline,
  // then delegate to player.seekToClip. Explicit to avoid ambiguity with
  // player.seekVirtual (which requires getClipForTime prop, not wired here).
  const seekVirtual = useCallback(
    (t: number) => {
      const {idx, local} = timeline.getClipForTime(t);
      player.seekToClip(idx, local, {play: true});
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
    hasCompletedPlayback: player.hasCompletedPlayback,
    currentIndex: player.currentIndex,
    currentTimeRef: player.currentTimeRef,

    // timeline state
    ready: timeline.ready,
    virtualTime: timeline.virtualTime,
    total: timeline.total,
    totalSafe,
    offsets: timeline.offsets,

    // scrubber / seek helpers
    isSeeking,
    setIsSeeking,
    seekVirtual,
    queueResumeForCurrentClip: player.queueResumeForCurrentClip,
  };
}
