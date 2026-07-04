# useVideoSequencePlayer 状态机文档

本文档描述 `hooks/useVideoSequencePlayer.ts` 中的有限状态机（FSM）设计。

---

## 1. 七个阶段（Phase）

| Phase               | 含义                                                  | 是否接受 PROGRESS | 是否接受 END           |
| ------------------- | ----------------------------------------------------- | ----------------- | ---------------------- |
| `idle`              | 无 clip 加载（urls 为空或首次 INIT 前）               | ✗                 | ✗                      |
| `loading`           | active slot 正在加载 clip，等待 `onLoad`              | ✗                 | ✗                      |
| `loadedPendingSeek` | clip 已加载，有 pending seek 等待执行                 | ✗                 | ✗                      |
| `seeking`           | seek 已提交（`SEEK_APPLIED`），等待首个 PROGRESS 确认 | ✓                 | ✓（需 seek 已 settle） |
| `ready`             | 正常播放中，PROGRESS / END 正常处理                   | ✓                 | ✓                      |
| `ended`             | 最后一段播放完毕，等待用户 seek 恢复                  | ✗                 | ✗                      |
| `error`             | active slot 发生错误，等待用户 seek 恢复              | ✗                 | ✗                      |

---

## 2. 2D 转移矩阵结构

### 核心数据结构

```ts
type Rule = {
  action: Action['type']; // 匹配的 action 类型
  guard?: (s: State, a: Action) => boolean; // 可选守卫
  patch: (s: State, a: Action) => Partial<State>; // 状态补丁
};
type Matrix = Record<Phase, Partial<Record<Phase, Rule[]>>>;
```

`TRANSITIONS[from][to] = Rule[]` — 行 = 源 phase，列 = 目标 phase。

### Reducer 执行逻辑

```ts
function reducer(state: State, action: Action): State {
  if (action.type === 'INIT') return initFromAction(action);
  const row = TRANSITIONS[state.phase];
  for (const to of PHASE_ORDER) {
    // 遍历目标 phase
    const rules = row[to];
    if (!rules) continue;
    for (const r of rules) {
      // 遍历规则
      if (r.action !== action.type) continue;
      if (r.guard && !r.guard(state, action)) continue;
      return {...state, ...r.patch(state, action), phase: to};
    }
  }
  return state; // 无匹配规则 → 丢弃 action
}
```

**关键特性：**

- 第一个匹配（action + guard）的规则立即返回，后续规则不再检查
- 对角线单元格（`to === from`）持有"仅副作用"规则，不改变 phase
- 空单元格 = 非法转移，action 被静默丢弃

---

## 3. 关键状态字段

### Seek 生命周期字段

| 字段               | 类型         | 说明                                                                            |
| ------------------ | ------------ | ------------------------------------------------------------------------------- |
| `seekToken`        | number       | 每次 seek 请求递增（seekWithin / seekToClip / endHit / endMiss / reloadActive） |
| `appliedSeekToken` | number       | `SEEK_APPLIED` 时设为当前 `seekToken`，表示 seek 已提交给 native player         |
| `pendingSeekTime`  | number\|null | seek 的目标时间，seek effect 用它调用 `player.seek()`                           |
| `isSeeking`        | boolean      | **用户手势状态**（拖动中 = true）。与播放 phase 正交，仅用于 gate PROGRESS      |
| `seekJustApplied`  | boolean      | **seek-settling 窗口标志**。`SEEK_APPLIED` 时设为 true，首个 PROGRESS 时清除    |

### 字段关系图

```
用户开始拖动          SEEK_APPLIED              首个 PROGRESS
     │                     │                         │
     ▼                     ▼                         ▼
  isSeeking=true      isSeeking=false           seekJustApplied=false
                      seekJustApplied=true
                      appliedSeekToken=token
```

### 三层 stale event 防御

