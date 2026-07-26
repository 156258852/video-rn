---
kind: error_handling
name: Error Handling in Video Sequence Player
category: error_handling
scope:
    - '**'
source_files:
    - hooks/useVideoSequencePlayer.ts
    - App.tsx
    - hooks/useVideoDurations.tsx
---

This React Native video player project implements error handling through a combination of callback-based event propagation, a state machine with an explicit `error` phase, and automatic retry logic. There is no centralized error type system or middleware — errors are handled locally where they occur.

**System approach:**
- Errors from the underlying `react-native-video` component are propagated via `onError` callbacks to hooks and the top-level App component
- The core `useVideoSequencePlayer` hook uses a finite state machine (FSM) with a dedicated `error` phase that transitions into when errors occur
- A single `try/catch` block wraps native player `seek()` calls to prevent crashes during seek operations
- No `throw` statements, Promise rejections, or custom error types are used anywhere in the codebase

**Key patterns:**
1. **Callback-based error propagation**: The `onError` prop flows from `App.tsx` → `useVideoSequenceTimelinePlayer` → `useVideoSequencePlayer`, which dispatches `{type: 'ERROR', error}` actions to the reducer
2. **State machine error handling**: The FSM defines `error` as a valid phase with specific transition rules. Error patches clear loading/buffering states and store the error object in `state.error`
3. **Automatic retry mechanism**: When in `error` phase, the hook automatically retries up to `MAX_ERROR_RETRIES` (3) times with `ERROR_RETRY_DELAY_MS` (3000ms) delay by reloading the active clip with a cache-busted URL (`_resume=timestamp` parameter)
4. **Silent failure for non-critical operations**: Seek failures are caught and ignored, treating them as no-ops to unblock the state machine
5. **Validation-based error prevention**: Input validation guards against invalid parameters (e.g., negative durations, out-of-range indices) rather than throwing errors

**Conventions observed:**
- Error objects are passed through as-is without transformation or wrapping
- The UI displays loading indicators during error recovery but doesn't show user-facing error messages
- Console logging is used for debugging (`console.log` in App.tsx), but there's no structured logging framework
- Error handling is localized to each component/hook rather than centralized
- No global error boundaries or React Error Boundary components are implemented