//
//  PlaylistComposerPlugin.swift
//  StitchRNPOCModern
//
//  职责边界：原生只负责"把多段 MP4 合成一条连续时间轴并播出来"，
//  进度条 / 全屏 / 按钮 / 完成度判定仍然由 RN 自绘。
//
//  工作原理：
//  RN 侧把播放列表挂在第一个 URL 的 fragment 上（#playlist=url1,url2,url3），
//  本插件在 react-native-video 准备 asset 时把它换成一条 AVMutableComposition。
//  于是 AVPlayer 只看到 1 个 item：duration = 总时长，currentTime = 全局时间，
//  seek 也是全局的，RN 侧不再需要虚拟时间轴和双播放器预加载。
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
    // 1) 不能用 NSLog —— Swift 6 / Xcode 27 下报
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
