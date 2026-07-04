import React, {useMemo, useRef, useState, useCallback, useEffect} from 'react';
import {PanResponder, View} from 'react-native';
import {useLatestRef} from '../utils';

type UseScrubberParams = {
  enabled: boolean;
  total: number; // safeTotal
  baseTime: number; // current virtual time (no preview)
  onCommit: (t: number, reason: string) => void;
  onSeekingChange?: (seeking: boolean) => void;
  clearPreviewDelayMs?: number;
  gestureAxis?: 'x' | 'y';
  gestureAxisReversed?: boolean;
};

type UseScrubberResult = {
  isSeeking: boolean;
  displayedTime: number;
  fillW: number;
  thumbLeft: number;
  trackRef: React.RefObject<View | null>;
  onTrackLayout: (e: any) => void;
  panHandlers: any;
  measureTrack: () => void;
};

export function useScrubber({
  enabled,
  total,
  baseTime,
  onCommit,
  onSeekingChange,
  clearPreviewDelayMs = 150,
  gestureAxis = 'x',
  gestureAxisReversed = false,
}: UseScrubberParams): UseScrubberResult {
  const trackRef = useRef<View>(null);
  const [trackW, setTrackW] = useState(0);

  const [isSeeking, setIsSeeking] = useState(false);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const [previewX, setPreviewX] = useState<number | null>(null);

  const scrubCurrentXRef = useRef(0);
  const trackPageXRef = useRef(0);
  const trackPageYRef = useRef(0);
  const trackScreenWRef = useRef(0);
  const trackScreenHRef = useRef(0);
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
  const gestureAxisRef = useLatestRef(gestureAxis);
  const gestureAxisReversedRef = useLatestRef(gestureAxisReversed);

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
    const THUMB_SIZE = 20;
    if (!trackW) {
      return 0;
    }
    const left = displayedX - THUMB_SIZE / 2;
    return Math.max(0, Math.min(trackW - THUMB_SIZE, left));
  }, [displayedX, trackW]);

  const measureTrack = useCallback(() => {
    trackRef.current?.measureInWindow?.(
      (x: number, y: number, width: number, height: number) => {
        if (Number.isFinite(x)) {
          trackPageXRef.current = x;
        }
        if (Number.isFinite(y)) {
          trackPageYRef.current = y;
        }
        if (Number.isFinite(width)) {
          trackScreenWRef.current = width;
        }
        if (Number.isFinite(height)) {
          trackScreenHRef.current = height;
        }
      },
    );
  }, []);

  const onTrackLayout = useCallback(
    (e: any) => {
      const w = Number(e?.nativeEvent?.layout?.width ?? 0);
      setTrackW(w);
      measureTrack();
    },
    [measureTrack],
  );

  const clampToTrack = useCallback((x: number, w: number) => {
    return Math.max(0, Math.min(w, x));
  }, []);

  const getLogicalXFromEvent = useCallback(
    (evt: any) => {
      const w = trackWRef.current;
      if (w <= 0) {
        return 0;
      }

      const ne = evt?.nativeEvent;
      const axis = gestureAxisRef.current;

      if (axis === 'y') {
        const pgY = Number(ne?.pageY);
        const startY = trackPageYRef.current;
        const screenH = trackScreenHRef.current;

        if (Number.isFinite(pgY) && Number.isFinite(startY) && screenH > 0) {
          let screenOffset = pgY - startY;
          if (gestureAxisReversedRef.current) {
            screenOffset = screenH - screenOffset;
          }
          return (clampToTrack(screenOffset, screenH) / screenH) * w;
        }

        return scrubCurrentXRef.current;
      }

      const locX = Number(ne?.locationX);
      if (Number.isFinite(locX)) {
        return clampToTrack(locX, w);
      }

      const pgX = Number(ne?.pageX);
      const startX = trackPageXRef.current;
      if (Number.isFinite(pgX) && Number.isFinite(startX)) {
        return clampToTrack(pgX - startX, w);
      }

      return scrubCurrentXRef.current;
    },
    [clampToTrack, gestureAxisRef, gestureAxisReversedRef, trackWRef],
  );

  const updatePreviewFromX = useCallback(
    (x: number) => {
      const w = trackWRef.current;
      const tot = totalRef.current;
      const clampedX = clampToTrack(x, w);

      scrubCurrentXRef.current = clampedX;
      setPreviewX(clampedX);

      if (w > 0 && tot > 0) {
        const t = Math.max(0, Math.min(tot, (clampedX / w) * tot));
        setPreviewTime(t);
      }
    },
    [clampToTrack, totalRef, trackWRef],
  );

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

        measureTrack();
        setIsSeeking(true);
        onSeekingChangeRef.current?.(true);
        updatePreviewFromX(getLogicalXFromEvent(evt));
      },
      onPanResponderMove: evt => {
        updatePreviewFromX(getLogicalXFromEvent(evt));
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

        scrubCurrentXRef.current = 0;
      },
      onPanResponderTerminate: () => {
        setPreviewTime(null);
        setPreviewX(null);
        setIsSeeking(false);
        onSeekingChangeRef.current?.(false);
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
    measureTrack,
  };
}
