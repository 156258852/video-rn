# useVideoSequencePlayer 状态机文档

本文档描述 `hooks/useVideoSequencePlayer.ts` 中的有限状态机（FSM）设计。

在阅读前，先明确一个核心点：本状态机包含两个**正交维度**。

1. **Playback Phase**：`idle / loading / loadedPendingSeek / seeking / ready / ended / error`
2. **User Gesture State**：`isSeeking`

也就是说：`phase === 'seeking'` **不等于** `isSeeking === true`。

- `phase === 'seeking'` 表示 seek 已 **applied**，正在等待首个有效 `PROGRESS` 做确认
- `isSeeking === true` 表示用户当前正在拖动 scrubber，这只是一个手势态，用于 gate `PROGRESS / END`

---

## 1. 七个阶段（Phase）

| Phase               | 含义                                                      | 是否接受 PROGRESS | 是否接受 END                                                           |
| ------------------- | --------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `idle`              | 无 clip 加载（urls 为空或首次 INIT 前）                   | ✗                 | ✗                                                                      |
| `loading`           | active slot 正在加载 clip，等待 `onLoad`                  | ✗                 | ✗                                                                      |
| `loadedPendingSeek` | clip 已加载，有 pending seek 等待执行                     | ✗                 | ✗                                                                      |
| `seeking`           | seek 已 applied（`SEEK_APPLIED`），等待首个 PROGRESS 确认 | ✓                 | ✓（需 seek 已 applied；首个 PROGRESS 前额外受 `seekJustApplied` 保护） |
| `ready`             | 正常播放中，PROGRESS / END 正常处理                       | ✓                 | ✓                                                                      |
| `ended`             | 最后一段播放完毕，等待用户 seek / reload 恢复             | ✗                 | ✗                                                                      |
| `error`             | active slot 发生错误，等待用户 seek / reload 恢复         | ✗                 | ✗                                                                      |

---

## 2. 总状态图（鸟瞰）

```text
                    INIT(urls[0])
               +--------------------+
               |                    v
             idle -- SEEK_TO_CLIP(hit) ------------------------------> loadedPendingSeek
               |                                                      |
               | SEEK_TO_CLIP(miss) / RELOAD_ACTIVE                   | SEEK_APPLIED
               v                                                      v
            loading -- LOAD_SUCCESS(hasPending) --> loadedPendingSeek --> seeking -- PROGRESS --> ready
               |                                         ^                 |                     |
               | LOAD_SUCCESS(noPending)                 |                 | SET_PLAYING(false)  |
               v                                         |                 v                     |
             ready -- SEEK_WITHIN_CLIP / SEEK_TO_CLIP(hit) --------------> loadedPendingSeek    |
               | -- SEEK_TO_CLIP(miss) / RELOAD_ACTIVE -----------------> loading               |
               | -- END(next, hit) -------------------------------------> loadedPendingSeek      |
               | -- END(next, miss) ------------------------------------> loading               |
               | -- END(last) ------------------------------------------> ended                 |
               | -- ERROR(active) --------------------------------------> error                 |
               |
            seeking -- END(next, hit) ---------------------------------> loadedPendingSeek
               | -- END(next, miss) -----------------------------------> loading
               | -- END(last) -----------------------------------------> ended
               | -- ERROR(active) -------------------------------------> error

            ended -- SEEK_WITHIN_CLIP / SEEK_TO_CLIP(hit) -----------> loadedPendingSeek
               | -- SEEK_TO_CLIP(miss) / RELOAD_ACTIVE -------------> loading

            error -- SEEK_WITHIN_CLIP / SEEK_TO_CLIP(hit) -----------> loadedPendingSeek
               | -- SEEK_TO_CLIP(miss) / RELOAD_ACTIVE -------------> loading
```

### 如何读这张图

