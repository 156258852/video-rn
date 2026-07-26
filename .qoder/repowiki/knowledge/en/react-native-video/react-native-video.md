---
kind: external_dependency
name: react-native-video
slug: react-native-video
category: external_dependency
category_hints:
    - sdk_real_api
scope:
    - '**'
source_files:
    - package.json
    - App.tsx
    - hooks/useVideoDurations.tsx
    - hooks/useVideoSequencePlayer.ts
---

### Core video playback engine
- Primary dependency for video playback in React Native (iOS/Android)
- Maps to AVPlayer on iOS and ExoPlayer on Android
- Used via `<Video>` component with `source={{uri}}` pattern
- Key APIs: `onLoad`, `onProgress`, `onEnd`, `onBuffer`, `onError` events
- Platform-specific configuration: `viewType={Platform.OS === 'android' ? ViewType.TEXTURE : undefined}`
- Buffer configuration: `bufferConfig.cacheSizeMB: 200` for disk caching
- Used in dual-player strategy with two simultaneous instances for seamless clip transitions
- Verify exact API/params against official react-native-video documentation