# Hooks 文档（入参 / 返回值 / 功能 / 使用方式）

本文档对应当前代码目录 `hooks/` 下的实现：

- `useAutoHideControls`
- `useScrubber`
- `useVideoDurations`
- `useVirtualTimeline`
- `useVideoSequencePlayer`
- `useVideoSequenceTimelinePlayer`（最终对外“引擎门面”，把上面几层组合起来）

---

## 0. 总体架构与数据流（推荐理解方式）

这个播放器拆成三层职责：

1. **数据采集**：`useVideoDurations(urls)`

   - 目标：尽快拿到每段视频真实 `duration`（通过 `<Video onLoad>`）
   - 输出：`durations[]` + 一个 `preloadNode`（隐形 Video 用来预加载下一段的 metadata）

2. **播放状态机/播放器引擎**：`useVideoSequencePlayer({ urls, durations, ... })`

   - 目标：管理两个 `<Video>` slot、切段、seek、progress 更新、onEnd 行为等
   - 输出：`videoSlots`（直接渲染）+ 播放/索引/时间等状态与动作

3. **纯时间轴数学**：`useVirtualTimeline({ durations, currentIndex, currentTime, version })`
   - 目标：把“当前处于第几段、段内时间”映射为“虚拟时间（拼接后的总时间轴）”，并提供反向映射能力

最终对外只建议 App 使用：

- `useVideoSequenceTimelinePlayer({ urls })`  
  它把 (1)(2)(3) 组合起来，并把交互协调状态 `isSeeking`、保护值 `totalSafe` 一并收口。

---

## 1) `useAutoHideControls`

### 功能

用于“全屏控制层”的自动隐藏逻辑（类似 iOS 原生播放器）：

- 进入 enabled（例如进入全屏）时：显示 controls，并按 delay 启动自动隐藏计时器
- 播放中：会自动隐藏
- 暂停中：保持显示（便于用户操作）
- 支持手动 `show/hide/toggle`，以及 `onTap` 一键绑定到视频点击事件

### 入参

```ts
type UseAutoHideControlsParams = {
  enabled: boolean; // 是否启用自动隐藏（通常 = 是否全屏）
  playing: boolean; // 当前是否在播放
  delayMs?: number; // 自动隐藏延迟，默认 3500ms
};
```

### 返回值

```ts
type UseAutoHideControlsResult = {
  visible: boolean; // controls 是否可见（逻辑状态）
  opacity: Animated.Value; // 动画值，建议直接绑定 overlay 的 opacity
  show: () => void; // 显示并重置 hide timer（若 playing）
  hide: () => void; // 立即隐藏并取消 hide timer
  toggle: () => void; // visible 反转
  onTap: () => void; // 推荐：视频区域 onPress 直接用它
};
```

### 典型用法

```tsx App.tsx
const fsControls = useAutoHideControls({
  enabled: isFullscreen,
  playing,
  delayMs: 3500,
});

<Pressable onPress={fsControls.onTap}>
  {renderVideo()}
</Pressable>

<Animated.View style={{ opacity: fsControls.opacity }}>
  {renderControls()}
</Animated.View>
```

### 注意点 / Contract

- `playing=false` 时不自动隐藏（这是代码里明确的设计：用户暂停时更可能需要看 UI）。
- `enabled` 从 false -> true 会重置为可见并启动计时器；从 true -> false 会清 timer，并把 visible 重置为 true（为下次进入做准备）。

---

## 2) `useScrubber`

### 功能

封装“进度条拖拽（scrub）”交互：

- 管理 track 宽度、thumb/fill 的布局计算
- 管理“预览时间 previewTime”（拖动中显示预览位置）
- 拖动开始/结束会通过 `onSeekingChange(true/false)` 通知外部（用于让播放器忽略 `onProgress` 回灌）

### 入参

```ts
type UseScrubberParams = {
  enabled: boolean; // 禁用时不响应拖拽
  total: number; // 总时长（必须是安全值，外部通常传 totalSafe）
  baseTime: number; // 当前虚拟时间（未拖动时显示的时间）
  onCommit: (t: number, reason: string) => void; // 松手提交
  onSeekingChange?: (seeking: boolean) => void; // 开始/结束拖动时回调
  clearPreviewDelayMs?: number; // 松手后清除 preview 的延迟，默认 150ms
};
```

### 返回值

```ts
type UseScrubberResult = {
  isSeeking: boolean; // scrubber 自己的拖动状态（UI 可用）
  displayedTime: number; // 当前应该显示的时间：previewTime ?? baseTime
  fillW: number; // 进度填充宽度（px）
  thumbLeft: number; // thumb 的 left（px）
  trackRef: React.RefObject<View>;
  onTrackLayout: (e: any) => void; // 记录 track 宽度
  panHandlers: any; // 直接 spread 到 overlay View 上
};
```

### 典型用法