- 这张图只展示**主干路径**，省略了 self-transition（如 `SET_SEEKING`、`PRELOAD_SLOT`、部分 `LOAD_SUCCESS/ERROR` 记录型规则）
- `loadedPendingSeek → seeking/ready` 取决于 `SEEK_APPLIED` 时的 `wantPlaying`
- `seeking → ready` 的语义是：seek 已 **confirmed**（首个有效 `PROGRESS` 到达）
- `idle` / `ended` / `error` 都可能通过 `SEEK_TO_CLIP(hit)` 直接进入 `loadedPendingSeek`；只有 miss seek 或 `RELOAD_ACTIVE` 才进入 `loading`
- 其中 `idle -> SEEK_TO_CLIP(hit) -> loadedPendingSeek` 属于**特殊但合法**的恢复路径，并不是常规 INIT 主路径；常规首次进入播放通常仍是 `INIT -> loading`
- `ended` / `error` 都不能通过 `SET_PLAYING(true)` 直接恢复；必须经由 seek 或 reload 离开
- `END` 从 `ready` 和 `seeking` 都可能发生；有下一段时，preload hit → `loadedPendingSeek`，preload miss → `loading`
- 在 `seeking` 中处理 `END` 时，只要求 seek 已 **applied**，并额外受 `seekJustApplied` 保护

---

