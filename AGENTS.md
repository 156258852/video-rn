# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## Project Overview

React Native 0.74 POC (iOS-focused) for **virtual stitching** multiple MP4 clips into a single continuous timeline with a custom scrubber. The app demonstrates an "AIA Points mission" UI where users must watch a sequence of videos to complete a task.

## Commands

```bash
# Install dependencies
npm install
cd ios && pod install && cd ..

# Start Metro bundler
npm start

# Run on iOS simulator
npx react-native run-ios --simulator "iPhone 17 Pro"

# Run on Android
npm run android

# Lint
npm run lint

# Tests (Jest with react-native preset)
npm test
npx jest --testPathPattern="<pattern>"   # run a single test file

# TypeScript check (no standalone script — use IDE or):
npx tsc --noEmit
```

## Architecture

### Dual-Player Preload System

The core playback engine uses **two `<Video>` slots** (`useVideoSequencePlayer`) instead of one. The active slot plays the current clip while the inactive slot preloads the next clip (or the seek target's next clip). This enables gapless transitions between clips. Key concepts:

- `activePlayer` (0 or 1) — which slot is currently visible/playing
- `pendingSeekRef` / `pendingResumeRef` — queued seek requests resolved in `onClipLoad`
- `loadedSlotRef` — tracks which clip each slot has loaded, used to skip redundant `onLoad` waits
- `version` counter — bumped only on seek/clip-switch (not progress ticks) to control re-render scope

### Virtual Timeline Layer

`useVirtualTimeline` maps per-clip local times to a single continuous "virtual time" axis:

- `offsets[]` — cumulative start time of each clip (prefix sums of durations)
- `virtualTime` = `offsets[currentIndex] + currentTime`
- `getClipForTime(t)` — binary search to resolve virtual time → `{clipIdx, localTime}`

### Orchestration Hook

`useVideoSequenceTimelinePlayer` composes three sub-hooks into one public API:

1. `useVideoDurations` — preloads each URL via a hidden `<Video>` to read durations from `onLoad`
2. `useVideoSequencePlayer` — dual-player playback, clip switching, seek, completion tracking
3. `useVirtualTimeline` — virtual time axis computation

`App.tsx` consumes only this orchestration hook.

### Custom Scrubber

`useScrubber` implements drag + tap-to-seek via `PanResponder`. It uses `useLatestRef` to keep the PanResponder instance stable (created once) while always reading fresh state from refs. Preview time is shown during drag and cleared 150ms after release.

### Playback Completion Detection

Completion is tracked via `watchedSecondsRef` (accumulated natural-progress deltas) compared against `totalDuration * 0.98`. Large time jumps (seeks) are excluded from the watched total. `hasCompletedPlayback` gates the "Complete" CTA button.

### Fullscreen via Modal Remount

Fullscreen is implemented as a `<Modal>` that **remounts** the `<Video>` components. To preserve playback position across remounts, `queueResumeForCurrentClip()` snapshots `{clipIdx, localTime}` into `pendingResumeRef`, which is resolved in `onClipLoad` after the modal's Video instances finish loading.

## Code Conventions

- **Prettier**: single quotes, trailing commas, no bracket spacing, 80 char print width (see `.prettierrc`)
- **Design tokens**: All styling uses the Qi Design System tokens from `theme/qi.ts` (colors, spacing, radius, typography, shadow). Do not introduce raw color/spacing literals when a token exists.
- **Hook pattern**: All custom hooks live in `hooks/`. The `useLatestRef` utility is used extensively to avoid stale closures in PanResponder and setTimeout callbacks.
- **`@ts-nocheck`**: `App.tsx` has `@ts-nocheck` at the top — be aware type errors there are suppressed.

## Platform Notes

- **iOS** is the primary target. The app uses `react-native-video` v6 which maps to AVPlayer on iOS and ExoPlayer on Android.
- `bufferConfig.cacheSizeMB: 200` is set on video sources for disk caching (ExoPlayer on Android; iOS uses NSURLCache defaults).
- Xcode build environment: Node path is configured in `ios/.xcode.env.local` (nvm sourcing).

## use Chinese output