| 层                               | 生效区间                       | 防御对象                              | 机制                                            |
| -------------------------------- | ------------------------------ | ------------------------------------- | ----------------------------------------------- |
| `isSeeking`                      | 拖动开始 → `SEEK_APPLIED`      | PROGRESS + END                        | `progressGuard` 和 `onEnd` 检查 `s.isSeeking`   |
| `seekToken !== appliedSeekToken` | seek dispatch → `SEEK_APPLIED` | PROGRESS + END                        | `progressGuard` 检查 token 匹配                 |
| `seekJustApplied`                | `SEEK_APPLIED` → 首个 PROGRESS | stale PROGRESS（时间偏差）+ stale END | `progressGuard` 上界检查 + `onEnd` nearEnd 检查 |

---

## 4. 各 Phase 的转移规则

### 4.1 `idle`

| 目标                | Action          | Guard           | 说明                           |
| ------------------- | --------------- | --------------- | ------------------------------ |
| `loading`           | `SEEK_TO_CLIP`  | missGuard       | 跨 clip seek，目标未预加载     |
| `loading`           | `RELOAD_ACTIVE` | reloadGuard     | 全屏 remount 后重载当前 clip   |
| `loadedPendingSeek` | `SEEK_TO_CLIP`  | hitGuard        | 跨 clip seek，目标已预加载     |
| `error`             | `ERROR`         | activeGuard     | active slot 出错               |
| `idle` (self)       | `SET_SEEKING`   | —               | 更新拖动状态                   |
| `idle` (self)       | `PRELOAD_SLOT`  | preloadGuard    | 预加载 inactive slot           |
| `idle` (self)       | `SET_PLAYING`   | pauseGuard      | 只接受暂停（idle 无法播放）    |
| `idle` (self)       | `LOAD_SUCCESS`  | active/inactive | 记录 loaded key                |
| `idle` (self)       | `ERROR`         | inactiveGuard   | inactive slot 出错 → 丢弃 slot |

**设计意图：** idle 表示没有 clip 可播。唯一离开 idle 的方式是 seek 或 reload。

### 4.2 `loading`

| 目标                | Action             | Guard             | 说明                                   |
| ------------------- | ------------------ | ----------------- | -------------------------------------- |
| `loadedPendingSeek` | `SEEK_TO_CLIP`     | hitGuard          | seek 到已预加载的 clip                 |
| `loadedPendingSeek` | `LOAD_SUCCESS`     | advancePendGuard  | active slot 加载完成 + 有 pending seek |
| `ready`             | `LOAD_SUCCESS`     | advanceReadyGuard | active slot 加载完成 + 无 pending seek |
| `error`             | `ERROR`            | activeGuard       | active slot 出错                       |
| `loading` (self)    | `SET_SEEKING`      | —                 | —                                      |
| `loading` (self)    | `PRELOAD_SLOT`     | preloadGuard      | —                                      |
| `loading` (self)    | `BUFFER`           | activeGuard       | 缓冲状态更新                           |
| `loading` (self)    | `SET_PLAYING`      | —                 | 接受 play 和 pause                     |
| `loading` (self)    | `SEEK_WITHIN_CLIP` | —                 | 更新 seek 目标                         |
| `loading` (self)    | `SEEK_TO_CLIP`     | missGuard         | 切换到未预加载的 clip                  |
| `loading` (self)    | `RELOAD_ACTIVE`    | reloadGuard       | —                                      |
| `loading` (self)    | `LOAD_SUCCESS`     | inactiveGuard     | 记录 inactive slot 加载完成            |
| `loading` (self)    | `ERROR`            | inactiveGuard     | inactive slot 出错 → 丢弃              |

### 4.3 `loadedPendingSeek`