## 3. 2D 转移矩阵结构

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
  if (action.type === 'INIT') {
    return initFromAction(action as AInit);
  }
  const row = TRANSITIONS[state.phase];
  if (!row) {
    return state;
  }
  const matched = PHASE_ORDER.reduce<{to: Phase; rule: Rule} | null>(
    (acc, to) => {
      if (acc) return acc;

      const rule = row[to]?.find(r => {
        if (r.action !== action.type) return false;
        if (r.guard && !r.guard(state, action)) return false;
        return true;
      });

      return rule ? {to, rule} : null;
    },
    null,
  );

  if (!matched) {
    return state;
  }

  return {
    ...state,
    ...matched.rule.patch(state, action),
    phase: matched.to,
  };
}
```

**关键特性：**

- reducer 按 `PHASE_ORDER` 顺序扫描目标 phase，并在每个 cell 内查找第一个匹配（action + guard）的规则
- 一旦找到首个匹配规则，就停止搜索；后续 phase / 规则不再检查
- 对角线单元格（`to === from`）持有"仅副作用"规则，不改变 phase
- 空单元格或 guard 全部不通过 = 非法/不适用转移，action 被静默丢弃

---

## 4. 关键状态字段

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

### applied vs confirmed

- **seek 已 applied**：`seekToken === appliedSeekToken`，表示 seek 已经提交给 native player
- **seek 已 confirmed**：首个符合 `progressGuard` 的 `PROGRESS` 已到达；此时 `seekJustApplied` 会被清除，`seeking → ready`

文档后文中：

- 若写“已 applied”，指 token 已对齐
- 若写“已 confirmed / 已完成确认”，指首个有效 `PROGRESS` 已到达

### 三层 stale event 防御

| 层                               | 生效区间                       | 防御对象                              | 机制                                            |
| -------------------------------- | ------------------------------ | ------------------------------------- | ----------------------------------------------- |
| `isSeeking`                      | 拖动开始 → `SEEK_APPLIED`      | PROGRESS + END                        | `progressGuard` 和 `onEnd` 检查 `s.isSeeking`   |
| `seekToken !== appliedSeekToken` | seek dispatch → `SEEK_APPLIED` | PROGRESS + END                        | `progressGuard` 检查 token 匹配                 |
| `seekJustApplied`                | `SEEK_APPLIED` → 首个 PROGRESS | stale PROGRESS（时间偏差）+ stale END | `progressGuard` 上界检查 + `onEnd` nearEnd 检查 |

---

### Slot 管理字段

| 字段            | 类型                               | 说明                                                             |
| --------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `slots`         | `[SlotInfo\|null, SlotInfo\|null]` | 各 slot 的当前分配信息 `{clipIdx, uri, loadKey}`                 |
| `slotLoadedKey` | `[number\|null, number\|null]`     | 各 slot 最后一次成功加载时的 loadKey；PRELOAD_SLOT 时重置为 null |
| `loadKeySeed`   | number                             | 单调递增种子，每次分配 slot 时 +1 生成新 loadKey                 |

**`loadSuccessInactiveRecordGuard` 逻辑：**

- `isValidAssignedEvent` 验证事件的 `{slot, clipIdx, uri, loadKey}` 完全匹配当前 slot 分配
- `act.slot !== activeSlot` 确保只处理 inactive slot
- `act.loadKey > (slotLoadedKey[slot] ?? 0)` 单调递增校验，防止重复记录同一事件

---

## 5. 各 Phase 的转移规则

### 5.1 `idle`

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

### 5.2 `loading`

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

**设计意图：** `loading` 阶段会让 active slot 保持 **unpaused**。这是一个兼容性选择：某些视频实现如果组件处于 paused 状态，可能不会稳定触发 `onLoad`。因此本 hook 在 `loading` 时不依赖 `wantPlaying` 来 pause active slot，而是优先保证 load 回调能到达。

### 5.3 `loadedPendingSeek`

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

**设计意图：** 此 phase 的正常推进出口是 `SEEK_APPLIED`（由 seek effect 在 `player.seek()` 后 dispatch）。但如果用户再次 seek 到未预加载 clip、触发 `RELOAD_ACTIVE`，或 active slot 发生错误，也可能分别转到 `loading` 或 `error`。seek effect 只在 `phase === 'loadedPendingSeek'` 时触发。

### 5.4 `seeking`

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

**设计意图：** seeking 是 seek **已 applied 但尚未 confirmed** 的“确认等待”阶段。此时 `seekToken === appliedSeekToken` 已成立，但 `seekJustApplied` 仍为 `true`，直到首个有效 `PROGRESS` 到达才会清除，并将状态带到 `ready`。因此 `seeking` 中的 `END` 并不要求“首个 PROGRESS 已到达”，只要求 seek 已 applied；额外的 stale END 防御由 `seekJustApplied` + nearEnd 检查承担。在 seeking 中再次 seek 会回到 `loadedPendingSeek`。

### 5.5 `ready`

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

### 5.6 `ended`

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

**设计意图：** ended 不接受 `SET_PLAYING true` — 用户必须通过 seek 或 `RELOAD_ACTIVE` 才能恢复播放。

### 5.7 `error`

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

**设计意图：** error 不接受 `SET_PLAYING true` — 用户必须通过 seek 或 `RELOAD_ACTIVE` 才能恢复。

---

## 6. Seek 完整流程

### 6.1 段内 seek（SEEK_WITHIN_CLIP）

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

### 6.2 跨 clip seek（SEEK_TO_CLIP）

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

## 7. Clip 切换流程（onEnd）

```
onEnd 触发
    │
    ├─ 前置检查:
    │    ✓ isValidActiveEvent (slot, clipIdx, uri, loadKey 匹配)
    │    ✓ !isSeeking
    │    ✓ phase === 'ready' 或 'seeking'
    │    ✓ 若 seeking: seekToken === appliedSeekToken (seek 已 applied，token 已对齐)
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

补充说明：在 `seeking` 中收到 `END` 是允许的。典型场景是用户 seek 到片尾附近，native player 在首个 `PROGRESS` 到达前就直接发出 `END`。此时 reducer 只要求 seek 已 applied；是否接受该 `END`，由 `seekJustApplied` 窗口中的 nearEnd 检查进一步决定。

---

## 8. 错误处理策略

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

### Active slot 错误自动重试（hook 层 effect）

状态机本身是被动的（只响应 native 回调），慢网场景下 AVPlayer 可能因网络超时触发 `onError`，导致永久停在 `error`。为此 hook 层提供了一个 **watchdog effect**，在矩阵之外自动恢复：

