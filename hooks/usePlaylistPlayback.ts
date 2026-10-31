import {useCallback, useMemo, useRef, useState} from 'react';

const PLAYLIST_MARKER = '#playlist=';

/**
 * 单播放器播放「原生合成后的整条时间轴」。
 *
 * 拼接发生在 iOS 原生侧（AVMutableComposition），所以这里拿到的
 * duration 是总时长、currentTime 是全局时间、seek 也是全局的，
 * 不再需要虚拟时间轴 / 双播放器预加载 / 逐片段时长探测。
 *
 * 交互 UI（进度条、全屏、按钮、完成度）仍然由 RN 自绘。
 */
export function usePlaylistPlayback(urls: string[]) {
  const videoRef = useRef<any>(null);

  const [playing, setPlayingState] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);

  const playingRef = useRef(false);
  const endedRef = useRef(false);
  const lastTimeRef = useRef(0);
  const watchedSecondsRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);

  // 播放列表挂在第一个 URL 的 fragment 上，原生插件据此合成 composition
  const source = useMemo(
    () => ({
      uri: `${urls[0]}${PLAYLIST_MARKER}${urls
        .map(u => encodeURIComponent(u))
        .join(',')}`,
    }),
    [urls],
  );

  const setPlaying = useCallback((next: boolean) => {
    playingRef.current = next;
    setPlayingState(next);
  }, []);

  const onLoad = useCallback((e: any) => {
    setDuration(e?.duration ?? 0);
    setIsLoading(false);

    // 全屏 Modal 会 remount <Video>，这里把进入全屏前快照的位置补回去
    if (pendingSeekRef.current != null) {
      videoRef.current?.seek(pendingSeekRef.current);
      lastTimeRef.current = pendingSeekRef.current;
      pendingSeekRef.current = null;
    }
  }, []);

  const onProgress = useCallback((e: any) => {
    const t = e?.currentTime ?? 0;
    setCurrentTime(t);

    // 只累加自然播放增量，seek 造成的跳变不计入观看时长
    const delta = t - lastTimeRef.current;
    if (delta > 0 && delta < 1.5) {
      watchedSecondsRef.current += delta;
    }
    lastTimeRef.current = t;
  }, []);

  const onEnd = useCallback(() => {
    endedRef.current = true;
    setPlaying(false);
  }, [setPlaying]);

  const onBuffer = useCallback((e: any) => {
    setIsBuffering(!!e?.isBuffering);
  }, []);

  const seek = useCallback((t: number) => {
    const clamped = Math.max(0, t);
    videoRef.current?.seek(clamped);
    setCurrentTime(clamped);
    lastTimeRef.current = clamped;
  }, []);

  // 进入 / 退出全屏前调用：<Video> 会 remount，快照位置留到 onLoad 里恢复
  const snapshotForRemount = useCallback(() => {
    pendingSeekRef.current = lastTimeRef.current;
    return lastTimeRef.current;
  }, []);

  const ready = duration > 0;
  const hasCompletedPlayback =
    endedRef.current || watchedSecondsRef.current >= duration * 0.98;

  return {
    videoRef,
    source,
    playing,
    playingRef,
    setPlaying,
    duration,
    currentTime,
    isLoading,
    isBuffering,
    ready,
    watchedSecondsRef,
    hasCompletedPlayback,
    seek,
    snapshotForRemount,
    onLoad,
    onProgress,
    onEnd,
    onBuffer,
  };
}
