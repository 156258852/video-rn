# RN stitch video player（Demo）讨论记录

## 背景

- 业务形态：多个 MP4 URL 在前端按顺序“拼接”为一个虚拟长视频（virtual timeline）。
- 播放器：react-native-video。
- 目标体验：进度条/拖动/快进快退像单一视频一样工作；切段尽量无缝（因此当前保留双 Video 播放器策略）。

## 最终决策 / 当前实现（已落地到工作区）

### Demo 策略：配置时直接写死每段 clip 的时长

- 在 `App.tsx` 里使用：`CLIPS = [{ uri, duration }, ...]`。
- `mp4Durations/mp4Offsets/mp4Total` 均由 `CLIPS` 派生。
- 因为总时长一开始就已知：
  - 不需要估算（avgDuration / effectiveDurations / effectiveOffsets）
  - 不需要 headless preloader 去提前 `onLoad(e.duration)`
  - UI 不需要 `--:--` gating（remaining/total 直接用 `mp4Total`）

### 播放/切段策略

- 继续保留“双 Video”方案（active 播放 + hidden 预加载下一段）以减少切段黑屏/等待。
- `onClipProgress(clipIdx, e)` 过滤旧 clip 的晚到 progress：
  - 若 `clipIdx !== mp4IndexRef.current` 则忽略，避免切段时进度条“闪到 100%”。
- `onClipLoad` 不再写入 duration（避免覆盖配置的 duration）；仅用于处理 pending seek / resume。

## 现象/问题（历史）

1. 打开视频时 UI 总时长（total）一开始就出现，且出现了 **36s**。
2. 用户疑问：是不是 preloader 只加载 1 段？为什么 total 看起来像“真实值”。

## 定位结论：36s 的来源（历史）

当时的代码存在“估算时间轴（Estimated timeline）”逻辑：

- 计算 `avgDuration`（平均时长），并用它补齐未知 clip 的 duration。
- `mp4Total` 是基于 `effectiveDurations` 累加出来的。

因此如果只加载到 1 段真实 duration，比如第一段 12s：

- `avgDuration = 12`
- `effectiveDurations = [12, 12, 12]`
- `mp4Total = 36`

所以 **36s 可能只是“1 段真实 + 其余用 avg 补齐”的估算结果**，并不表示已拿到全部 clip duration。

## 关于“能否不用写死 duration 仍拿到准确 duration”（生产方向，未接入当前 Demo）

- 仅有 URL 的情况下，想拿到准确时长，必须读取 MP4 元数据（moov/mvhd）。
- 你已验证 AEM URL 支持 Range：`Accept-Ranges: bytes` 且有 `Content-Range`。

可选方案（生产向）：

1. 继续用 react-native-video 的 `onLoad(e.duration)`（逐段 load 拿 duration），但段多时可能慢。
2. 用 HTTP Range + MP4 元数据解析（例如 mp4box.js）更快拿到 duration。
   - 工作区里曾创建 `utils/mp4Duration.ts` 作为探索实现，但目前未接入 `App.tsx`。
