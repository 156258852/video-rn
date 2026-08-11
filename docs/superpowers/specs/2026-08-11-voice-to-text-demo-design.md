# Voice-to-Text Demo Design

**Date**: 2026-08-11
**Status**: Draft
**Scope**: 在 StitchRNPOCModern 项目中新增一个独立的「语音转文字」Demo 入口,与现有视频拼接播放逻辑完全隔离。

---

## 1. 背景与目标

### 1.1 背景

项目当前是一个 React Native 0.74 的视频拼接 POC,依赖极简(仅 `react-native-video` + `@react-native-community/slider`),没有任何录音/语音识别库。用户希望新增一个「按住说话 → 文字」的独立 Demo,作为技术验证,也作为未来接入真实业务(如语音输入)的样板。

### 1.2 目标

- 跑通「按住说话 → 系统 ASR → 文字填进可编辑输入框」这条完整链路
- 沉淀一个**可复用的 `useSpeechToText` hook**,遵循项目现有 hooks 模式(`useXxx` 命名、显式 TS 接口、`useRef` 管可变值)
- 与现有播放逻辑**完全隔离**,不碰 `useVideoSequencePlayer` 状态机

### 1.3 非目标(明确不做)

- 不做后台录音
- 不做多语言自动识别(走手动切换)
- 不做录音文件留档
- 不做云端 ASR(无 API Key,走系统 ASR)
- 不做 Android 真机验收(Android 模拟器 `SpeechRecognizer` 不稳定)

---

## 2. 关键技术决策

### 2.1 ASR 走系统端上识别

| 选项 | 评估 | 决定 |
|---|---|---|
| 云端 ASR(Whisper/阿里云等) | 需要 API Key + 本地转发脚本,对 Demo 过重 | ❌ |
| 系统 ASR(`expo-speech-recognition`) | 零 key、零后端、免费;代价是引入 `expo-modules-core` | ✅ |

**理由**:项目无 API Key,云端路线前置成本过高。系统 ASR 在 iOS 模拟器上可直接跑通(需开 Mac 麦克风 + 联网)。

### 2.2 单语言 + 用户可切换

`SFSpeechRecognizer` 一次只能识别一种语言。Demo 提供「中/英」切换按钮,用户说话前手动选,默认 `zh-CN`。

### 2.3 按住说话

采用「按住说话」交互(非点击开始/结束),符合移动端习惯,也避免误触长录音触发 iOS 1 分钟硬限制。

---

## 3. 架构

```
App.tsx
  ├─ renderMissionScreen (现有,不动)
  ├─ 新增「语音 Demo」按钮 → 条件渲染 VoiceInputDemoScreen
  └─ 全屏 Modal (现有,不动)

VoiceInputDemoScreen.tsx (新组件)
  └─ 调用 useSpeechToText hook

hooks/useSpeechToText.ts (新 hook)
  └─ 封装 expo-speech-recognition + 权限 + 状态
```

**依赖方向严格单向**:

```
App.tsx → VoiceInputDemoScreen → useSpeechToText → expo-speech-recognition
```

不引入反向依赖,不触碰 `hooks/useVideoSequencePlayer.ts`、`hooks/useVideoDurations.tsx`、`hooks/useVirtualTimeline.ts`、`hooks/useScrubber.ts`、`hooks/useAutoHideControls.ts`。

---

## 4. 模块设计

### 4.1 `useSpeechToText` hook

**职责**:纯逻辑层,不关心 UI。封装权限请求、录音控制、事件分发、错误归一化。

**接口**:

