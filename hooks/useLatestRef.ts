import {useRef} from 'react';

/**
 * Returns a ref that always holds the latest value of the given argument.
 * The ref is updated synchronously during render (not in useEffect), so
 * reading ref.current inside any callback always returns the current-render
 * value without a one-frame lag.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value; // synchronous — safe because this is a plain assignment, no side-effect
  return ref;
}