| 目标                       | Action             | Guard           | 说明                       |
| -------------------------- | ------------------ | --------------- | -------------------------- |
| `loading`                  | `SEEK_TO_CLIP`     | missGuard       | 切换到未预加载的 clip      |
| `loading`                  | `RELOAD_ACTIVE`    | reloadGuard     | 重载当前 clip              |
| `seeking`                  | `SEEK_APPLIED`     | playGuard       | seek 已提交 + wantPlaying  |
| `ready`                    | `SEEK_APPLIED`     | pauseGuard      | seek 已提交 + !wantPlaying |
| `error`                    | `ERROR`            | activeGuard     | —                          |
| `loadedPendingSeek` (self) | `SET_SEEKING`      | —               | —                          |
| `loadedPendingSeek` (self) | `PRELOAD_SLOT`     | preloadGuard    | —                          |
| `loadedPendingSeek` (self) | `BUFFER`           | activeGuard     | —                          |
| `loadedPendingSeek` (self) | `SET_PLAYING`      | —               | —                          |
| `loadedPendingSeek` (self) | `SEEK_WITHIN_CLIP` | —               | 覆盖当前 seek 目标         |
| `loadedPendingSeek` (self) | `SEEK_TO_CLIP`     | hitGuard        | 切换到已预加载的 clip      |
| `loadedPendingSeek` (self) | `LOAD_SUCCESS`     | active/inactive | —                          |
| `loadedPendingSeek` (self) | `ERROR`            | inactiveGuard   | —                          |

**设计意图：** 此 phase 的唯一出口是 `SEEK_APPLIED`（由 seek effect 在 `player.seek()` 后 dispatch）。seek effect 只在 `phase === 'loadedPendingSeek'` 时触发。

### 4.4 `seeking`

| 目标                | Action             | Guard                 | 说明                            |
| ------------------- | ------------------ | --------------------- | ------------------------------- |
| `loadedPendingSeek` | `SEEK_WITHIN_CLIP` | —                     | 再次 seek 当前 clip             |
| `loadedPendingSeek` | `SEEK_TO_CLIP`     | hitGuard              | seek 到已预加载的 clip          |
| `loadedPendingSeek` | `END`              | endHitSeekingGuard    | clip 结束 + 有下一段 + 已预加载 |
| `loading`           | `SEEK_TO_CLIP`     | missGuard             | —                               |
| `loading`           | `RELOAD_ACTIVE`    | reloadGuard           | —                               |
| `loading`           | `END`              | endMissSeekingGuard   | clip 结束 + 有下一段 + 未预加载 |
| `ready`             | `SET_PLAYING`      | pauseGuard            | 用户暂停                        |
| `ready`             | `PROGRESS`         | progressGuard         | 首个 PROGRESS 确认 seek 完成    |
| `ended`             | `END`              | endNoNextSeekingGuard | clip 结束 + 无下一段            |
| `error`             | `ERROR`            | activeGuard           | —                               |
| `seeking` (self)    | `SET_SEEKING`      | —                     | —                               |
| `seeking` (self)    | `PRELOAD_SLOT`     | preloadGuard          | —                               |
| `seeking` (self)    | `BUFFER`           | activeGuard           | —                               |
| `seeking` (self)    | `SET_PLAYING`      | playGuard             | 只接受播放（暂停 → ready）      |
| `seeking` (self)    | `LOAD_SUCCESS`     | active/inactive       | —                               |
| `seeking` (self)    | `ERROR`            | inactiveGuard         | —                               |

**设计意图：** seeking 是 seek 完成后的"确认等待"阶段。首个 PROGRESS 将状态带到 `ready`。在 seeking 中再次 seek 会回到 `loadedPendingSeek`。

### 4.5 `ready`

| 目标                | Action             | Guard           | 说明                            |
| ------------------- | ------------------ | --------------- | ------------------------------- |
| `loading`           | `SEEK_TO_CLIP`     | missGuard       | —                               |
| `loading`           | `RELOAD_ACTIVE`    | reloadGuard     | —                               |
| `loading`           | `END`              | endMissGuard    | clip 结束 + 有下一段 + 未预加载 |
| `loadedPendingSeek` | `SEEK_WITHIN_CLIP` | —               | —                               |
| `loadedPendingSeek` | `SEEK_TO_CLIP`     | hitGuard        | —                               |
| `loadedPendingSeek` | `END`              | endHitGuard     | clip 结束 + 有下一段 + 已预加载 |
| `ended`             | `END`              | endNoNextGuard  | clip 结束 + 无下一段            |
| `error`             | `ERROR`            | activeGuard     | —                               |
| `ready` (self)      | `SET_SEEKING`      | —               | —                               |
| `ready` (self)      | `PRELOAD_SLOT`     | preloadGuard    | —                               |
| `ready` (self)      | `BUFFER`           | activeGuard     | —                               |
| `ready` (self)      | `SET_PLAYING`      | —               | —                               |
| `ready` (self)      | `LOAD_SUCCESS`     | active/inactive | —                               |
| `ready` (self)      | `PROGRESS`         | progressGuard   | 正常进度更新                    |
| `ready` (self)      | `ERROR`            | inactiveGuard   | —                               |