```ts
type SpeechStatus = 'idle' | 'requesting-permission' | 'listening' | 'error';

interface UseSpeechToTextOptions {
  locale?: 'zh-CN' | 'en-US';
}

interface UseSpeechToTextReturn {
  /** 最终识别文字(松手后稳定) */
  text: string;
  /** 实时中间结果(边说边出字) */
  interimText: string;
  /** 当前状态 */
  status: SpeechStatus;
  /** 归一化错误信息 */
  error: {
    code: 'mic-denied' | 'speech-denied' | 'not-available' | 'network' | 'rate-limited' | 'max-duration' | 'unknown';
    message: string;
  } | null;
  /** 设备是否支持语音识别 */
  isAvailable: boolean;
  /** 开始录音(内部会先请求权限) */
  start: () => Promise<void>;
  /** 停止录音 */
  stop: () => void;
  /** 清空 text 和 interimText */
  reset: () => void;
  /** 切换语言,下次 start 生效 */
  setLocale: (locale: 'zh-CN' | 'en-US') => void;
}

function useSpeechToText(options?: UseSpeechToTextOptions): UseSpeechToTextReturn;
```

**内部实现要点**:

- 用 `useRef` 持有 `locale`、`isListening` 等可变值,避免 `PanResponder` / 事件回调闭包陈旧
- 用 `useState` 暴露 `text`、`interimText`、`status`、`error`
- 通过 `useSpeechRecognitionEvent` 注册 `start` / `end` / `result` / `error` 四个事件
- `start()` 内部顺序:检查 `isAvailable` → `requestPermissionsAsync()` → 检查 granted → `ExpoSpeechRecognitionModule.start({ lang, interimResults: true, continuous: false })`
- 错误码归一化:`not-allowed` 拆成 `mic-denied` / `speech-denied`(根据 `getPermissionsAsync` 二次查询结果);`network` / `no-speech` / `aborted` 等分别映射

### 4.2 `VoiceInputDemoScreen` 组件

**职责**:纯 UI 层,消费 `useSpeechToText`。

**布局**(从上到下):

1. 顶部返回按钮(回到任务屏)
2. 标题「语音识别 Demo」
3. 语言切换按钮(`zh-CN` ↔ `en-US`)
4. 可编辑 `TextInput`(multiline,显示 `text` + `interimText`)
5. 按住说话的按钮(用 `PanResponder`,按住时 `start()`,松手 `stop()`)
6. 底部状态栏(显示 `status` 文案 / `error` 文案 + 引导按钮)

**交互**:

- 按住按钮:按钮高亮(`qi.colors.primary`),状态切 `listening`,TextInput 边说边出字
- 松手:按钮恢复,interimText 合并进 text,状态切 `idle`
- 语言切换:调用 `setLocale`,不中断当前录音
- 错误态:底部状态栏变红,权限被拒显示「去设置」按钮(跳系统设置),其他错误显示「重试」

**样式**:全部走 `theme/qi.ts`,不写裸颜色/间距/圆角/字体。

### 4.3 `App.tsx` 入口改动

最小改动:

- 新增 `showVoiceDemo` state
- 任务屏底部加一个「语音 Demo」按钮,点击 `setShowVoiceDemo(true)`
- 条件渲染 `{showVoiceDemo && <VoiceInputDemoScreen onBack={() => setShowVoiceDemo(false)} />}`

不碰 `renderMissionScreen` 内部,不碰全屏 Modal。

---

## 5. 权限与错误处理

### 5.1 权限

iOS 需要两个独立权限,缺一不可:

| 权限 | 谁要 | 何时弹 |
|---|---|---|
| 麦克风 | 录音 | 首次 `start()` |
| 语音识别 | `SFSpeechRecognizer` | 首次 `start()` |

**处理策略**:

- 首次 `start()` 时依次请求
- 任一被拒 → `status = 'error'`,`error.code = 'mic-denied' | 'speech-denied'`
- UI 显示引导文案 + 「去设置」按钮(调用 `Linking.openSettings()`)
- 用户去系统设置重开后,返回 App 无需重启,下次 `start()` 即可

### 5.2 iOS 硬限制

1. **单次最长约 1 分钟** —— 用户按住超过 1 分钟,系统自动停。hook 检测到 `end` 事件后切回 `idle`,UI 提示「已达最长录音时长」
2. **调用频率限制** —— 频繁触发会报 `SFSpeechRecognizerErrorExceededMaximumConnections`。hook 捕获后 `error.code = 'rate-limited'`,UI 显示「请稍后再试」

