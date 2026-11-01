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

/**
 * Android 侧 playlist 插件（对应 iOS 的 PlaylistComposerPlugin.swift）。
 *
 * 作用：把 RN 传下来的 `${urls[0]}#playlist=${encodedUrls}` 这条 uri，
 * 在原生侧展开成一个 ConcatenatingMediaSource2（多段首尾相接的单条时间轴），
 * RN 侧始终只用 1 个 <Video>，不出现切段、不出现多个播放器。
 *
 * 守卫：uri 里没有 `#playlist=` 或只有一段时返回 null，
 * 交给 react-native-video 走它自己的默认路径，不影响其它页面。
 */
class PlaylistComposerPlugin : RNVExoplayerPlugin {

    companion object {
        private const val TAG = "PlaylistComposerPlugin"
        private const val MARKER = "#playlist="

        // 默认占位时长：还没探测到真实时长时先用它，prepare 完会被真实值替换
        private const val DEFAULT_PLACEHOLDER_MS = 1_000L

        // url -> 真实时长(ms)：后台探测一次后缓存，后续同 url 一上来就是完整总时长
        private val durationCache = ConcurrentHashMap<String, Long>()
        private val probeExecutor = Executors.newSingleThreadExecutor()

        /**
         * 后台探测单个 url 的时长。
         * 只在缓存里没有时才跑，避免重复网络请求。
         */
        private fun probeDurationAsync(url: String) {
            probeExecutor.execute {
                if (durationCache.containsKey(url)) {
                    return@execute
                }
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
        if (rawUri.isNullOrEmpty()) {
            return null
        }

        val markerIdx = rawUri.indexOf(MARKER)
        if (markerIdx < 0) {
            // 普通视频：完全不干预
            Log.d(TAG, "no playlist marker, use default factory")
            return null
        }

        val playlistParam = rawUri.substring(markerIdx + MARKER.length)
        val urls = playlistParam
            .split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { URLDecoder.decode(it, "UTF-8") }

        if (urls.size <= 1) {
            Log.d(TAG, "playlist has ${urls.size} item, use default factory")
            return null
        }

        // 没缓存过的 url 后台探测一次，下次再播这条 playlist 就能一上来拿到完整时长
        urls.forEach { url ->
            if (!durationCache.containsKey(url)) {
                probeDurationAsync(url)
            }
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
     * 自定义 MediaSource.Factory：把 N 个 url 拼成一条连续时间轴。
     *
     * 注意：子 source 复用 react-native-video 传下来的默认 factory 创建，
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
                // 有探测缓存就用真实时长（总时长一开始就是完整的），
                // 否则用默认值，等各段 prepare 完由真实值替换
                val placeholderMs = durationCache[url] ?: DEFAULT_PLACEHOLDER_MS
                builder.add(child, placeholderMs)
            }
            return builder.build()
        }
    }
}