### 4.6 `ended`

| 目标                | Action             | Guard           | 说明                |
| ------------------- | ------------------ | --------------- | ------------------- |
| `loading`           | `SEEK_TO_CLIP`     | missGuard       | —                   |
| `loading`           | `RELOAD_ACTIVE`    | reloadGuard     | —                   |
| `loadedPendingSeek` | `SEEK_WITHIN_CLIP` | —               | 重新 seek 当前 clip |
| `loadedPendingSeek` | `SEEK_TO_CLIP`     | hitGuard        | —                   |
| `error`             | `ERROR`            | activeGuard     | —                   |
| `ended` (self)      | `SET_SEEKING`      | —               | —                   |
| `ended` (self)      | `PRELOAD_SLOT`     | preloadGuard    | —                   |
| `ended` (self)      | `SET_PLAYING`      | pauseGuard      | 只接受暂停          |
| `ended` (self)      | `LOAD_SUCCESS`     | active/inactive | —                   |
| `ended` (self)      | `ERROR`            | inactiveGuard   | —                   |

**设计意图：** ended 不接受 `SET_PLAYING true` — 用户必须 seek 才能恢复播放。

### 4.7 `error`

| 目标                | Action             | Guard           | 说明                      |
| ------------------- | ------------------ | --------------- | ------------------------- |
| `loading`           | `SEEK_TO_CLIP`     | missGuard       | —                         |
| `loading`           | `RELOAD_ACTIVE`    | reloadGuard     | —                         |
| `loadedPendingSeek` | `SEEK_WITHIN_CLIP` | —               | seek 当前 clip 以恢复     |
| `loadedPendingSeek` | `SEEK_TO_CLIP`     | hitGuard        | —                         |
| `error` (self)      | `SET_SEEKING`      | —               | —                         |
| `error` (self)      | `PRELOAD_SLOT`     | preloadGuard    | —                         |
| `error` (self)      | `SET_PLAYING`      | pauseGuard      | 只接受暂停                |
| `error` (self)      | `LOAD_SUCCESS`     | active/inactive | —                         |
| `error` (self)      | `ERROR`            | activeGuard     | 更新 active slot 错误信息 |
| `error` (self)      | `ERROR`            | inactiveGuard   | inactive slot 出错 → 丢弃 |

**设计意图：** error 不接受 `SET_PLAYING true` — 用户必须 seek（`SEEK_WITHIN_CLIP` / `SEEK_TO_CLIP` / `RELOAD_ACTIVE`）才能恢复。

---

## 5. Seek 完整流程

### 5.1 段内 seek（SEEK_WITHIN_CLIP）

```
用户拖动 scrubber
    │
    ├─ SET_SEEKING(true)          ← isSeeking = true（gate PROGRESS/END）
    │
    ▼
用户松手
    │
    ├─ SEEK_WITHIN_CLIP(time)     ← seekToken++, pendingSeekTime = time
    │                                phase → loadedPendingSeek
    │
    ▼
seek effect 触发
    │
    ├─ player.seek(time)
    ├─ SEEK_APPLIED(seekToken)    ← isSeeking = false, seekJustApplied = true
    │                                appliedSeekToken = seekToken
    │                                phase → seeking (if wantPlaying) 或 ready (if !wantPlaying)
    ▼
首个 PROGRESS 到达
    │
    ├─ progressGuard 检查:
    │    ✓ activeGuard
    │    ✓ !isSeeking
    │    ✓ seekToken === appliedSeekToken
    │    ✓ currentIndex === clipIdx
    │    ✓ !(target > EPS && t < target - EPS)     ← 下界检查
    │    ✓ !(seekJustApplied && t > target + 1.5)  ← 上界检查（仅 settling 窗口）
    │
    ├─ progressPatch:             ← seekJustApplied = false
    │                                currentTime = t
    │                                phase → ready (if seeking) 或 stays ready
    ▼
正常播放
```