### 5.3 模拟器注意事项

- iOS 模拟器借 Mac 麦克风,需在模拟器菜单 **I/O → Input → 勾选 Mac 麦克风**
- 模拟器必须联网(`SFSpeechRecognizer` 在模拟器上走云端)
- 最终效果验收建议真机(麦克风质量、中文识别准确率)

---

## 6. 依赖与原生改动

### 6.1 新增 npm 依赖

```json
{
  "expo-speech-recognition": "^0.2.x"
}
```

`expo-speech-recognition` 会带入 `expo-modules-core`。

### 6.2 原生改动

裸 RN 项目用 `expo-speech-recognition` 需要两步:

**Step A:初始化 expo-modules-core(一次性)**

```bash
npx install-expo-modules
```

这条命令会改 `ios/Podfile` 和 `ios/StitchRNPOCModern/AppDelegate.mm`(加 Expo 启动代码)。这是一次性成本,之后所有 Expo 模块都能直接用。

**Step B:配置权限字符串**

手动在 `ios/StitchRNPOCModern/Info.plist` 加两条权限描述:

- `NSMicrophoneUsageDescription` —— 麦克风权限文案
- `NSSpeechRecognitionUsageDescription` —— 语音识别权限文案

(如果用 Expo 项目结构,这两条由 config plugin 自动加;裸 RN 项目需手动加。)

**注意**:不引入 `app.json` 的 `expo.plugins` 字段 —— 那是 Expo 项目的写法,裸 RN 项目不需要。

### 6.3 构建步骤

```bash
npm install expo-speech-recognition
cd ios && pod install && cd ..
npx react-native run-ios --simulator "iPhone 17 Pro"
```

---

## 7. 测试与验收

### 7.1 验收清单

- [ ] iOS 模拟器上按住按钮说话,能出文字(中文 + 英文分别验证)
- [ ] 切换语言后,下次录音识别对应语言
- [ ] 拒绝麦克风权限后,UI 显示「去设置」按钮,点击跳系统设置
- [ ] 拒绝语音识别权限后,同上
- [ ] 按住超过 1 分钟,自动停止并提示
- [ ] 连续快速触发多次,触发频率限制时显示「请稍后再试」
- [ ] 识别结果填入可编辑 `TextInput`,可手动修改
- [ ] 返回按钮回到任务屏,不残留录音状态
- [ ] 现有视频播放流程完全不受影响(任务屏、全屏 Modal 均正常)

### 7.2 不做

- 不写单元测试(hook 依赖原生事件,单测价值低)
- 不做 E2E 测试

---

## 8. 取舍记录

| 决策 | 选 | 不选 | 原因 |
|---|---|---|---|
| ASR 位置 | 系统端上 | 云端 API | 无 API Key,云端需本地转发脚本,对 Demo 过重 |
| 语言 | 单语言 + 手动切换 | 多语言自动识别 | iOS 17+ 才有 `possibleLanguages`,老系统不支持;自动识别对 Demo 过度设计 |
| 交互 | 按住说话 | 点击开始/结束 | 移动端习惯,避免误触长录音触发 1 分钟限制 |
| 入口位置 | 任务屏下方独立按钮 | Tab / 独立路由 | 改动最小,不引入导航库 |
| 隔离 | 完全独立新文件 | 扩展现有 hook | 不动状态机,符合项目「无 bug 不重构」原则 |
| 原生改动 | Expo config plugin | 手动改 Podfile/AppDelegate | 自动化,可重复生成 |

---

## 9. 风险与未决

- **expo-modules-core 引入**:会让 Podfile 变长,但通过 config plugin 自动处理,用户无感。diff 会变大,需提前告知用户哪些行是 Expo 加的。
- **模拟器稳定性**:偶尔 `SFSpeechRecognizer` 在模拟器上会玄学失败,不代表代码错。验收仍以真机为准。
- **`expo-speech-recognition` 版本**:需锁定 `^0.2.x`(当前活跃维护版本),避免装到老版 `@react-native-voice/voice`。