```
phase === 'error'
    │
    ├─ 等待 ERROR_RETRY_DELAY_MS (3s)
    │
    ├─ 触发时再次确认 phase 仍为 'error'
    │    （用户期间手动 seek 会离开 error，定时器被 cleanup 取消）
    │
    ├─ dispatch RELOAD_ACTIVE（cache-bust URL，从 currentTime 恢复）
    │    → phase: error → loading
    │
    ├─ 若出错前 wantPlaying === true → 追加 dispatch SET_PLAYING(true)
    │    → 加载成功后自动续播，无需用户手动点播放
    │
    └─ 最多重试 MAX_ERROR_RETRIES (3) 次；phase 离开 error 后计数器归零
```

**设计要点：**

- 转移矩阵零改动 — 只使用 `error` 行已有的 `RELOAD_ACTIVE` 出口
- 用户操作优先 — error 期间用户 seek 会离开 error phase，effect cleanup 清除定时器，retry 不会与用户手势冲突
- 播放意图恢复 — `playingBeforeErrorRef` 在非 error 期间持续记录 `wantPlaying`，重试成功后恢复出错前的播放状态
- 有限重试 — 永久错误（如 URL 失效）最多重试 3 次后停止，不会无限循环

### Inactive slot 错误

```
ERROR (inactive) → errorInactivePatch → phase 不变（self-cell）
    - slots[inactive] = null       ← slot 被丢弃
    - slotLoadedKey[inactive] = null
    - error 不记录（静默处理）
```

**自动重试：** preload effect 会在下次 render 检测到 `slots[inactive] === null`，重新 dispatch `PRELOAD_SLOT`。如果是瞬时错误（网络抖动），重试会成功；如果是永久错误，会形成重试循环，但不会影响当前播放。当当前 clip 播放完毕时，`endMissPatch` 会将目标 clip 设为 active slot，此时加载失败会通过 `errorActivePatch` 正常上报。

---

## 9. `seekJustApplied` 机制详解

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

## 10. 调试与观测建议

### 建议记录的最小调试字段

排查时建议至少记录：

- `phase`
- `activeSlot`
- `currentIndex`
- `currentTime`
- `isSeeking`
- `seekToken`
- `appliedSeekToken`
- `seekJustApplied`
- `isLoading`
- `isBuffering`
- `slots[0] / slots[1]` 中的 `{ clipIdx, uri, loadKey }`

### 如何判断事件是不是 stale

`LOAD_SUCCESS / PROGRESS / END / BUFFER / ERROR` 都携带事件身份：

- `slot`
- `clipIdx`
- `uri`
- `loadKey`

判断原则：

1. 先看事件是否仍然属于 `state.slots[slot]`
2. 再看该 `slot` 是否仍是 `activeSlot`
3. 对 `PROGRESS / END` 再叠加 seek 相关 gate：`isSeeking`、`seekToken === appliedSeekToken`、`seekJustApplied`

如果某个事件的 `{ slot, clipIdx, uri, loadKey }` 与当前 `state.slots[slot]` 不一致，它就是旧 clip / 旧 load 实例发出的 stale event，应被 reducer 或 handler 丢弃。

### 常见排查路径

- **一直停在 `loading`**：先看 active slot 是否真的发出了 `LOAD_SUCCESS`
- **一直停在 `loadedPendingSeek`**：看 seek effect 是否执行，以及是否 dispatch 了 `SEEK_APPLIED`
- **一直停在 `seeking`**：看首个 `PROGRESS` 是否被 `progressGuard` 拒绝
- **刚 seek 后误触发 `END`**：重点看 `seekJustApplied`、`currentTime` 与 `clipDuration` 的 nearEnd 条件
- **预加载命中失败**：重点看 inactive slot 的 `clipIdx / uri / loadKey` 是否和目标 clip 完全一致，以及 `slotLoadedKey[inactive]` 是否等于 preload 的 `loadKey`

---

## 11. 双播放器预加载系统

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