### 5.2 跨 clip seek（SEEK_TO_CLIP）

**Hit（目标已预加载）：**

```
SEEK_TO_CLIP(nextIdx, time, uri)
    │
    ├─ seekToClipHitGuard: inactive slot 已加载目标 clip
    ├─ seekToClipHitPatch: activeSlot = inactive, seekToken++, pendingSeekTime = time
    │                      currentIndex = nextIdx, currentTime = time
    │                      phase → loadedPendingSeek
    ▼
seek effect → SEEK_APPLIED → seeking/ready → PROGRESS → ready
```

**Miss（目标未预加载）：**

```
SEEK_TO_CLIP(nextIdx, time, uri)
    │
    ├─ seekToClipMissGuard: inactive slot 未加载目标 clip
    ├─ seekToClipMissPatch: activeSlot = inactive, slots[inactive] = new clip
    │                       isLoading = true, needsProgressClear = true
    │                       seekToken++, pendingSeekTime = time
    │                       phase → loading
    ▼
LOAD_SUCCESS → loadedPendingSeek → seek effect → SEEK_APPLIED → seeking → PROGRESS → ready
```

---

## 6. Clip 切换流程（onEnd）

```
onEnd 触发
    │
    ├─ 前置检查:
    │    ✓ isValidActiveEvent (slot, clipIdx, uri, loadKey 匹配)
    │    ✓ !isSeeking
    │    ✓ phase === 'ready' 或 'seeking'
    │    ✓ 若 seeking: seekToken === appliedSeekToken (seek 已 settle)
    │    ✓ 若 seekJustApplied: currentTime >= clipDuration - 1.5 (nearEnd 检查)
    │
    ▼
dispatch END
    │
    ├─ 有下一段？
    │    ├─ 是 + 已预加载 → endHitGuard → endHitPatch
    │    │    activeSlot = inactive, currentIndex = nextIdx, currentTime = 0
    │    │    seekToken++, pendingSeekTime = 0
    │    │    phase → loadedPendingSeek
    │    │
    │    ├─ 是 + 未预加载 → endMissGuard → endMissPatch
    │    │    activeSlot = inactive, slots[inactive] = new clip
    │    │    isLoading = true, seekToken++, pendingSeekTime = 0
    │    │    phase → loading
    │    │
    │    └─ 否（最后一段）→ endNoNextGuard → endEndedPatch
    │         wantPlaying = false, currentTime = clipDuration
    │         sequenceEndCount++
    │         phase → ended
    ▼
（非 ended 分支）seek effect → SEEK_APPLIED → seeking → PROGRESS → ready
```

---

## 7. 错误处理策略

### Active slot 错误

```
ERROR (active) → errorActivePatch → phase: error
    - wantPlaying = false
    - error = e
    - slot 信息保留（不清除）
```

**恢复方式：**

- `RELOAD_ACTIVE`：用 cache-bust URL 重载当前 clip
- `SEEK_WITHIN_CLIP`：seek 当前 clip 以重试
- `SEEK_TO_CLIP`：切换到其他 clip

### Inactive slot 错误

```
ERROR (inactive) → errorInactivePatch → phase 不变（self-cell）
    - slots[inactive] = null       ← slot 被丢弃
    - slotLoadedKey[inactive] = null
    - error 不记录（静默处理）
```

