import {useCallback, useRef, useState} from 'react';

export const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

export const useUpdate = () => {
  const [, setState] = useState({});

  return useCallback(() => setState({}), []);
};

export const useLatestRef = <T>(value: T) => {
  const ref = useRef<T>(value);
  ref.current = value;
  return ref;
};