```tsx App.tsx
const scrubber = useScrubber({
  enabled: ready,
  total: totalSafe,
  baseTime: virtualTime,
  onCommit: t => seekVirtual(t),
  onSeekingChange: setIsSeeking, // 由 engine 提供（推荐）
});

<Pressable
  ref={scrubber.trackRef}
  onLayout={scrubber.onTrackLayout}
  disabled={!ready}>
  <View style={{width: scrubber.fillW}} />
  <View style={{left: scrubber.thumbLeft}} />
  <View {...scrubber.panHandlers} />
</Pressable>;
```

### 注意点 / Contract

- `onSeekingChange` 必须满足：
  - 开始拖动：`true`
  - Release：`false`
  - Terminate（系统打断手势）：`false`
- `total` 会在 hook 内再次做“安全化”处理，但强烈建议外部传入 `totalSafe`，避免出现 `total=0` 导致除零与拖动无效。
- `reason` 当前主要是 `"scrubRelease"`，保留扩展空间（例如点击跳转、键盘快进等）。

---

## 3) `useVideoDurations`

### 功能

对 `urls[]` 逐个做“元数据预加载”，读取 `<Video onLoad>.duration`：

- 内部维护 `durations: number[]`，初始全为 `NaN`
- 找到第一个 `NaN` 的 index，渲染一个隐藏 `<Video>` 去加载它
- 同时暴露 `recordDuration(idx, duration)`，允许“真正播放的 Video onLoad”也把 duration 回填进来（补齐或加速）

### 入参

```ts
export function useVideoDurations(urls: string[]): {
  durations: number[];
  recordDuration: (idx: number, durationSeconds: number) => void;
  preloadNode: React.ReactNode;
};
```

### 返回值

- `durations: number[]`
  - 长度等于 `urls.length`
  - 未拿到的项为 `NaN`
  - 拿到的项为 `>0` 的 number
- `recordDuration(idx, durationSeconds)`
  - 会做边界检查与合法性检查（finite 且 >0）
  - 同一个 idx 多次上报，会保留更大的值（避免不同来源误差导致倒退）
- `preloadNode`
  - 一个隐藏的 `<Video ... paused />`
  - 当全部 duration 都填完后返回 `null`

### 注意点 / Contract

- `urls` 变化会 reset：`durations` 全部回到 `NaN`，并从头开始预加载。
- `preloadNode` 使用 `key={`dur-preload-${urls[preloadIndex]}`}` 强制 remount，避免 RNVideo 对 source 更新时 onLoad 行为不稳定。

---

## 4) `useVirtualTimeline`

### 功能

纯函数式的“时间轴数学层”：

- 根据 `durations[]` 计算每段起点 `offsets[]`
- 计算 `total`
- 提供：
  - 正向映射：`(currentIndex, currentTime) -> virtualTime`
  - 反向映射：`virtualTime -> { idx, local }`（二分查找）
- 提供 `ready`（durations 全有效且 total>0）
- 提供 `clampVirtualTime` 做边界保护

### 入参

```ts
type UseVirtualTimelineParams = {
  durations: number[];
  currentIndex: number; // 当前播放到第几段
  currentTime: number; // 当前段内时间（秒）
  version?: number; // 可选：用于“ref 时间不触发重渲染”的场景强制刷新 memo
};
```

### 返回值

```ts
type UseVirtualTimelineResult = {
  offsets: number[]; // length = durations.length + 1，offsets[0]=0
  total: number; // 拼接后总时长
  ready: boolean; // durations 全部 finite 且 >0，且 total>0
  virtualTime: number; // offsets[currentIndex] + currentTime（并 clamp）
  getClipForTime: (t: number) => {idx: number; local: number};
  clampVirtualTime: (t: number) => number;
};
```

### 注意点 / Contract

- `version` 是关键参数：因为播放器把 `currentTime` 放在 `ref` 里时，React 不会自动重算 `useMemo`。通过依赖 `version` 可以让 `virtualTime` 正确刷新。
- `getClipForTime` 的区间语义是 `[start, end)`，末尾会 clamp 到最后一段结尾。
- 当 durations 未 ready 时：
  - offsets/total 仍然会给出一个“基于 0 的累加”结果（因为 NaN 会当作 0）
  - 但 `ready` 为 false，外部应当用 `ready` 做 gating（例如禁用 scrub）

---

## 5) `useVideoSequencePlayer`

### 功能

这是“拼接播放”的核心状态机层，管理两个 `<Video>` 实例作为双缓冲：

- `videoSlots[0..1]`：每个 slot 提供 ref/source/paused/onLoad/onProgress/onEnd（App 只负责渲染）
- 当前播放 slot = `activePlayer`
- 当前播放片段 index = `currentIndex`
- 当前片段时间保存在 `currentTimeRef`（ref，不会触发渲染），并通过 `version` tick 触发 UI 更新
- 支持：
  - `seekToClip(idx, local)`
  - 自动 onEnd 切到下一段（并做时间归零/最后一段贴底等）
  - `queueResumeForCurrentClip()`：用于 fullscreen remount 时恢复

### 入参

