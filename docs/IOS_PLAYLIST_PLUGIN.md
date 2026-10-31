# iOS 原生拼接播放列表：PlaylistComposerPlugin

把「多段 MP4 虚拟拼接成一条连续时间轴」这件事从 RN 侧搬到 iOS 原生侧。

**职责边界**：原生只负责播，交互 UI（进度条、全屏、按钮、完成度判定）仍然由 RN 自绘。

## 目录

1. [为什么要在原生做](#1-为什么要在原生做)
2. [原理](#2-原理)
3. [传参协议](#3-传参协议)
4. [代码](#4-代码) — Swift 插件 / AppDelegate / RN hook / App.tsx
5. [怎么把 Swift 插件加进工程](#5-怎么把-swift-插件加进工程)
6. [RN 侧怎么用](#6-rn-侧怎么用)
7. [会不会影响原来的播放器](#7-会不会影响原来的播放器)
8. [编译 / 安装 / 日志（Xcode 27 命令行路线）](#8-编译--安装--日志xcode-27-命令行路线)
9. [已知问题与后续](#9-已知问题与后续) — 含[两个编译坑](#9-已知问题与后续)、[iOS 版本兼容](#9-已知问题与后续)
10. [回退](#10-回退)

---

## 1. 为什么要在原生做

RN 侧原方案（`useVideoSequencePlayer` + `useVirtualTimeline`）的代价：

- 两个 `<Video>` 实例（一个播、一个预加载），靠 `opacity` / `zIndex` 切换
- 进度要自己把「片段序号 + 片段内时间」换算成虚拟时间
- 时长要靠隐藏 `<Video>` 逐个探测
- seek 要自己算落在哪个片段的哪一秒
- 观看完成度要用 `watchedSecondsRef` 累加并排除跳变

原生合成之后，AVPlayer 眼里只有 **1 个 item**：

| | RN 虚拟拼接 | 原生 composition |
|---|---|---|
| `onLoad.duration` | 需要自己累加 | 直接是总时长 |
| `onProgress.currentTime` | 片段内时间，需换算 | 全局时间 |
| `seek(t)` | 需反解片段 + 局部时间 | 直接全局 seek |
| 往回拖 | 需定位到历史片段 | 天然支持 |

考虑过 `AVQueuePlayer`，但它不适合这个场景：播完的 item 会出队（无法回拖，得重建队列）、`currentTime` / `duration` 只覆盖当前 item。所以选了 `AVMutableComposition`。

---

## 2. 原理

react-native-video 6.19.2 自带插件钩子，**不用 fork 库、不用写 bridge 模块**：

```
node_modules/react-native-video/ios/Video/RNVAVPlayerPlugin.swift:47
  open func overridePlayerAsset(source:asset:) async -> OverridePlayerAssetResult?

ios/Video/ReactNativeVideoManager.swift:39
  public func registerPlugin(plugin: RNVPlugin)

ios/Video/RCTVideo.swift:542-545
  返回 .full 时直接 AVPlayerItem(asset:)，跳过默认的 playerItemPrepareText
```

插件在原生侧把 `AVURLAsset` 换成 `AVMutableComposition`，JS 完全不感知。

**为什么不需要 bridge 模块**：播放列表藏在 URL 的 fragment 里传下去，插件从 `asset.url.absoluteString` 反解。这样既不用 `RCT_EXPORT_MODULE`，也不用 `NativeModules`——JS 侧唯一的变化只是 `source.uri` 变长了一点。

> 关键细节：`VideoSource` 的成员没有标 `public`，跨 module **读不到 `source.uri`**。所以从 AVFoundation 的 `AVURLAsset.url` 拿同样的字符串。

---

## 3. 传参协议

```
{第一个视频的真实 URL}#playlist={encodeURIComponent(url1)},{encodeURIComponent(url2)},...
```

用项目里 `App.tsx` 的三个测试片举例（实际是一整行）：

```
https://bdcloud-player-new.cdn.bcebos.com/testvideo/mp4/360video/ThaiKongfu.mp4#playlist=https%3A%2F%2Fbdcloud-player-new.cdn.bcebos.com%2Ftestvideo%2Fmp4%2F360video%2FThaiKongfu.mp4,https%3A%2F%2Fmedia.w3.org%2F2010%2F05%2Fsintel%2Ftrailer.mp4,https%3A%2F%2Fsf1-cdn-tos.huoshanstatic.com%2Fobj%2Fmedia-fe%2Fxgplayer_doc_video%2Fmp4%2Fxgplayer-demo-360p.mp4
```

三条约束：

1. **fragment 前面的主 URL 必须是真实可播的**。`RCTVideoUtils.swift:366` 的 `prepareAsset` 要求 uri 能过 `URL(string:)`，否则直接报错、插件没机会执行。所以拿 `urls[0]` 打底。
2. **fragment 后面全部 `encodeURIComponent`**。用逗号分隔，编码后原始 URL 里的 `/`、`:` 不会跟分隔符打架；Swift 侧 `removingPercentEncoding` 还原。
3. **主 URL 全程不会被真正请求**。它被做成 `AVURLAsset` 后立刻被插件替换，所以 fragment 不会污染任何网络请求，也不影响 `AppDelegate.mm` 里那个 `NSURLCache`。

---

## 4. 代码

### 4.1 `ios/StitchRNPOCModern/PlaylistComposerPlugin.swift`（新增）

> **版本说明**：下面这份是**当前实际落地的版本**（含调试日志 + 两个编译修复）。
> 与初版相比有三处不同，都是 Xcode 27 下踩出来的，详见 [第 9 节](#9-已知问题与后续)：
> `import os` + `Logger` 取代 `NSLog`；`cache` 前加 `Self.`；`insertTimeRange` 的 `try?` 改成 `do/catch`。

```swift
//
//  职责边界：原生只负责"把多段 MP4 合成一条连续时间轴并播出来"，
//  进度条 / 全屏 / 按钮 / 完成度判定仍然由 RN 自绘。
//

import AVFoundation
import Foundation
import os
import react_native_video

@objc public final class PlaylistComposerPlugin: RNVAVPlayerPlugin {
    private static let marker = "#playlist="

    @objc public static let shared = PlaylistComposerPlugin()

    /// AppDelegate 启动时调用一次即可
    @objc public static func register() {
        ReactNativeVideoManager.shared.registerPlugin(plugin: shared)
    }

    // MARK: - 日志
    //
    // 两个坑都在这里，改的时候别踩回去：
    // 1) 不能用 NSLog —— Xcode 27 下报
    //    "'NSLog' is unavailable: Variadic function is unavailable"（C 可变参数函数不可桥接）。
    // 2) 首选 os.Logger，但它是 **iOS 15.0+ 的 API**。真机存在 iOS 14 及以下，
    //    直接调用会启动崩溃，所以必须做 #available 保护，低版本回退到 print()。
    //    （print 走 stdout，不一定能在 `log stream` 里看到，但它全版本可用、不会崩 ——
    //     拿"日志看不到"换"不崩溃"是正确的取舍。）

    private static func log(_ message: String) {
        if #available(iOS 15.0, *) {
            // 局部创建而非 static let：避免 Logger 这个 iOS 15+ 类型出现在静态属性上
            Logger(subsystem: "com.stitchrnpocmodern", category: "Playlist")
                .log("\(message, privacy: .public)")
        } else {
            print(message)
        }
    }

    // MARK: - 插件入口

    public override func overridePlayerAsset(
        source: VideoSource,
        asset: AVAsset
    ) async -> OverridePlayerAssetResult? {
        Self.log("[Playlist] overridePlayerAsset called")

        guard let urlAsset = asset as? AVURLAsset else {
            Self.log("[Playlist] FAIL asset 不是 AVURLAsset: \(type(of: asset))")
            return nil
        }

        let raw = urlAsset.url.absoluteString
        Self.log("[Playlist] raw uri = \(raw)")

        guard let range = raw.range(of: Self.marker) else {
            Self.log("[Playlist] FAIL uri 里没有 #playlist= 标记")
            return nil
        }

        let urls = raw[range.upperBound...]
            .split(separator: ",")
            .compactMap { part -> URL? in
                let decoded = String(part).removingPercentEncoding ?? String(part)
                return URL(string: decoded)
            }
        Self.log("[Playlist] 解析出 \(urls.count) 个 url")

        guard urls.count > 1 else { return nil }

        // 进/出全屏时 <Video> 会 remount，合成结果按播放列表缓存，避免重新 await 一遍
        let cacheKey = urls.map { $0.absoluteString }.joined(separator: ",")
        if let cached = await Self.cache.asset(for: cacheKey) {
            Self.log("[Playlist] 命中缓存，总时长 = \(Self.fmt(cached.duration.seconds)) 秒")
            return OverridePlayerAssetResult(type: .full, asset: cached)
        }

        guard let composition = await Self.composition(of: urls) else {
            Self.log("[Playlist] FAIL 合成失败（所有片段时长/轨道都拿不到）")
            return nil
        }
        await Self.cache.store(composition, for: cacheKey)
        Self.log("[Playlist] OK 合成完成，总时长 = \(Self.fmt(composition.duration.seconds)) 秒")

        // .full 会让 RCTVideo 直接 AVPlayerItem(asset:)，跳过默认的 prepare 流程
        return OverridePlayerAssetResult(type: .full, asset: composition)
    }

    // MARK: - Cache

    private static let cache = CompositionCache()

    private actor CompositionCache {
        private var storage: [String: AVAsset] = [:]

        func asset(for key: String) -> AVAsset? { storage[key] }

        func store(_ asset: AVAsset, for key: String) { storage[key] = asset }
    }

    // MARK: - Composition

    private static func composition(of urls: [URL]) async -> AVAsset? {
        let composition = AVMutableComposition()

        guard
            let videoTrack = composition.addMutableTrack(
                withMediaType: .video,
                preferredTrackID: kCMPersistentTrackID_Invalid
            ),
            let audioTrack = composition.addMutableTrack(
                withMediaType: .audio,
                preferredTrackID: kCMPersistentTrackID_Invalid
            )
        else {
            Self.log("[Playlist] FAIL 无法创建 composition 轨道")
            return nil
        }

        var cursor = CMTime.zero

        for url in urls {
            let asset = AVURLAsset(url: url)
            let duration = await Self.duration(of: asset)
            guard duration.isValid, duration.seconds > 0 else {
                Self.log("[Playlist] 片段 \(url.lastPathComponent) 时长无效，跳过")
                continue
            }

            let range = CMTimeRange(start: .zero, duration: duration)
            let videoTracks = await Self.tracks(of: asset, mediaType: .video)
            let audioTracks = await Self.tracks(of: asset, mediaType: .audio)
            Self.log(
                "[Playlist] 片段 \(url.lastPathComponent) 时长=\(Self.fmt(duration.seconds))s "
                    + "video轨=\(videoTracks.count) audio轨=\(audioTracks.count)"
            )

            // 用 do/catch 而不是 try?：插入失败必须能看见，否则会静默少一段
            if let track = videoTracks.first {
                do {
                    try videoTrack.insertTimeRange(range, of: track, at: cursor)
                } catch {
                    Self.log("[Playlist] 片段 \(url.lastPathComponent) 视频轨插入失败: \(error.localizedDescription)")
                }
            }
            if let track = audioTracks.first {
                do {
                    try audioTrack.insertTimeRange(range, of: track, at: cursor)
                } catch {
                    Self.log("[Playlist] 片段 \(url.lastPathComponent) 音频轨插入失败: \(error.localizedDescription)")
                }
            }

            cursor = cursor + duration
        }

        Self.log("[Playlist] 合成结束 cursor=\(Self.fmt(cursor.seconds))s")
        guard cursor.seconds > 0 else { return nil }
        return composition
    }

    private static func fmt(_ seconds: Double) -> String {
        String(format: "%.3f", seconds)
    }

    // MARK: - 异步加载（不用 iOS 15 的 load()，保持对低版本系统的兼容）

    private static func duration(of asset: AVURLAsset) async -> CMTime {
        await withCheckedContinuation { continuation in
            asset.loadValuesAsynchronously(forKeys: ["duration"]) {
                continuation.resume(returning: asset.duration)
            }
        }
    }

    private static func tracks(
        of asset: AVURLAsset,
        mediaType: AVMediaType
    ) async -> [AVAssetTrack] {
        await withCheckedContinuation { continuation in
            asset.loadValuesAsynchronously(forKeys: ["tracks"]) {
                continuation.resume(returning: asset.tracks(withMediaType: mediaType))
            }
        }
    }
}
```

### 4.2 `ios/StitchRNPOCModern/AppDelegate.mm`（修改）

在 `didFinishLaunchingWithOptions` 里、`NSURLCache` 之后、`return [super ...]` 之前：

```objc
  // 注册原生播放列表合成插件：iOS 侧把多段 MP4 合成一条连续时间轴，
  // 交互 UI 仍然由 RN 自绘。走 NSClassFromString 是为了避免 .mm 引入 Swift 头文件。
  Class playlistPlugin = NSClassFromString(@"StitchRNPOCModern.PlaylistComposerPlugin");
  SEL registerSelector = NSSelectorFromString(@"register");

  // 下面三行 NSLog 是调试用的，排查完可以删（OC 里的 NSLog 不受 Swift 那条限制影响）
  NSLog(@"[Playlist] 注册开始 class=%@", playlistPlugin ? @"找到了" : @"❌ 没找到");
  if (playlistPlugin && [playlistPlugin respondsToSelector:registerSelector]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    [playlistPlugin performSelector:registerSelector];
    NSLog(@"[Playlist] ✅ 注册成功");
#pragma clang diagnostic pop
  } else {
    NSLog(@"[Playlist] ❌ 注册失败 class=%@ selectorOK=%@",
          playlistPlugin ? @"找到了" : @"没找到",
          playlistPlugin ? ([playlistPlugin respondsToSelector:registerSelector] ? @"YES" : @"NO") : @"n/a");
  }
```

用 `NSClassFromString` 而不是 `#import "StitchRNPOCModern-Swift.h"`：这样 `.mm` 不需要任何 Swift 头文件依赖，也不需要 bridging header。

> 注意这里是 **OC 文件，可以放心用 `NSLog`**。Swift 文件里不行，见 [9.6 两个编译坑](#9-已知问题与后续)。

### 4.3 `hooks/usePlaylistPlayback.ts`（新增）

```ts
import {useCallback, useMemo, useRef, useState} from 'react';

const PLAYLIST_MARKER = '#playlist=';

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
```

### 4.4 `App.tsx` 接线（关键改动）

```diff
-import {useVideoSequenceTimelinePlayer} from './hooks/useVideoSequenceTimelinePlayer';
+import {usePlaylistPlayback} from './hooks/usePlaylistPlayback';

-  const {
-    preloadNode, videoSlots, activePlayer,
-    playing, setPlaying, playingRef, playedSecondsRef, sequenceEndCount,
-    isLoading, isBuffering,
-    currentIndex: mp4Index, currentTimeRef,
-    ready: timelineReady, virtualTime, totalSafe, setIsSeeking,
-    seekVirtual, queueResumeForCurrentClip,
-  } = useVideoSequenceTimelinePlayer({urls: mp4Urls});
-
-  const canCompleteMission =
-    sequenceEndCount > 0 || (playedSecondsRef.current ?? 0) >= totalSafe * 0.98;
+  const {
+    videoRef, source: playlistSource,
+    playing, setPlaying, playingRef, hasCompletedPlayback,
+    isLoading, isBuffering: playlistBuffering,
+    duration, currentTime,
+    ready: timelineReady, seek, snapshotForRemount,
+    onLoad: onPlaylistLoad, onProgress: onPlaylistProgress, onEnd: onPlaylistEnd,
+  } = usePlaylistPlayback(mp4Urls);
+
+  const canCompleteMission = hasCompletedPlayback;

+  const {preloadNode} // 已删除，不再需要隐藏探测用的 <Video>
```

`renderVideo` 从双 slot 改成单播放器：

```tsx
const renderVideo = (extraStyle?: any) => (
  <View style={{flex: 1}}>
    <Video
      ref={videoRef}
      source={playlistSource}
      paused={!playing}
      muted={muted}
      style={[
        StyleSheet.absoluteFill,
        extraStyle,
        {opacity: isLoading ? 0 : 1},
      ]}
      resizeMode="contain"
      onLoad={onPlaylistLoad}
      onProgress={onPlaylistProgress}
      onEnd={onPlaylistEnd}
      onBuffer={onVideoBuffer}
      onError={onVideoError}
      controls={false}
      progressUpdateInterval={250}
    />
    {showOverlay && (/* loading 遮罩，保持不变 */)}
  </View>
);
```

其余替换：`seekVirtual(t)` → `seek(t)`；scrubber 的 `total` 用 `duration`、`baseTime` 用 `currentTime`；`uiTotal` 用 `duration`；`toggleFullscreen` 里改用 `snapshotForRemount()`。

---

## 5. 怎么把 Swift 插件加进工程

### 5.1 不用 Xcode（命令行）

直接在 `ios/StitchRNPOCModern.xcodeproj/project.pbxproj` 里加三处（UUID 自取，保证唯一）：

1. `PBXBuildFile` 段加一条：
```
A1B2C3D51A68108700A75B9B /* PlaylistComposerPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = A1B2C3D41A68108700A75B9B /* PlaylistComposerPlugin.swift */; };
```
2. `PBXFileReference` 段加一条：
```
A1B2C3D41A68108700A75B9B /* PlaylistComposerPlugin.swift */ = {isa = PBXFileReference; fileEncoding = 4; lastKnownFileType = sourcecode.swift; name = PlaylistComposerPlugin.swift; path = StitchRNPOCModern/PlaylistComposerPlugin.swift; sourceTree = "<group>"; };
```
3. app target 的 `PBXGroup`（`name = StitchRNPOCModern`）children 加 `A1B2C3D41A68108700A75B9B`，app target 的 `PBXSourcesBuildPhase` files 加 `A1B2C3D51A68108700A75B9B`。

验证（不用开 Xcode）：

```bash
cd ios/StitchRNPOCModern.xcodeproj
plutil -lint project.pbxproj
plutil -convert xml1 -o /tmp/pbx.xml project.pbxproj && python3 -c "
import plistlib
d=plistlib.load(open('/tmp/pbx.xml','rb')); o=d['objects']
for k,v in o.items():
    if v.get('isa')=='PBXSourcesBuildPhase':
        for f in v['files']:
            ref=o[f].get('fileRef'); print(k, o[ref].get('path'))
"
```

### 5.2 用 Xcode

把 `PlaylistComposerPlugin.swift` 拖进 `StitchRNPOCModern` group，勾选 target membership。弹 "Create Bridging Header" 时**可以选 Create 也可以不建**——这个插件不引用任何 OC，不需要 bridging header。

`SWIFT_VERSION = 5.0` 工程里本来就有（Debug / Release 都有），不用改。

---

## 6. RN 侧怎么用

最小用法：

```tsx
import Video from 'react-native-video';
import {usePlaylistPlayback} from './hooks/usePlaylistPlayback';

const CLIPS = [
  'https://.../clip1.mp4',
  'https://.../clip2.mp4',
  'https://.../clip3.mp4',
];

function Player() {
  const {videoRef, source, playing, setPlaying, duration, currentTime,
         seek, onLoad, onProgress, onEnd, hasCompletedPlayback} =
    usePlaylistPlayback(CLIPS);

  return (
    <>
      <Video
        ref={videoRef}
        source={source}
        paused={!playing}
        onLoad={onLoad}
        onProgress={onProgress}
        onEnd={onEnd}
        controls={false}
      />
      {/* duration = 总时长，currentTime = 全局时间，seek(t) = 全局 seek */}
      <Button title={hasCompletedPlayback ? 'Complete' : 'Watch to complete'} />
    </>
  );
}
```

要点：

- `source` 由 hook 生成，**不要自己拼 uri**（容易漏掉 `encodeURIComponent`）
- `controls={false}` 保持——UI 仍是 RN 自绘
- 全屏用 `<Modal>` 时，`<Video>` 会 remount：进出全屏前调 `snapshotForRemount()`，hook 会在 `onLoad` 里自动补 seek 回去
- 合成有 1–2 秒耗时（要 await 每个 asset 的时长和轨道），用 `isLoading` 出 loading 态
- 进/出全屏第二次起走缓存，不会重复合成

---

## 7. 会不会影响原来的播放器

不会。插件是全局注册的，但有两道守卫：

```swift
guard let range = raw.range(of: Self.marker) else { return nil }   // 没有 #playlist=
guard urls.count > 1 else { return nil }                            // 只有一个 url
```

返回 `nil` 时：`ReactNativeVideoManager.swift:71-80` 继续问下一个插件，全 nil 则整体 nil → `RCTVideo.swift:542-550` 走默认 `playerItemPrepareText`，**与注册插件前完全一致**。

| 谁 | uri | 结果 |
|---|---|---|
| 主播放器 | 带 `#playlist=` | 命中，合成 |
| `useVideoDurations.tsx` 的隐藏探测 Video | 裸 url | 不受影响 |
| 以后新加的任何 `<Video>` | 裸 url | 不受影响 |

旧的 `useVideoSequencePlayer` / `useVirtualTimeline` / `useVideoDurations` **保留未删**，它们用的是裸 url，所以**新旧代码可以共存**，把 `App.tsx` 的 import 换回去就能退回旧逻辑。

---

## 8. 编译 / 安装 / 日志（Xcode 27 命令行路线）

### 8.1 先修部署目标（一次性）

Xcode 27 的 SDK **最低只支持 iOS 15.0**，而工程原本写的是 13.4（RN 0.74 的 `min_ios_version_supported`），编译会直接拒：

```
IPHONEOS_DEPLOYMENT_TARGET is set to 13.4,
but the range of supported deployment target versions is 15.0 to 27.0.x
```

要改三处：

```ruby
# ios/Podfile
platform :ios, '15.0'                       # 原来是 min_ios_version_supported（RN 0.74 = 13.4）
```

```ruby
# ios/Podfile 的 post_install 里，必须在 react_native_post_install 之后
# —— RN 会把所有 pod target 写回 13.4，所以要在它后面覆盖
installer.pods_project.targets.each do |target|
  target.build_configurations.each do |config|
    config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
  end
end
```

```
ios/StitchRNPOCModern.xcodeproj/project.pbxproj
  IPHONEOS_DEPLOYMENT_TARGET = 13.4;  →  15.0;     # 共 4 处
```

改完**必须重跑 `pod install`**（Pods 的部署目标才会重新生成，Pods.xcodeproj 里 122 个 target 都会变）。

> 想同时兼容 iOS 13.4/14，见 [9.7 版本兼容](#9-已知问题与后续)。

### 8.2 为什么不能用 `npx react-native run-ios`

它会先去 `open /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app`，而 **Xcode 27 里这个独立应用已经不存在了**（全盘 `find` 确认）。CLI 在 `runOnSimulator.js:45` 无条件执行这一步，且它在编译**之前**，所以必然报：

```
The file /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app does not exist.
```

改用 `xcodebuild` 编译 + `simctl` 安装启动，全程命令行，不碰 Xcode GUI：

```bash
cd /Users/lhy/Desktop/code/FEDemo/video-rn/ios && \
UDID=<你的模拟器 UDID，见下> && \
xcodebuild -workspace StitchRNPOCModern.xcworkspace -scheme StitchRNPOCModern \
  -configuration Debug -sdk iphonesimulator -destination "id=$UDID" \
  -derivedDataPath build/DerivedData build > /tmp/rnbuild.log 2>&1 && \
APP=$(find /Users/lhy/Desktop/code/FEDemo/video-rn/ios/build/DerivedData -name "StitchRNPOCModern.app" -type d | head -1) && \
echo "APP=$APP" && \
xcrun simctl install $UDID "$APP" && \
xcrun simctl launch $UDID $(defaults read "$APP/Info" CFBundleIdentifier) ; \
echo "--- build 结果 ---" ; grep -E "error:|BUILD " /tmp/rnbuild.log | head -20
```

UDID 这么拿（设备要先 Boot）：

```bash
xcrun simctl list devices | grep Booted
# 或 xcrun simctl boot "iPhone 17 Pro"
```

三个细节：

- **`-derivedDataPath build/DerivedData` 必须带**。默认路径在 `~/Library/Developer/Xcode/DerivedData/`，会被 macOS TCC 拦（`Operation not permitted`）；放项目内 `ios/build/` 就没事，且已被 `.gitignore` 忽略。
- **别把 `grep` 放进 `&&` 链**。`xcodebuild ... | grep ... && 后续命令` 判断的是 **grep** 的退出码，grep 无匹配即返回 1 会静默断链 —— 结果就是编译失败时还拿旧的空壳 `.app` 去装，报 `StitchRNPOCModern.app is missing its bundle executable`。上面用 `> /tmp/rnbuild.log 2>&1` 落盘，日志单独 grep。
- **只改 JS 不用重编**：模拟器里 `Cmd+R`，或 `curl "http://localhost:8081/reload"`。改了 Swift / 原生配置才需要重跑编译。

### 8.3 看日志

```bash
# Swift 侧（Logger 有 subsystem，按它过滤最准）
xcrun simctl spawn <UDID> log stream --level debug \
  --predicate 'subsystem == "com.stitchrnpocmodern"' | grep Playlist

# OC 侧（AppDelegate 的 NSLog 没有 subsystem，按进程捞）
xcrun simctl spawn <UDID> log stream --level debug \
  --predicate 'process == "StitchRNPOCModern"' | grep -E "Playlist|SOURCE"
```

日志对号入座：

| 现象 | 结论 | 怎么办 |
|---|---|---|
| 一条 `[Playlist]` 都没有 | Swift 没编进包 | 检查 target 的 Compile Sources；确认重编过原生 |
| `❌ 没找到` | 类名不对 | 把 `@objc` 改成显式 `@objc(PlaylistComposerPlugin)`，注册时去掉模块前缀 |
| `❌ 注册失败 ... selectorOK=NO` | `+register` 没暴露给 OC | 确认 `@objc public static func register()` |
| `✅ 注册成功` + `OK 合成完成，总时长 = xx` | 成功 | xx 应等于三段之和 |
| `✅ 注册成功` 但 `FAIL uri 里没有 #playlist=` | 原生拿到的 uri 与 JS 不一致 | 看 `raw uri = ...` 那行 |
| `片段 xxx 视频轨插入失败` | 编码不兼容 | 需要 `AVMutableVideoComposition` 统一 renderSize，见 [9.2](#2-分辨率归一没做) |

JS 侧还有一条埋点（`App.tsx` 里新增的 useEffect），不用重编、reload 即可看到：

```
SOURCE uri=https://...ThaiKongfu.mp4#playlist=https%3A%2F%2F...
SOURCE hasMarker=true playlistLen=278
```

`hasMarker=false` 说明 JS 没拼上，去查 `hooks/usePlaylistPlayback.ts` 的 `source`。

---

## 9. 已知问题与后续

1. ✅ **已解决**：`import react_native_video` 这个 module 名**确认可用**，不用改。

   查证方式（`pod install` 之后）：

   ```bash
   find ios/Pods -iname "*react-native-video*.modulemap"
   # → ios/Pods/Target Support Files/react-native-video/react-native-video.modulemap
   head -1 "ios/Pods/Target Support Files/react-native-video/react-native-video.modulemap"
   # → module react_native_video {
   ```

   > **踩过的坑**：文件**名**是连字符 `react-native-video.modulemap`，但 module **声明**是下划线 `react_native_video`。早先按 `*react_native_video*.modulemap` 去 `find`，必然空输出。
   > 另外静态库模式下 `PRODUCT_MODULE_NAME` 不在 pod 的 xcconfig 里（由 CocoaPods 写进 `Pods.xcodeproj`），grep xcconfig 查不到属正常。

   顺带核实的几项（都已确认可行）：
   - 静态库模式（Podfile 未开 `use_frameworks`），app target 的 xcconfig 里 `SWIFT_INCLUDE_PATHS` 含 react-native-video 的 swiftmodule 目录
   - `RNVPlugin` / `RNVAVPlayerPlugin` 是 `open`，`overridePlayerAsset` 是 `open`，`OverridePlayerAssetResult` 是 `public` + `public init` → 跨 module 子类化与 override 全部合法
   - `VideoSource` 是 `public struct` 但成员全为 internal → 跨 module 读不到 `source.uri`，所以从 `AVURLAsset.url` 反解是必需写法

2. **分辨率归一没做**。三个测试片尺寸不同，切段时画幅可能跳变。需要 `AVMutableVideoComposition` 统一 `renderSize`，但插件只能返回 asset、拿不到 `AVPlayerItem`，得在 `onInstanceCreated(id:player:)` 里存下 player、KVO `currentItem` 后再设 `item.videoComposition`。

3. **返回 `.full` 会跳过字幕挂载**。`RCTVideo.swift:543` 直接 `AVPlayerItem(asset:)`，跳过了 `playerItemPrepareText`，所以 `textTracks` 不会自动挂。现在三个片没字幕无所谓，将来要字幕得在插件里自己 `add(AVMediaSelectionGroup)`。`cropStart` / `cropEnd` 和 DRM 流程不受影响（分别在 `setupPlayer` 和插件调用之前）。

4. **`bufferConfig.cacheSizeMB` 对 composition 无效**，iOS 侧靠 `AppDelegate.mm` 里的 `NSURLCache`（内存 50MB + 磁盘 200MB）兜底。

5. **jest 里那个 App 测试没更新**。它渲染 `App.tsx`，而 `videoSlots` 已经不存在了，要跑的话得更新 mock。

6. **两个编译坑（Xcode 27 / Swift 6）**，写代码时别踩回去：

   - **`NSLog` 在 Swift 里不可用**
     ```
     error: 'NSLog' is unavailable: Variadic function is unavailable
     ```
     Xcode 27 的 Swift 编译器拒绝桥接 C 可变参数函数。改用 `import os` + `Logger`，见 4.1 的 `log()`。（OC 文件里的 `NSLog` 不受影响。）

   - **`static` 成员在实例方法里必须加 `Self.`**
     ```
     error: static member 'cache' cannot be used on instance of type 'PlaylistComposerPlugin'
     ```
     `await cache.store(...)` → `await Self.cache.store(...)`

7. **iOS 版本兼容：能低到多少**

   | 依赖 | 最低 iOS | 出处 |
   |---|---|---|
   | React Native 0.74 | **13.4** | `node_modules/react-native/scripts/cocoapods/helpers.rb:38-42` |
   | react-native-video 6.19.2 | 13.0 | `react-native-video.podspec:19` `s.platforms = { :ios => "13.0" }` |
   | 本项目理论下限 | **13.4**（取最大） | — |

   但 **Xcode 27 的 SDK 下限是 15.0**，这台机器上编不出更低的包 —— 产出的 ipa `MinimumOSVersion` 就是 15.0，iOS 14 设备装的时候会被系统拒绝。这是工具链限制，不是代码问题。

   要支持 13.4 / 14，得换 Xcode：

   ```bash
   # 1. 装 Xcode 15.x 或 16.x（developer.apple.com/download/all，需 Apple 账号）
   #    装成 /Applications/Xcode_16.app，别覆盖现有的 Xcode.app
   sudo xcode-select -s /Applications/Xcode_16.app/Contents/Developer
   xcodebuild -version

   # 2. 部署目标改回 13.4：Podfile 的 platform、post_install 覆盖、pbxproj 4 处
   # 3. 重跑 pod install
   cd ios && rm -rf Pods Podfile.lock build && pod install
   ```

   **推荐做法**：让 Podfile 自己按 Xcode 版本选，这样切换 Xcode 不用手改配置：

   ```ruby
   def deployment_target
     v = `xcodebuild -version`[/Xcode (\d+)/, 1].to_i
     v >= 26 ? '15.0' : min_ios_version_supported   # Xcode 26+ 的 SDK 下限是 15.0
   end
   platform :ios, deployment_target
   ```
   `post_install` 里那处覆盖也用同一个 `deployment_target`。

   **代码层面已经做好的兼容**：`Logger` 是 iOS 15+ API，真机存在 iOS 14 及以下，裸调会启动崩溃，所以 `log()` 里加了 `#available(iOS 15.0, *)`，低版本回退 `print()`（看不到日志但不崩）。

   插件里其他 API 都安全：`withCheckedContinuation`（Swift 并发）back-deploy 到 iOS 13；`loadValuesAsynchronously` / `AVMutableComposition` / `AVURLAsset` 都是老 API，全版本可用。
   > 只有降到 **iOS 12** 才会出问题（Swift `async/await` 需要 iOS 13+ 运行时，那时 `overridePlayerAsset` 的 async 版本用不了）。但 RN 0.74 本身要求 13.4，这条不会发生。

---

## 10. 回退

把 `App.tsx` 的这两行换回去即可，插件留着也不会干扰（旧 source 是裸 url）：

```diff
-import {usePlaylistPlayback} from './hooks/usePlaylistPlayback';
+import {useVideoSequenceTimelinePlayer} from './hooks/useVideoSequenceTimelinePlayer';
```

要彻底移除原生侧：删 `ios/StitchRNPOCModern/PlaylistComposerPlugin.swift`、`AppDelegate.mm` 里的注册块、pbxproj 里那三处引用。