**自动重试：** preload effect 会在下次 render 检测到 `slots[inactive] === null`，重新 dispatch `PRELOAD_SLOT`。如果是瞬时错误（网络抖动），重试会成功；如果是永久错误，会形成重试循环，但不会影响当前播放。当当前 clip 播放完毕时，`endMissPatch` 会将目标 clip 设为 active slot，此时加载失败会通过 `errorActivePatch` 正常上报。

---

## 8. `seekJustApplied` 机制详解

### 生命周期

| 时刻          | 事件                                        | seekJustApplied | 说明                         |
| ------------- | ------------------------------------------- | --------------- | ---------------------------- |
| 初始          | `initialState()`                            | `false`         | —                            |
| seek 请求     | `seekWithinPatch` / `seekToClipHitPatch` 等 | 不变            | 只递增 seekToken             |
| seek 提交     | `seekAppliedPatch`                          | `true`          | seek 已交给 native player    |
| 首个 PROGRESS | `progressPatch`                             | `false`         | native seek 完成，时间已确认 |
| 其他 patch    | —                                           | 保持原值        | 通过 spread 保留             |

### 作用

1. **progressGuard 上界检查**（仅 `seekJustApplied = true` 时生效）：

   ```ts
   if (s.seekJustApplied && t > target + MAX_PROGRESS_STEP) return false;
   ```

   拒绝 stale PROGRESS 事件（时间远超当前 currentTime）。仅在 settling 窗口启用，不影响正常播放中的合法长跳转。

2. **onEnd nearEnd 检查**（仅 `seekJustApplied = true` 时生效）：
   ```ts
   if (s.seekJustApplied) {
     const nearEnd =
       !Number.isFinite(cd) || cd <= 0 || s.currentTime >= cd - 1.5;
     if (!nearEnd) return;
   }
   ```
   拒绝 stale END 事件（currentTime 不在 clip 末尾附近）。如果用户 seek 到末尾附近，END 仍然被接受。

### 不会卡住的证明

`seekJustApplied` 唯一可能"卡住"的场景是 `wantPlaying = false`（暂停）时没有 PROGRESS 来清除它。但：

- 暂停时 native player 不会发 PROGRESS 或 END
- 用户恢复播放后，首个 PROGRESS 会清除标志
- 标志为 true 期间，如果有 PROGRESS 到来（非标准行为），上界检查只拒绝时间偏差 >1.5s 的事件，正常偏差不会被拒绝

---

## 9. 双播放器预加载系统

### Slot 轮转

```
activeSlot = 0 (播放 clip 0)     inactiveSlot = 1 (预加载 clip 1)
         │                              │
         ▼                              ▼
    onEnd clip 0 → endHitPatch
         │
         ├─ activeSlot = 1 (播放 clip 1)
         │
         ▼
    preload effect → PRELOAD_SLOT(slot=0, clip 2)
         │
         ▼
activeSlot = 1 (播放 clip 1)     inactiveSlot = 0 (预加载 clip 2)
```

### videoSlots memo 优化

`videoSlots` memo 的依赖项经过优化，仅包含构造 Video props 所需的最小 state 子集：

```ts
}, [
  durations,           // onEnd 中读取 clipDuration
  onClipEnd,           // onEnd 中回调
  playerRefs,          // ref 属性
  recordDuration,      // onLoad 中回调
  state.activeSlot,    // isActive 判断
  state.phase,         // shouldPauseActive 判断
  state.slots,         // slot info（source uri 等）
  state.wantPlaying,   // shouldPauseActive 判断
  stateRef,            // onEnd 中读取最新 state
  urls,                // onEnd 中读取 nextUri
]);
```

**关键优化：** PROGRESS 事件改变 `currentTime`、`times`、`playedSeconds`、`isLoading`、`needsProgressClear`、`pendingSeekTime`、`seekJustApplied` — 这些都不在 memo 依赖中。因此 PROGRESS 不会触发 `videoSlots` 重算，避免两个 `<Video>` 组件不必要地重渲染。所有事件处理器通过 `stateRef.current` 在事件发生时读取最新状态。