```ts
type UseVideoSequencePlayerParams = {
  urls: string[];
  durations: number[];
  recordDuration?: (idx: number, durationSeconds: number) => void;

  isSeeking: boolean; // 外部协调状态：拖动中时忽略 onProgress 回灌

  // 目前实现中可选（历史遗留/兼容用），本项目实际是由 composition hook 实现 seekVirtual
  getClipForTime?: (t: number) => {idx: number; local: number};
};
```

### 返回值（核心字段）

```ts
return {
  // 渲染层
  videoSlots: VideoSlotProps[]; // 两个 slot，App map 渲染
  activePlayer: number;         // 0 or 1

  // 播放控制
  playing: boolean;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  playingRef: React.RefObject<boolean>;

  // 当前索引与时间
  currentIndex: number;
  currentTimeRef: React.RefObject<number>;
  version: number;

  // 动作
  seekToClip: (idx: number, localSeconds: number, opts?: { play?: boolean }) => void;
  seekVirtual: (t: number, opts?: { play?: boolean }) => void; // 仅当传了 getClipForTime 才生效
  queueResumeForCurrentClip: () => { idx: number; time: number };
}
```

### 关键行为说明

- `onProgress`：
  - 若 `isSeeking` 为 true，直接 return（避免用户拖动时被播放器进度回写打断）
  - 只接受“当前 index 对应的视频”回灌
- `onEnd`：
  - 非最后一段：切到下一段、切换 activePlayer、把下一段 seek(0)
  - 最后一段：把 time 推到 duration（如果已知）并 `setPlaying(false)`，让 UI 显示 100%

### 注意点 / Contract

- `urls` 变化会触发 reset：index/time/playing 都回到初始，并 bumpVersion。
- `durations[]` 用于：
  - seek 时 clamp 到 duration
  - onEnd 时最后一段贴底（避免 UI 停在略小于 total）

---

## 6) `useVideoSequenceTimelinePlayer`（推荐 App 只依赖它）

### 功能

这是最终“引擎门面”组合 hook，负责把：

- `useVideoDurations`（duration 采集）
- `useVideoSequencePlayer`（播放状态机）
- `useVirtualTimeline`（时间轴数学）

组合成对外稳定的一套 API，并补齐两项收口能力：

- `isSeeking/setIsSeeking`：交互协调状态收进 engine
- `totalSafe`：timeline ready 前给 UI/手势用的安全总时长（默认 1）

### 入参

```ts
type UseVideoSequenceTimelinePlayerParams = {
  urls: string[];
};
```

### 返回值（按模块理解）

它返回一个“合并对象”，本质上包含：

1. durations 层

- `preloadNode`
- `durations`

2. player 层（来自 `useVideoSequencePlayer`）

- `videoSlots`
- `activePlayer`
- `playing / setPlaying / playingRef`
- `currentIndex / currentTimeRef / version`
- `seekToClip`
- `queueResumeForCurrentClip`
- （以及 player 内的 seekVirtual，但通常用下面 composition 的 seekVirtual）

3. timeline 层（来自 `useVirtualTimeline`）

- `offsets`
- `total`
- `ready`
- `virtualTime`
- `getClipForTime`
- `clampVirtualTime`

4. composition 补充

- `totalSafe`：`ready ? total : 1`
- `isSeeking / setIsSeeking`
- `seekVirtual(t)`：使用 `timeline.getClipForTime(t)` -> `player.seekToClip(idx, local, {play:true})`

### 典型用法（App 侧建议写法）

```tsx App.tsx
const engine = useVideoSequenceTimelinePlayer({urls: mp4Urls});

const scrubber = useScrubber({
  enabled: engine.ready,
  total: engine.totalSafe,
  baseTime: engine.virtualTime,
  onCommit: t => engine.seekVirtual(t),
  onSeekingChange: engine.setIsSeeking,
});

// 渲染 video
{
  engine.preloadNode;
}
{
  engine.videoSlots.map((slot, i) => (
    <Video
      key={i}
      ref={slot.ref}
      source={slot.source}
      paused={slot.paused}
      onLoad={slot.onLoad}
      onProgress={slot.onProgress}
      onEnd={slot.onEnd}
      /* ... */
    />
  ));
}
```

### 注意点 / Contract

- App 不再需要自持有：
  - `isSeeking` state
  - `safeTotal` 派生值  
    这些都由 engine 提供，App 更接近“纯 UI”。

---

## 7) 建议：对外 API 的“稳定导出清单”（可作为 App 的唯一依赖）

如果你想把 App 写得更干净，可以把 engine 的 destructuring 固定成一组：

- 渲染：
  - `preloadNode`
  - `videoSlots`
  - `activePlayer`
- 播放控制：
  - `playing`, `setPlaying`, `playingRef`
- 时间轴：
  - `virtualTime`, `ready`, `totalSafe`
- 交互协调：
  - `setIsSeeking`
- 动作：
  - `seekVirtual`
  - `queueResumeForCurrentClip`

这样 App 基本不需要知道“当前第几段、段内时间、durations 如何来的”等内部细节。

---
