import {useCallback, useEffect, useRef, useState} from 'react';
import {useLatestRef} from './useLatestRef';
import {Animated} from 'react-native';

type UseAutoHideControlsParams = {
  enabled: boolean;
  playing: boolean;
  delayMs?: number;
};

type UseAutoHideControlsResult = {
  visible: boolean;
  opacity: Animated.Value;
  show: () => void;
  hide: () => void;
  toggle: () => void;
  onTap: () => void;
};

export function useAutoHideControls({
  enabled,
  playing,
  delayMs = 3500,
}: UseAutoHideControlsParams): UseAutoHideControlsResult {
  const [visible, setVisible] = useState(true);
  const visibleRef = useRef(true);

  const opacity = useRef(new Animated.Value(1)).current;

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playingRef = useLatestRef(playing);

  const cancelHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const animate = useCallback(
    (toVisible: boolean) => {
      visibleRef.current = toVisible;
      setVisible(toVisible);

      Animated.timing(opacity, {
        toValue: toVisible ? 1 : 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const scheduleHide = useCallback(() => {
    cancelHideTimer();

    // Don't auto-hide while paused — user is probably reading the UI.
    if (!playingRef.current) {
      return;
    }

    hideTimerRef.current = setTimeout(() => {
      animate(false);
    }, delayMs);
  }, [animate, cancelHideTimer, delayMs, playingRef]);

  const show = useCallback(() => {
    animate(true);
    scheduleHide();
  }, [animate, scheduleHide]);

  const hide = useCallback(() => {
    cancelHideTimer();
    animate(false);
  }, [animate, cancelHideTimer]);

  const toggle = useCallback(() => {
    if (visibleRef.current) {
      hide();
    } else {
      show();
    }
  }, [hide, show]);

  const onTap = useCallback(() => {
    toggle();
  }, [toggle]);

  // Reset visibility whenever we (re)enter fullscreen, and clear timer on exit.
  useEffect(() => {
    if (enabled) {
      animate(true);
      scheduleHide();
    } else {
      cancelHideTimer();
      // reset to visible for next time
      animate(true);
    }

    return () => cancelHideTimer();
  }, [enabled, animate, scheduleHide, cancelHideTimer]);

  // When playback pauses, keep controls shown; when it resumes, start the hide timer.
  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (playing) {
      scheduleHide();
    } else {
      cancelHideTimer();
      animate(true);
    }
  }, [playing, enabled, scheduleHide, cancelHideTimer, animate]);

  return {visible, opacity, show, hide, toggle, onTap};
}
