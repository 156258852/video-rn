# Loading / Buffering 行为总结

## 1. 什么时候显示 Loading Overlay

在 `App.tsx` 中，`showOverlay` 的条件是：

```ts
const showOverlay = !timelineReady || isLoading || isBuffering;
```

也就是说，只要下面任意一个为真，就会显示黑色遮罩+转圈：

- `timelineReady` 未就绪（所有 clip duration 还没获取完）
- `isLoading` 仍在等待首帧/进度更新
- `isBuffering` 由 `onBuffer` 触发，网络播放卡住

## 2. `timelineReady` 的含义

`useVirtualTimeline.ts` 中：

```ts
const ready =
  durations.length > 0 &&
  durations.every(d => Number.isFinite(d) && d > 0) &&
  total > 0;
```

也就是说，只有所有视频段时长都拿到且都合法时，timeline 才算“就绪”。

如果还有段时长是 `NaN`，`timelineReady` 就为 `false`，这会立即导致 overlay 显示。

## 3. `isLoading` 何时开启 / 关闭

### 开启 (`setIsLoading(true)`)

`useVideoSequencePlayer.ts` 中，以下场景会设置 loading 开启：

- 初始化播放器时 `urls` 变化，整个播放器重置
- 切换到下一段时，通过 `onEnd` 触发跨 clip 切换
- `seekToClip` 发生跨 clip 跳转
- `queueResumeForCurrentClip`（例如全屏切换后重连）

这三个场景都会同时把 `needsProgressClearRef.current = true` 设为真，表明等待下一个 `onProgress`

### 关闭

`onClipProgress` 收到第一个有效进度后：

```ts
if (needsProgressClearRef.current) {
  needsProgressClearRef.current = false;
  setIsLoading(false);
}
```

因此 loading 的隐藏时机不是 `onLoad`，而是“实际有上一帧 / progress 更新进来”之后。

## 4. `isBuffering` 何时生效

`useVideoSequencePlayer.ts` 里的 `onClipBuffer`：

```ts
const buf = !!e?.isBuffering;
if (prevBufferingRef.current !== buf) {
  prevBufferingRef.current = buf;
  setIsBuffering(buf);
}
```

也就是只要 `onBuffer` 事件报告当前播放器进入缓冲状态，`isBuffering` 就变成 `true`；缓冲结束后会变回 `false`。

## 5. 你的表是否匹配当前逻辑

| 情况                   | 触发时机                   | 是否显示 Loading | 原因                                                                                       | 代码对应                                                |
| ---------------------- | -------------------------- | ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **首次加载**           | 打开页面，第一段还没准备好 | ✅ 显示          | 逻辑上 `timelineReady` / `isLoading` 都会触发                                              | `useEffect` 初始化 + `showOverlay`                      |
| **切换段（已预加载）** | 当前段播完，切到下一段     | ✅ 可能短暂显示  | 代码仍会 `setIsLoading(true)`，但若已预加载，`onProgress` 很快清除它                       | `onEnd` + `checkAndFlushPendingSeek` + `onClipProgress` |
| **切换段（未预加载）** | 预加载失败或没来得及       | ✅ 显示          | 需要等待下一段真正出 progress                                                              | `onEnd` 触发 loading，直到 `onClipProgress`             |
| **Seek（已缓存）**     | 快退/快进到已加载的视频    | ❌ 一般不显示    | 如果目标段已经在 inactive 播放器上预载且 `checkAndFlushPendingSeek` 成功，会迅速展示下一段 | `seekToClip` + `checkAndFlushPendingSeek`               |
| **Seek（未缓存）**     | 快退/快进到没加载的视频    | ✅ 显示          | 需要切换来源并等待首个进度                                                                 | `seekToClip` 设置 loading，等待 `onProgress`            |
| **网络缓冲**           | 播放中网络跟不上           | ✅ 显示          | `onBuffer` 将 `isBuffering` 置真                                                           | `onClipBuffer`                                          |

### 关键修正

你的表总体是对的，但有一个重要补充：

- 即使“已预加载”的切换，`App` 仍然会先设置 `isLoading = true`，不过如果预加载足够快，`onProgress` 也会很快把它关掉；这意味着 overlay 可能只闪一下或者几乎看不见。
- `timelineReady` 未就绪本质上是“duration 信息不全”，而不是“当前帧没读到”。

## 6. 最终结论

这个 loading 体系里，`showOverlay` 是“timeline 未准备好 OR 当前片段还未渲染 OR 正在缓冲”。

所以你表格的思路基本正确，唯一要补充的是：

- “已预加载切换”不一定完全不显示 loading，它只是“很快就会消失”
- “Seek（已缓存）”是否显示，取决于目标片段是否真的已经被 inactive player 预加载并立刻能返回 `onProgress`

---

如果你愿意，我可以继续帮你把这份总结写成一个独立文件，例如 `docs/LOADING.md`。
