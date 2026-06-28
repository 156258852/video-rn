# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install && cd ios && pod install && cd ..

# Start Metro bundler
npm start

# Run on iOS simulator
npx react-native run-ios --simulator "iPhone 17 Pro"

# Run on Android
npm run android

# Lint
npm run lint

# Run all tests
npm test

# Run a single test file
npx jest --testPathPattern="<pattern>"

# TypeScript check
npx tsc --noEmit
```

## Architecture

React Native 0.74 POC (iOS-focused) for **virtual stitching** multiple MP4 clips into a single continuous timeline with a custom scrubber. The app presents an "AIA Points mission" UI where users watch a sequence of videos to earn points.

### Layered Hook Architecture

The playback engine decomposes cleanly into four layers, each in `hooks/`:

1. **`useVideoDurations`** — Data collection. Preloads each URL (one at a time) via a hidden `<Video>` to read durations from `onLoad(e.duration)`. Exposes `recordDuration(idx, sec)` for real players to also fill gaps. Outputs `durations[]` (NaN until known) and a `preloadNode` to render.

2. **`useVirtualTimeline`** — Pure math layer. Maps per-clip local times ⇄ one continuous "virtual time" axis. Computes `offsets[]` (prefix sums of durations), `total`, and provides `getClipForTime(t)` via binary search. The `version` param force-busts `useMemo` when player time is stored in a ref.

3. **`useVideoSequencePlayer`** — Dual-player state machine. Manages two `<Video>` slots (active + preloading next clip), clip switching on `onEnd`, seek across clip boundaries, playback completion detection (watched-seconds ≥ 98% of total via accumulated natural-progress deltas). `videoSlots` output is directly renderable.

4. **`useVideoSequenceTimelinePlayer`** — Orchestration facade. Composes 1-3 into one public API, plus `totalSafe` (guards against total=0 before timeline is ready) and `seekVirtual` (resolves virtual time → clip+local via timeline, delegates to player).

### Fullscreen via Modal Remount

Fullscreen is a `<Modal>` that **remounts** `<Video>` components. `queueResumeForCurrentClip()` snapshots `{clipIdx, localTime}` into `pendingResumeRef`, resolved in `onClipLoad` after modal Video instances finish loading.

### Custom Scrubber

`useScrubber` implements drag + tap-to-seek via a single stable `PanResponder` instance. Reads all state from refs via `useLatestRef` to avoid recreating the PanResponder mid-gesture. `onSeekingChange` lets the player ignore `onProgress` callbacks during drag.

### Key Helper: `useLatestRef`

Returns a ref updated synchronously during render (via direct assignment `ref.current = value`), not in `useEffect`. Ensures callbacks always see current state without stale closures — used extensively by `useScrubber` and `useVideoSequencePlayer`.

## Code Conventions

- **Prettier**: single quotes, trailing commas, no bracket spacing, 80 char print width
- **Design tokens**: All styling uses constants from `theme/qi.ts` (colors, spacing, radius, typography, shadow). Do not introduce raw color/spacing literals when a token exists.
- **Hook location**: All custom hooks live in `hooks/`.
- **`@ts-nocheck`**: `App.tsx` has `@ts-nocheck` — type errors there are suppressed.
- **iOS primary target**: `react-native-video` v6 uses AVPlayer on iOS, ExoPlayer on Android. `bufferConfig.cacheSizeMB: 200` is set on video sources.
