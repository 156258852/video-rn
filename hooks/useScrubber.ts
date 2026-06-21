import React, {useMemo, useRef, useState, useCallback, useEffect} from 'react';
import {PanResponder, View} from 'react-native';
import {useLatestRef} from './useLatestRef';

type UseScrubberParams = {
  enabled: boolean;
  total: number; // safeTotal
  baseTime: number; // current virtual time (no preview)
  onCommit: (t: number, reason: string) => void;
  onSeekingChange?: (seeking: boolean) => void;
  clearPreviewDelayMs?: number;
};

type UseScrubberResult = {
  isSeeking: boolean;
  displayedTime: number;
  fillW: number;
  thumbLeft: number;
  trackRef: React.RefObject<View>;
  onTrackLayout: (e: any) => void;
  panHandlers: any;
};

export function useScrubber({
  enabled,
  total,
  baseTime,
  onCommit,
  onSeekingChange,
  clearPreviewDelayMs = 150,
}: UseScrubberParams): UseScrubberResult {
  const trackRef = useRef<View>(null);
  const [trackW, setTrackW] = useState(0);

  const [isSeeking, setIsSeeking] = useState(false);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const [previewX, setPreviewX] = useState<number | null>(null);

  const scrubStartXRef = useRef(0);
  const scrubCurrentXRef = useRef(0);
  const trackPageXRef = useRef(0);
  const clearPreviewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Keep latest values in refs so the PanResponder (created once) always sees
  // up-to-date state without needing to be recreated mid-gesture.
  const enabledRef = useLatestRef(enabled);
  const totalRef = useLatestRef(total);
  const trackWRef = useLatestRef(trackW);
  const onCommitRef = useLatestRef(onCommit);
  const onSeekingChangeRef = useLatestRef(onSeekingChange);
  const clearPreviewDelayMsRef = useLatestRef(clearPreviewDelayMs);

  useEffect(() => {
    return () => {
      if (clearPreviewTimeoutRef.current) {
        clearTimeout(clearPreviewTimeoutRef.current);
        clearPreviewTimeoutRef.current = null;
      }
    };
  }, []);

  const displayedTime = useMemo(() => {
    return previewTime != null ? previewTime : baseTime;
  }, [baseTime, previewTime]);

  const displayedPercent = useMemo(() => {
    const safeTotal = Number.isFinite(total) && total > 0 ? total : 1;
    return Math.max(0, Math.min(1, displayedTime / safeTotal));
  }, [displayedTime, total]);

  const displayedX = useMemo(() => {
    if (previewX != null) {
      return Math.max(0, Math.min(trackW, previewX));
    }
    if (!trackW) {
      return 0;
    }
    const x = displayedPercent * trackW;
    return Number.isFinite(x) ? Math.max(0, Math.min(trackW, x)) : 0;
  }, [displayedPercent, previewX, trackW]);

  const fillW = useMemo(() => {
    return Math.max(0, Math.min(trackW, displayedX));
  }, [displayedX, trackW]);

  const thumbLeft = useMemo(() => {
    return Math.max(0, displayedX - 8);
  }, [displayedX]);

  const onTrackLayout = useCallback((e: any) => {
    const w = Number(e?.nativeEvent?.layout?.width ?? 0);
    setTrackW(w);
    // Measure absolute screen position for locationX fallback in PanResponder
    trackRef.current?.measureInWindow?.((x: number) => {
      if (Number.isFinite(x)) {
        trackPageXRef.current = x;
      }
    });
  }, []);

  // PanResponder is created ONCE and never recreated. All callbacks read from
  // refs so they always use the current values without triggering a new
  // PanResponder instance (which would drop an in-progress gesture).
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => enabledRef.current,
      onMoveShouldSetPanResponder: () => enabledRef.current,
      onPanResponderGrant: evt => {
        if (clearPreviewTimeoutRef.current) {
          clearTimeout(clearPreviewTimeoutRef.current);
          clearPreviewTimeoutRef.current = null;
        }

        setIsSeeking(true);
        onSeekingChangeRef.current?.(true);

        const ne = evt?.nativeEvent;
        const locX = Number(ne?.locationX);
        const pgX = Number(ne?.pageX);
        // locationX can be unreliable on some Android devices; fall back to
        // pageX - trackPageX (measured in onTrackLayout via measureInWindow)
        const x = Number.isFinite(locX)
          ? locX
          : Number.isFinite(pgX) && trackPageXRef.current > 0
          ? pgX - trackPageXRef.current
          : 0;
        scrubStartXRef.current = x;
        scrubCurrentXRef.current = x;

        const w = trackWRef.current;
        const tot = totalRef.current;
        if (w > 0 && tot > 0) {
          const t = Math.max(
            0,
            Math.min(tot, (Math.max(0, Math.min(w, x)) / w) * tot),
          );
          setPreviewTime(t);
        }
        setPreviewX(x);
      },
      onPanResponderMove: (evt, gesture) => {
        const ne = evt?.nativeEvent;
        const locX = Number(ne?.locationX);
        const pgX = Number(ne?.pageX);
        const locationX = Number.isFinite(locX)
          ? locX
          : Number.isFinite(pgX) && trackPageXRef.current > 0
          ? pgX - trackPageXRef.current
          : 0;
        const x = Number.isFinite(gesture?.dx)
          ? scrubStartXRef.current + gesture.dx
          : locationX;

        scrubCurrentXRef.current = x;

        const w = trackWRef.current;
        const tot = totalRef.current;
        if (w > 0 && tot > 0) {
          const t = Math.max(
            0,
            Math.min(tot, (Math.max(0, Math.min(w, x)) / w) * tot),
          );
          setPreviewTime(t);
        }
        setPreviewX(x);
      },
      onPanResponderRelease: () => {
        const x = scrubCurrentXRef.current;
        setIsSeeking(false);
        onSeekingChangeRef.current?.(false);

        const w = trackWRef.current;
        const tot = totalRef.current;
        if (w > 0 && tot > 0) {
          const t = Math.max(
            0,
            Math.min(tot, (Math.max(0, Math.min(w, x)) / w) * tot),
          );
          onCommitRef.current(t, 'scrubRelease');
        }

        // Cancel any pending clear
        if (clearPreviewTimeoutRef.current) {
          clearTimeout(clearPreviewTimeoutRef.current);
        }

        // Schedule clearing preview after delay
        const delay = clearPreviewDelayMsRef.current;
        clearPreviewTimeoutRef.current = setTimeout(() => {
          setPreviewTime(null);
          setPreviewX(null);
          clearPreviewTimeoutRef.current = null;
        }, delay);

        scrubStartXRef.current = 0;
        scrubCurrentXRef.current = 0;
      },
      onPanResponderTerminate: () => {
        setPreviewTime(null);
        setPreviewX(null);
        setIsSeeking(false);
        onSeekingChangeRef.current?.(false);
        scrubStartXRef.current = 0;
        scrubCurrentXRef.current = 0;
      },
    }),
  ).current;

  return {
    isSeeking,
    displayedTime,
    fillW,
    thumbLeft,
    trackRef,
    onTrackLayout,
    panHandlers: panResponder.panHandlers,
  };
}
