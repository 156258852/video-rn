# useVideoSequencePlayer 流程图

本文档以 Mermaid 流程图形式描述状态机的核心流程，与 [STATE_MACHINE.md](./STATE_MACHINE.md)（文字 + 转移矩阵）互补。

---

## 1. 状态机总览（Phase 转移）

分三层读：

- **上层** — seek 循环（用户拖动 / clip 切换时的短暂过渡态）
- **中层** — 主播放线（INIT → loading → ready → ended）
- **下层** — 恢复区（error 的自动/手动恢复）

```mermaid
graph LR
    subgraph seek循环
        loadedPendingSeek -->|SEEK_APPLIED + wantPlaying| seeking
        seeking -->|首个 PROGRESS 确认| ready
    end

    subgraph 主播放线
        INIT[INIT] --> loading
        loading -->|LOAD_SUCCESS noPending| ready
        loading -->|LOAD_SUCCESS hasPending| loadedPendingSeek
        ready -->|END 有下一段 hit| loadedPendingSeek
        ready -->|END 有下一段 miss| loading
        ready -->|END 最后一段| ended
    end

    subgraph 恢复区
        error -.->|自动重试 / 手动 seek| loading
    end

    ready -->|SEEK / END hit| loadedPendingSeek
    seeking -->|SET_PLAYING false| ready
    seeking -->|再次 SEEK| loadedPendingSeek
    seeking -->|END miss / RELOAD| loading
    seeking -->|END 最后一段| ended
    loading -->|ERROR| error
    ready -->|ERROR| error
    seeking -->|ERROR| error
    loadedPendingSeek -->|ERROR| error
    ended -->|seek 回退 / reload| loading
```

> 详细转移规则见 [STATE_MACHINE.md 第 5 节：各 Phase 的转移规则](./STATE_MACHINE.md#5-各-phase-的转移规则)。

---

## 2. 首次加载流程

```mermaid
graph TB
    A[App 挂载] --> B[INIT: slot0 = clip0]
    B --> C[phase: loading, isLoading = true]
    C --> D{AVPlayer 加载元数据}
    D -->|onLoad 触发| E[LOAD_SUCCESS]
    E --> F[phase: ready]
    F --> G[preload effect: PRELOAD_SLOT clip1]
    D -->|网络慢| H[停在 loading 等待]
    H -->|网络恢复, onLoad 到达| E
    H -->|AVPlayer 超时 onError| I[phase: error]
    I --> J[自动重试 effect: 3s 后 RELOAD_ACTIVE]
    J --> C
```

---

## 3. 段内 Seek 流程（SEEK_WITHIN_CLIP）

```mermaid
graph TB
    A[用户拖动 scrubber] --> B[SET_SEEKING true]
    B --> C[gate: PROGRESS / END 被屏蔽]
    C --> D[用户松手]
    D --> E[SEEK_WITHIN_CLIP: seekToken++, pendingSeekTime = t]
    E --> F[phase: loadedPendingSeek]
    F --> G[seek effect: player.seek t]
    G --> H[SEEK_APPLIED: isSeeking = false, seekJustApplied = true]
    H --> I{wantPlaying?}
    I -->|是| J[phase: seeking]
    I -->|否| K[phase: ready paused]
    J --> L{首个 PROGRESS 通过 progressGuard?}
    L -->|是| M[seekJustApplied = false, phase: ready]
    L -->|时间偏差过大, 拒绝| L
```

---

## 4. 跨 Clip Seek（SEEK_TO_CLIP）

```mermaid
graph TB
    A[seekVirtual t] --> B[getClipForTime: idx + local]
    B --> C{idx === currentIndex?}
    C -->|是| D[SEEK_WITHIN_CLIP 段内流程]
    C -->|否| E{inactive slot 已分配目标 clip 且加载完成? slotLoadedKey === loadKey}
    E -->|hit| F[切换 activeSlot, phase: loadedPendingSeek]
    E -->|miss| G[inactive slot 装载新 clip, phase: loading]
    F --> H[seek effect → SEEK_APPLIED → seeking]
    G --> I[等待 onLoad → LOAD_SUCCESS]
    I --> J[phase: loadedPendingSeek]
    J --> H
    H --> K[首个 PROGRESS → ready]
```

---

## 5. Clip 切换流程（onEnd）

```mermaid
graph TB
    A[onEnd 触发] --> B{前置检查: stale事件 / isSeeking / phase非 ready&seeking / seekJustApplied时nearEnd}
    B -->|任一不通过| X[丢弃]
    B -->|通过| C{有下一段?}
    C -->|是| D{inactive slot 已预加载?}
    D -->|hit| E[endHitPatch: 切换 slot, pendingSeekTime = 0]
    D -->|miss| F[endMissPatch: 装载新 clip, phase: loading]
    E --> G[phase: loadedPendingSeek]
    G --> H[seek effect → SEEK_APPLIED → seeking]
    F --> I[onLoad → LOAD_SUCCESS → loadedPendingSeek]
    I --> H
    H --> J[PROGRESS → ready, 续播下一段]
    C -->|否 最后一段| K[endEndedPatch: phase: ended, sequenceEndCount++]
```

---

## 6. Error 自动重试流程

```mermaid
graph TB
    A[phase: error] --> B[retry effect 启动定时器]
    B --> C[等待期间: 用户 seek / reload 等操作使 phase 离开 error]
    C --> D[React effect cleanup: clearTimeout, 计数器归零]
    D --> E[重试取消, 用户操作即为恢复路径]
    B --> F[定时器触发: 读取 stateRef.current]
    F --> G{phase 仍为 error?}
    G -->|否| H[不执行任何操作]
    G -->|是| I{retryCount < 3?}
    I -->|否| J[停止重试, 等待用户操作]
    I -->|是| K[RELOAD_ACTIVE: cache-bust URL + currentTime]
    K --> L[SET_PLAYING true 若出错前在播放]
    L --> M[phase: loading]
    M --> N{加载结果}
    N -->|LOAD_SUCCESS| O[ready, 自动续播, 计数器归零]
    N -->|再次 ERROR| A
```

---

## 7. 双播放器 Slot 轮转

```mermaid
graph TB
    A[slot0 active: 播放 clip0] --> B[slot1 inactive: 预加载 clip1]
    B --> C[clip0 onEnd → endHitPatch]
    C --> D[slot1 active: 播放 clip1]
    D --> E[preload effect → slot0 预加载 clip2]
    E --> F[clip1 onEnd → endHitPatch]
    F --> G[slot0 active: 播放 clip2]
    G --> H[preload effect → slot1 预加载 clip3]
```
