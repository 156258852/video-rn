import {useMemo, useCallback} from 'react';

type ClipForTime = {
  idx: number;
  local: number;
};

type UseVirtualTimelineParams = {
  durations: number[];
  currentIndex: number;
  currentTime: number;
  version?: number; // ✅ 新增
};

type UseVirtualTimelineResult = {
  offsets: number[];
  total: number;
  ready: boolean;
  virtualTime: number;
  getClipForTime: (t: number) => ClipForTime;
  clampVirtualTime: (t: number) => number;
  totalSafe: number;
};

export function useVirtualTimeline({
  durations,
  currentIndex,
  currentTime,
  version = 0, // ✅ 默认值
}: UseVirtualTimelineParams): UseVirtualTimelineResult {
  /**
   * ✅ offsets: 每段起点
   */
  const offsets = useMemo(() => {
    const arr: number[] = [0];

    for (let i = 0; i < durations.length; i++) {
      const d = Number.isFinite(durations[i]) ? durations[i] : 0;
      arr[i + 1] = arr[i] + d;
    }

    return arr;
  }, [durations]);

  /**
   * ✅ 总时长
   */
  const total = offsets[offsets.length - 1] ?? 0;

  /**
   * ✅ timeline ready
   * - durations 全部有效
   * - total > 0
   */
  const ready =
    durations.length > 0 &&
    durations.every(d => Number.isFinite(d) && d > 0) &&
    total > 0;

  /**
   * ✅ clamp
   */
  const clampVirtualTime = useCallback(
    (t: number) => {
      const tt = Number(t);
      if (!Number.isFinite(tt)) {
        return 0;
      }

      if (durations.length === 0) {
        return 0;
      }

      const lastIdx = durations.length - 1;
      const lastOffset = offsets[lastIdx] ?? 0;
      const lastDur = Number.isFinite(durations[lastIdx])
        ? durations[lastIdx]
        : 0;

      const maxT = lastOffset + lastDur;

      if (tt < 0) {
        return 0;
      }
      if (tt > maxT) {
        return maxT;
      }

      return tt;
    },
    [durations, offsets],
  );

  /**
   * ✅ virtualTime（关键：依赖 version）
   */
  const virtualTime = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = version; // cache-bust when player advances to next clip
    const base = offsets[currentIndex] ?? 0;
    const t = Number.isFinite(currentTime) ? currentTime : 0;

    return clampVirtualTime(base + Math.max(0, t));
  }, [currentIndex, currentTime, offsets, clampVirtualTime, version]);

  /**
   * ✅ 二分查找
   */
  const findClipIndex = useCallback(
    (t: number) => {
      let low = 0;
      let high = offsets.length - 2;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);

        const start = offsets[mid] ?? 0;
        const end = offsets[mid + 1] ?? total;

        if (t >= start && t < end) {
          return mid;
        }

        if (t < start) {
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }

      return Math.max(0, offsets.length - 2);
    },
    [offsets, total],
  );

  /**
   * ✅ clip + local time
   */
  const getClipForTime = useCallback(
    (t: number): ClipForTime => {
      const clampedT = clampVirtualTime(t);

      if (!durations.length) {
        return {idx: 0, local: 0};
      }

      const idx = findClipIndex(clampedT);

      let local = clampedT - (offsets[idx] ?? 0);
      if (local < 0) {
        local = 0;
      }

      const dur = Number.isFinite(durations[idx]) ? durations[idx] : 0;
      if (dur > 0 && local > dur) {
        local = dur;
      }

      return {idx, local};
    },
    [clampVirtualTime, durations, findClipIndex, offsets],
  );

  const totalSafe = ready ? total : 0;

  return {
    offsets,
    total,
    ready,
    virtualTime,
    getClipForTime,
    clampVirtualTime,
    totalSafe,
  };
}
