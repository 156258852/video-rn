# 原生拼接播放列表：PlaylistComposerPlugin（iOS + Android 双端）

把「多段 MP4 虚拟拼接成一条连续时间轴」这件事从 RN 侧搬到原生侧。**iOS 用 `AVMutableComposition`，Android 用 `ConcatenatingMediaSource2`**。

**职责边界**：原生只负责播，交互 UI（进度条、全屏、按钮、完成度判定）仍然由 RN 自绘。

> **双端一套 JS 代码**：JS 侧完全不区分平台——同一个 `hooks/usePlaylistPlayback.ts`、同一份 `App.tsx`、
> 同一条 `${urls[0]}#playlist=${encodedUrls}` 传参协议。差异全部收在原生插件里
> （`ios/StitchRNPOCModern/PlaylistComposerPlugin.swift` / `android/.../video/PlaylistComposerPlugin.kt`），
> 两端各自实现各自的 plugin 接口，对 RN 暴露的行为一致。

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

### Android 部分

11. [Android 原理与钩子位置](#11-android-原理与钩子位置)
12. [Android 插件完整代码](#12-android-插件完整代码)
13. [Android 怎么接入](#13-android-怎么接入)
14. [Android 编译配置（compileSdk / media3）](#14-android-编译配置compilesdk--media3)
15. [Android 踩过的坑](#15-android-踩过的坑)
16. [双端差异对照](#16-双端差异对照)

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

要彻底移除原生侧：

- iOS：删 `ios/StitchRNPOCModern/PlaylistComposerPlugin.swift`、`AppDelegate.mm` 里的注册块、pbxproj 里那三处引用。
- Android：删 `android/app/src/main/java/com/stitchrnpocmodern/video/PlaylistComposerPlugin.kt`、
  `MainApplication.kt` 里的 `registerPlugin(...)` 一行，以及 `app/build.gradle` 里显式加的 media3 依赖
  （`android/build.gradle` 的 `ext.media3Version` 可以留着，无副作用）。

> 旧的双播放器方案（`hooks/useVideoSequencePlayer.ts`、`useVideoSequenceTimelinePlayer.ts`、
> `useVirtualTimeline.ts`、`useVideoDurations.tsx`）**保留未删**，随时可以切回去对比或回退。

---
---

# Android 部分

## 11. Android 原理与钩子位置

react-native-video 6.19.2 在 Android 侧同样自带插件钩子，**不用 fork 库、不用写 bridge 模块**：

```
node_modules/react-native-video/android/src/main/java/com/brentvatne/exoplayer/RNVExoplayerPlugin.kt:49
  fun overrideMediaSourceFactory(source, mediaSourceFactory, mediaDataSourceFactory): MediaSource.Factory?
        ↑ 返回非 null 就用你的 factory，null 走默认

node_modules/.../com/brentvatne/react/ReactNativeVideoManager.kt:56 / 103-111
  registerPlugin(plugin)  →  遍历插件问 overrideMediaSourceFactory

node_modules/.../com/brentvatne/exoplayer/ReactExoplayerView.java:1104-1130
  按 uri 推断 contentType，构造 ProgressiveMediaSource.Factory 等
  :1134  ReactNativeVideoManager.getInstance().overrideMediaSourceFactory(...)  ← 插件在这里被问
  :1152  mediaSourceFactory.createMediaSource(mediaItem)
```

**uri 带 fragment 会不会影响类型推断？不会。** Android 的 `Uri.parse()` 把 `#playlist=...` 解析成独立的 fragment，
`uri.getLastPathSegment()` 仍然是 `ThaiKongfu.mp4`，所以 `Util.inferContentType(...)`（`ReactExoplayerView.java:1012`）
照旧得到 `CONTENT_TYPE_OTHER` → `ProgressiveMediaSource.Factory`，正好能走到我们的 override。

**为什么用 `ConcatenatingMediaSource2`**：media3 里老的 `ConcatenatingMediaSource`（动态版）已移除；
`ConcatenatingMediaSource2` 会把多段合并成**单个 window 的单条 Timeline**，
和 iOS 的 `AVMutableComposition` 效果一致：`duration` 是总时长、`currentTime` 是全局时间、`seek(t)` 直接全局。

守卫逻辑与 iOS 完全一致：

| 条件 | 行为 |
|---|---|
| uri 里没有 `#playlist=` | 返回 `null`，react-native-video 走自己的默认路径 |
| 只有 1 段 | 返回 `null`（没必要拼） |
| ≥ 2 段 | 返回自定义 `PlaylistMediaSourceFactory` |

---

## 12. Android 插件完整代码

`android/app/src/main/java/com/stitchrnpocmodern/video/PlaylistComposerPlugin.kt`：

```kotlin
package com.stitchrnpocmodern.video

import android.media.MediaMetadataRetriever
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider
import androidx.media3.exoplayer.source.ConcatenatingMediaSource2
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import com.brentvatne.common.api.Source
import com.brentvatne.exoplayer.RNVExoplayerPlugin
import java.net.URLDecoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class PlaylistComposerPlugin : RNVExoplayerPlugin {

    companion object {
        private const val TAG = "PlaylistComposerPlugin"
        private const val MARKER = "#playlist="

        // 默认占位时长：还没探测到真实时长时先用它，prepare 完会被真实值替换
        private const val DEFAULT_PLACEHOLDER_MS = 1_000L

        // url -> 真实时长(ms)：后台探测一次后缓存，后续同 url 一上来就是完整总时长
        private val durationCache = ConcurrentHashMap<String, Long>()
        private val probeExecutor = Executors.newSingleThreadExecutor()

        private fun probeDurationAsync(url: String) {
            probeExecutor.execute {
                if (durationCache.containsKey(url)) return@execute
                val retriever = MediaMetadataRetriever()
                try {
                    retriever.setDataSource(url, emptyMap())
                    val durationMs = retriever
                        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                        ?.toLongOrNull()
                    if (durationMs != null && durationMs > 0) {
                        durationCache[url] = durationMs
                        Log.d(TAG, "probe duration ok: ${durationMs}ms $url")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "probe duration failed: $url ${e.message}")
                } finally {
                    retriever.release()
                }
            }
        }
    }

    override fun overrideMediaSourceFactory(
        source: Source,
        mediaSourceFactory: MediaSource.Factory,
        mediaDataSourceFactory: DataSource.Factory
    ): MediaSource.Factory? {
        val rawUri = source.uri?.toString()
        if (rawUri.isNullOrEmpty()) return null

        val markerIdx = rawUri.indexOf(MARKER)
        if (markerIdx < 0) {
            Log.d(TAG, "no playlist marker, use default factory")   // 普通视频：不干预
            return null
        }

        val playlistParam = rawUri.substring(markerIdx + MARKER.length)
        val urls = playlistParam
            .split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { URLDecoder.decode(it, "UTF-8") }

        if (urls.size <= 1) return null

        // 没缓存过的 url 后台探测一次，下次再播就能一上来拿到完整时长
        urls.forEach { url ->
            if (!durationCache.containsKey(url)) probeDurationAsync(url)
        }

        Log.d(TAG, "build concatenated source with ${urls.size} items")
        urls.forEachIndexed { i, u -> Log.d(TAG, "  [$i] $u") }

        return PlaylistMediaSourceFactory(urls, mediaSourceFactory)
    }

    override fun onInstanceCreated(id: String, player: ExoPlayer) {
        Log.d(TAG, "onInstanceCreated id=$id")
    }

    override fun onInstanceRemoved(id: String, player: ExoPlayer) {
        Log.d(TAG, "onInstanceRemoved id=$id")
    }

    /**
     * 子 source 复用 react-native-video 传下来的默认 factory 创建，
     * 这样缓存（RNVSimpleCache）、DRM、重试策略等配置都能继承下来。
     */
    private class PlaylistMediaSourceFactory(
        private val urls: List<String>,
        private val defaultFactory: MediaSource.Factory
    ) : MediaSource.Factory {

        override fun setDrmSessionManagerProvider(
            drmSessionManagerProvider: DrmSessionManagerProvider
        ): MediaSource.Factory {
            defaultFactory.setDrmSessionManagerProvider(drmSessionManagerProvider)
            return this
        }

        override fun setLoadErrorHandlingPolicy(
            loadErrorHandlingPolicy: LoadErrorHandlingPolicy
        ): MediaSource.Factory {
            defaultFactory.setLoadErrorHandlingPolicy(loadErrorHandlingPolicy)
            return this
        }

        override fun getSupportedTypes(): IntArray = intArrayOf(C.CONTENT_TYPE_OTHER)

        override fun createMediaSource(mediaItem: MediaItem): MediaSource {
            val builder = ConcatenatingMediaSource2.Builder()
            urls.forEach { url ->
                val child = defaultFactory.createMediaSource(MediaItem.fromUri(url))
                // media3 1.8 要求 ProgressiveMediaSource 必须给占位时长；
                // 有探测缓存就用真实时长，否则用默认值，prepare 完由真实值替换
                val placeholderMs = durationCache[url] ?: DEFAULT_PLACEHOLDER_MS
                builder.add(child, placeholderMs)
            }
            return builder.build()
        }
    }
}
```

---

## 13. Android 怎么接入

**① 注册插件** — `android/app/src/main/java/com/stitchrnpocmodern/MainApplication.kt`

```diff
 import android.app.Application
+import com.brentvatne.react.ReactNativeVideoManager
 import com.facebook.react.PackageList
 ...
 import com.facebook.soloader.SoLoader
+import com.stitchrnpocmodern.video.PlaylistComposerPlugin

   override fun onCreate() {
     super.onCreate()
     SoLoader.init(this, false)
     if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
       load()
     }
+
+    // 注册 video 插件：把带 #playlist= 的 uri 在原生侧拼成一条连续时间轴
+    ReactNativeVideoManager.getInstance().registerPlugin(PlaylistComposerPlugin())
   }
```

**② 编译 & 安装**

```bash
yarn android        # = react-native run-android（编译 + 装 + 启动）

# 或者手动（build 与安装分开，方便看日志）
cd android && ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.stitchrnpocmodern/.MainActivity
```

**③ 看日志**

```bash
adb logcat | grep -E "PlaylistComposerPlugin|ReactNativeJS"
```

正常情况下会看到：

```
PlaylistComposerPlugin: build concatenated source with 3 items
PlaylistComposerPlugin:   [0] https://.../ThaiKongfu.mp4
PlaylistComposerPlugin:   [1] https://media.w3.org/2010/05/sintel/trailer.mp4
PlaylistComposerPlugin:   [2] https://.../xgplayer-demo-360p.mp4
PlaylistComposerPlugin: probe duration ok: 25025ms https://.../ThaiKongfu.mp4
```

---

## 14. Android 编译配置（compileSdk / media3）

**① compileSdk 必须 ≥ 35**（media3 1.8.0 的硬性要求）

```
FAILURE: Build failed with an exception.
> Execution failed for task ':app:checkDebugAarMetadata'.
   > 13 issues were found when checking AAR metadata:
     Dependency 'androidx.media3:media3-exoplayer:1.8.0' requires libraries and applications that
     depend on it to compile against version 35 or later of the Android APIs.
     :app is currently compiled against android-34.
```

`android/build.gradle`：

```diff
-        compileSdkVersion = 34
+        compileSdkVersion = 35
         targetSdkVersion = 34        # 保持 34：运行时行为不变，只动编译期
```

`android/gradle.properties`（AGP 8.2.1 官方"建议"最高 34，用 35 只会有 warning，压掉）：

```diff
 android.useAndroidX=true
+android.suppressUnsupportedCompileSdk=35
```

> 模拟器是 **API 36** 也完全没关系：模拟器系统镜像版本和 compileSdk 是两回事，APK 向前兼容。
> 之前担心的"缺 android-34 platform"反而不存在了（35/36 都已安装）。

**② media3 依赖要显式加一次**

react-native-video 内部用的是 `implementation`，不会传递给我们 app 模块，插件里直接 import media3 类会找不到：

```diff
 # android/app/build.gradle
 dependencies {
     ...
+    // playlist 插件需要直接引用 media3 类；
+    // react-native-video 内部是 implementation 声明，不会传递过来
+    implementation "androidx.media3:media3-exoplayer:${rootProject.ext.media3Version}"
+    implementation "androidx.media3:media3-common:${rootProject.ext.media3Version}"
 }
```

```diff
 # android/build.gradle (ext)
+        // 与 node_modules/react-native-video/android/gradle.properties 里的
+        // RNVideo_media3Version 保持一致，避免出现两份 media3
+        media3Version = "1.8.0"
```

**③ .gitignore 别把 android/ 整个忽略**

之前 `.gitignore` 里有一行 `android/`，导致 27 个 android 源文件一个都没入库。现在是精确忽略：

```gitignore
android/.gradle/
android/build/
android/app/build/
android/local.properties   # 本机 SDK 路径，绝不能入库
android/.idea/
android/captures/
*.keystore
!debug.keystore            # RN 的 debug 签名是公开的，按惯例入库
```

---

## 15. Android 踩过的坑

**① `Progressive media source must define an initial placeholder duration`**

```
java.lang.IllegalStateException: Progressive media source must define an initial placeholder duration.
  at androidx.media3.common.util.Assertions.checkState(Assertions.java:100)
  at androidx.media3.exoplayer.source.ConcatenatingMediaSource2$Builder.add(...:206)
```

media3 1.8 的 `Builder.add(MediaSource)` 内部是 `add(source, C.TIME_UNSET)`，对 `ProgressiveMediaSource`
会直接抛异常。必须显式给占位时长：`builder.add(child, placeholderMs)`。
占位值只在"真实时长还没算出来"时用，prepare 完自动被真实值替换。

**② 控制条点不出来（不是 z-index 层级问题）**

现象：Android 全屏播放时点画面，控制条不出现（iOS 正常）。

根因：原生 `ExoPlayerView`（SurfaceView 容器）会消费触摸事件，父级 `Pressable` 的 `onPress` 根本收不到。

修法：在视频之上加一层透明点击层接管 tap（`App.tsx` 的 `renderVideo`）：

```tsx
{/* Android: 原生 ExoPlayerView 会消费触摸事件，父级 Pressable 的 onPress 收不到 */}
<Pressable style={StyleSheet.absoluteFill} onPress={onFsVideoTap} />
```

**③ 时间轴只有第一段的时长**

现象：开播瞬间总时长只有第 1 段（26s），而不是三段之和（167s）。

根因：iOS 的 `AVMutableComposition` 是**同步拼接**（插轨前必须把每段时长加载完）；
Android 的 `ConcatenatingMediaSource2` 是**懒 prepare**，第 1 段就绪就开播，后两段还在后台下载解析，
`player.getDuration()` 只能慢慢长出来，而 JS 原先只在 `onLoad` 取一次时长。

现在的解法（**原生为主，JS 为可选兜底**）：

| 层 | 做法 |
|---|---|
| 原生 | `MediaMetadataRetriever` 后台探测每段真实时长 + 按 url 缓存；有缓存时用真实时长做占位时长 |
| JS（可选） | `onProgress` 里的 `seekableDuration`（= `player.getDuration()` 最新值）持续补正 |

实测：探测结果 `25025 + 52209 + 90080 = 167314ms`；首次播放（缓存冷）几秒内从 26s 补正到 167s，
**第二次播放起 `onLoad` 直接就是完整的 167s**。

> 注意：JS 兜底那几行（`hooks/usePlaylistPlayback.ts`）**已被还原**，
> 所以现在缓存冷的那一次会把偏小的时长一直显示到 remount（退出全屏再进就正确）。

**④ `duration=0` 时误判"已完成"**

`hasCompletedPlayback = watchedSecondsRef.current >= duration * 0.98`，
刚启动还没加载出时间轴时 `duration = 0`，`0 >= 0` 成立 → 一进来就是绿勾、Complete 可点。

修法（1 行，JS 侧）：

```diff
-  const hasCompletedPlayback =
-    endedRef.current || watchedSecondsRef.current >= duration * 0.98;
+  const hasCompletedPlayback =
+    ready && (endedRef.current || watchedSecondsRef.current >= duration * 0.98);
```

> 这行也随上一节的还原一并回退了，如需修就单独补这一行。

**⑤ 模拟器没声音（环境问题，不是代码问题）**

应用侧一直在写 PCM，但模拟器音频 HAL 写宿主失败：

```
android.hardware.audio@7.1-impl.ranchu: pcmWrite:259
pcm_writei failed with 'cannot read/write stream data: I/O error' (-1)
```

`kill` 掉 `audioserver` 重启后暂停期间无报错、恢复播放又出现 → 与播放强相关，确认是模拟器/宿主音频设备问题。
处理：AVD **Cold Boot Now**、检查 Mac 的声音输出设备、或真机复核。代码不用动。

---

## 16. 双端差异对照

| | iOS | Android |
|---|---|---|
| 拼接对象 | `AVMutableComposition` | `ConcatenatingMediaSource2` |
| 插件接口 | `RNVAVPlayerPlugin.overridePlayerAsset` | `RNVExoplayerPlugin.overrideMediaSourceFactory` |
| 注册位置 | `AppDelegate.mm`（`NSClassFromString` + `performSelector`） | `MainApplication.kt`（`ReactNativeVideoManager.registerPlugin`） |
| JS 传参 | 同一套 `${urls[0]}#playlist=${encodedUrls}` | 同一套 |
| JS 代码 | 同一个 `usePlaylistPlayback.ts` + 同一个 `App.tsx`，**不区分平台** | 同一个 |
| 拼接时机 | 同步（时长一开始就准） | 懒 prepare（时长逐渐变准，原生探测缓存兜底） |
| 跨段事件 | 无（composition 里没有切段回调） | 无（单 window），但 `player.currentMediaItemIndex` 可拿到段号 |
| 预加载下一段 | 不需要，靠 AVPlayer 前向缓冲（`preferredForwardBufferDuration`） | 不需要，靠 ExoPlayer 自身的缓冲窗口 |
| `bufferConfig` | iOS 忽略 | Android 有效 |
| 控制条点击 | 父级 `Pressable` 能收到 | 需额外透明点击层（原生视图会消费触摸） |

**一句话**：JS 侧是一套代码、一个播放器、一条时间轴；两端的差别只有原生插件实现 + 上面这几条行为差异。

---

## 17. 风险与锁版本（插件是实验特性）

官方文档 <https://docs.thewidlarzgroup.com/react-native-video/docs/v6/other/plugin> 明说：

> **This is an experimental API and may change over time.**
> The player handle should be treated as **read-only**. Modifying player behavior may cause unexpected issues
> in `react-native-video`.

同一页也明确列出了"扩展核心行为"的官方入口，**我们用的正是这两个**：

| 平台 | 官方扩展点 | 我们用它做什么 |
|---|---|---|
| Android | `RNVExoplayerPlugin.overrideMediaSourceFactory`（文档原文："replacing the media source factory"） | 返回拼接后的 `ConcatenatingMediaSource2` |
| iOS | `RNVAVPlayerPlugin.overridePlayerAsset` → `OverridePlayerAssetResult(type: .full, asset:)` | 返回 `AVMutableComposition` |

> "These extension points are optional — if no plugin provides them, the player behaves exactly as it did before."
> → 我们的守卫（无 `#playlist=` 返回 null）正好落在这句话上：不触发就等于插件不存在。

**结论：不是 hack，但确实是"官方保留修改权"的接口。** 真实风险集中在**升级 react-native-video 时接口可能变**（方法签名、枚举名、调用时机）。

### 已做的加固

0. **升级前一条命令自检**：`yarn verify:rnv`（`scripts/check-rnv-contract.js`）
   升级完 react-native-video 先跑它，会在**编译之前**告诉你：版本是否漂移、Android 的
   `overrideMediaSourceFactory` / `registerPlugin` 还在不在、iOS 的 `overridePlayerAsset`
   和 `OverridePlayerAssetType.full` 还在不在。任一项不存在就退出码 1。
1. **锁版本**：`package.json` 里 `^6.19.2` → `6.19.2`（精确版本，避免 `yarn install` 静默升到 6.x 新版）。
   lock 文件（`package-lock.json`）已入库；用哪个包管理器就把对应 lock 提交上去，**别两个混用**。
2. **改动面收敛**：两端各 1 个插件文件 + 1 行注册（iOS `AppDelegate.mm` / Android `MainApplication.kt`），接口变了只改这两个文件。
3. **自动降级**：插件只在 uri 带 `#playlist=` 且 ≥2 段时介入，其它 `<Video>` 完全不受影响；线上出问题时把 RN 传的 uri 换回裸 url，立刻退回单段播放，原生代码不用动。
4. **回退路径完整**：旧的双播放器虚拟拼接方案 4 个 hook 全部保留未删（见第 10 节）。

### 升级 react-native-video 前必做的冒烟

升级后先跑一遍这 5 项，全过再发：

1. 三段连播不中断（跨段无黑帧、无重新缓冲）
2. 总时长正确（Android 第二段起应为三段之和；iOS 一开始就是）
3. 拖到任意位置能正常播（含跨段拖动）
4. 控制条点击 / 自动隐藏正常
5. 普通视频（不带 `#playlist=`）不受影响

### 如果哪天接口真改了

按优先级选：

1. 只改插件文件适配新签名（最可能，成本 1 小时内）
2. JS 侧回退到双播放器虚拟拼接（hook 都还在）
3. `patch-package` 直接改库（更脆，不推荐）
4. fork 一份 react-native-video（成本最高）

---

## 18. 附：iOS `.full` 跳过 prepare 到底跳过了什么

`RCTVideo.swift:542-550`：插件返回 `.full` 时直接 `return AVPlayerItem(asset:)`，
**不再调用 `playerItemPrepareText`**（`:550` 才是默认路径）。被跳过的东西一共三类：

```swift
// RCTVideo.swift:703-727
func playerItemPrepareText(...) async -> AVPlayerItem {
    if source.textTracks.isEmpty == true || uri.hasSuffix(".m3u8") {
        return await self.playerItemPropegateMetadata(AVPlayerItem(asset: asset))   // ① 没字幕：只补 metadata
    }
    self._allowsExternalPlayback = false              // ② composition 本来就不能 AirPlay
    let mixComposition = await RCTVideoUtils.generateMixComposition(asset)
    let validTextTracks = await RCTVideoUtils.getValidTextTracks(...)   // 外挂字幕注入
    if validTextTracks.count != source.textTracks.count { setSelectedTextTrack(...) }
    return await self.playerItemPropegateMetadata(AVPlayerItem(asset: mixComposition))
}
```

| 被跳过的能力 | 依赖的 prop | 本项目是否用到 | 实际影响 |
|---|---|---|---|
| 外挂字幕注入 `textTracks` / `selectedTextTrack` / `onTextTracks` | `textTracks` | 没用 | **0** |
| 自定义元数据 → `externalMetadata`（锁屏/控制中心/CarPlay 显示 title、artist、artwork 等） | `source.customMetadata` | 没传 | **0** |
| 外挂字幕资源带 HTTP headers | `textTracks[].uri` + headers | 没用 | **0** |
| tvOS 章节标记 `navigationMarkerGroups` | `chapters` | tvOS 不涉及 | **0** |
| AirPlay（`_allowsExternalPlayback = false`） | — | composition 本来就不支持 AirPlay | **0**（跳过这行没区别） |

**结论：当前用法（无字幕、无 customMetadata、无需鉴权的字幕）下，`.full` 的实际代价是 0。**

### 什么时候不能再用 `.full`

1. 要挂外挂字幕（`textTracks` prop）
2. 要锁屏 / CarPlay 显示标题、封面
3. 字幕资源需要带自定义 headers

那时候的选择：
- 在插件里自己把字幕轨混进 composition、自己写 `externalMetadata`（推荐，仍用 `.full`）
- 或改回 `.partial` —— **但不建议**：`.partial` 会对 composition 再跑一次
  `generateMixComposition`，源码注释写着 "AVPlayer can't airplay AVMutableCompositions"，行为不可预期

### Android 没有这个概念

Android 侧我们只替换了 `MediaSource.Factory`，`mediaItemBuilder`（streamKeys、DRM、clipping 等）
仍由 `ReactExoplayerView` 走完（`ReactExoplayerView.java:1136-1152`），**没有跳过任何 prepare 步骤**。
