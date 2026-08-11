# WebView 语音转文字 Bridge 设计

**Date**: 2026-08-11
**Status**: Draft
**Scope**: H5 页面运行在 RN 的 WebView 中,通过 bridge 借用 RN 的原生语音识别能力,实现"按住说话 → 文字"。

---

## 1. 背景:为什么 H5 自己做不了

H5 页面运行在 RN 的 **WKWebView(iOS) / WebView(Android)** 中,这是一个**沙盒环境**:

- ❌ 拿不到原生权限(麦克风、语音识别)
- ❌ 调不到系统 ASR(SFSpeechRecognizer / SpeechRecognizer)
- ❌ Web Speech API (`webkitSpeechRecognition`) 在 iOS WKWebView 中**基本被禁用**,在 Android WebView 中依赖 Google 服务、不稳定

**结论**:H5 在 WebView 里**没有**语音识别能力,必须通过 bridge 借用 RN 的原生能力。这是技术上的唯一路径,不是设计选择。

---

## 2. 整体架构

```
┌─────────────────────────────────┐
│  H5 (在 RN 的 WebView 里)        │
│                                  │
│  UI 层:                          │
│   - 按住说话的按钮                │
│   - 实时显示识别文字(草稿 + 定稿) │
│   - 可编辑输入框                  │
│   - 状态 / 错误提示               │
│                                  │
│  通信层:                         │
│   - 发:window.ReactNativeWebView │
│       .postMessage(JSON字符串)   │
│   - 收:window.onSpeechEvent()   │
│       (RN 注入的全局函数)        │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  RN 侧                          │
│                                  │
│  WebView 容器组件:               │
│   - onMessage 收 H5 指令         │
│   - webViewRef.injectJavaScript  │
│     推事件给 H5                  │
│                                  │
│  useSpeechToText hook:           │
│   - 权限请求                     │
│   - 调系统 ASR                   │
│   - 把事件转成统一格式推回 H5    │
└─────────────────────────────────┘
```

**一句话**:H5 是前端,RN 是"带麦克风的后端"。两边通过 JSON 消息通信。

---

## 3. 接口契约(核心)

### 3.1 H5 → RN(发指令)

H5 通过 `window.ReactNativeWebView.postMessage(JSON.stringify(msg))` 发消息。**只能发字符串**,发对象会静默失败。

| msg.type       | 触发时机 | payload                        |
| -------------- | -------- | ------------------------------ |
| `speech:start` | 按钮按下 | `{locale: 'zh-CN' \| 'en-US'}` |
| `speech:stop`  | 按钮松开 | 无                             |

> 注意:没有 `speech:check` 之类的"探路"消息。H5 直接显示按钮,用户按下后如果设备不支持,RN 会回 `error: not-available`,H5 按错误处理即可。少一次 bridge 往返,逻辑更简单。

### 3.2 RN → H5(推事件)

RN 通过 `webViewRef.injectJavaScript(...)` 调 H5 全局函数 `window.onSpeechEvent(data)`。

| data.type | 触发时机             | data 字段                                                               |
| --------- | -------------------- | ----------------------------------------------------------------------- |
| `status`  | 状态变化             | `{status: 'idle' \| 'requesting-permission' \| 'listening' \| 'error'}` |
| `interim` | 边说边出字(中间结果) | `{text: '...'}`                                                         |
| `final`   | 一句话结束(最终结果) | `{text: '...'}`                                                         |
| `error`   | 出错                 | `{code: '...', message: '...'}`                                         |

**为什么拆这么多事件,不直接一个 `result`?**

因为 H5 要"边说边出字" —— 中间结果(`interim`)要实时推,最终结果(`final`)才稳定。H5 拿到 `interim` 显示成灰色草稿,拿到 `final` 才定稿。

### 3.3 错误码

| code            | 含义                   | H5 推荐处理                |
| --------------- | ---------------------- | -------------------------- |
| `mic-denied`    | 麦克风权限被拒         | 显示"去设置"引导           |
| `speech-denied` | 语音识别权限被拒       | 显示"去设置"引导           |
| `not-available` | 设备不支持             | 显示“此设备不支持语音识别” |
| `network`       | 网络错误(模拟器需联网) | 显示"请检查网络"           |
| `rate-limited`  | iOS 调用频率限制       | 显示"请稍后再试"           |
| `max-duration`  | 超过 iOS 1 分钟硬限制  | 显示"已达最长录音时长"     |
| `unknown`       | 其他                   | 显示 message               |

---

## 4. H5 侧职责

### 4.1 挂载时:注册接收函数(只做一次)

```js
useEffect(() => {
  window.onSpeechEvent = data => {
    switch (data.type) {
      case 'interim':
        setDraft(data.text);
        break;
      case 'final':
        appendFinal(data.text);
        setDraft('');
        break;
      case 'error':
        showError(data.message);
        break;
      case 'status':
        setStatus(data.status);
        break;
    }
  };

  return () => {
    // 卸载时清理,避免内存泄漏
    window.onSpeechEvent = null;
    // 同时发 stop,防止 RN 那边还在录音
    window.ReactNativeWebView.postMessage(
      JSON.stringify({type: 'speech:stop'}),
    );
  };
}, []);
```

### 4.2 按钮交互

```jsx
<button
  onTouchStart={() => post({type: 'speech:start', locale: 'zh-CN'})}
  onTouchEnd={() => post({type: 'speech:stop'})}
  onMouseDown={...}   // PC 调试用
  onMouseUp={...}
>
  {status === 'listening' ? '识别中...' : '按住说话'}
</button>

function post(msg) {
  window.ReactNativeWebView.postMessage(JSON.stringify(msg));
}
```

> 按钮**始终显示**,不要做"先探路再决定显隐"。设备不支持的情况,用户按下后会收到 `error: not-available`,按 §4.4 错误处理即可。

### 4.3 显示识别结果

```jsx
<div>
  {finalText}
  <span style={{color: '#999'}}>{draft}</span> {/* 中间结果 */}
</div>
```

### 4.4 错误处理

按 §3.3 错误码分别处理。权限被拒时,引导用户去系统设置(RN 侧会提供跳转入口,或 H5 自己用 `location.href = 'app-settings:'` 跳)。

### 4.5 生命周期兜底

- `visibilitychange` / `pagehide` → 发 `speech:stop`,避免后台录音
- 组件 unmount → 清 `window.onSpeechEvent` + 发 `speech:stop`

---

## 5. RN 侧职责

### 5.1 WebView 容器组件

```jsx
<WebView
  source={{uri: 'https://your-h5-url'}}
  onMessage={e => {
    const msg = JSON.parse(e.nativeEvent.data);
    switch (msg.type) {
      case 'speech:start':
        speech.start(msg.locale);
        break;
      case 'speech:stop':
        speech.stop();
        break;
    }
  }}
  ref={webViewRef}
/>
```

### 5.2 把 hook 事件桥接到 H5

`useSpeechToText` hook 暴露 `text`、`interimText`、`status`、`error`、`isAvailable`。容器组件用 `useEffect` 监听前四个变化,一变就推给 H5(`isAvailable` 只在 RN 本地用,不通过 bridge 推):

```js
useEffect(() => {
  if (interimText) pushToH5({type: 'interim', text: interimText});
}, [interimText]);

useEffect(() => {
  pushToH5({type: 'status', status});
}, [status]);

useEffect(() => {
  if (error)
    pushToH5({type: 'error', code: error.code, message: error.message});
}, [error]);
```

### 5.3 `pushToH5` 实现

```js
const pushToH5 = data => {
  webViewRef.current?.injectJavaScript(
    `window.onSpeechEvent && window.onSpeechEvent(${JSON.stringify(
      data,
    )}); true;`,
  );
};
```

**关键点**:

- `injectJavaScript` 里的代码是**字符串**,必须用 `JSON.stringify` 转义 data,避免引号 / 换行把 JS 字符串打断
- 末尾的 `true;` 是 WebView 约定,防止返回值被当作持续脚本
- `window.onSpeechEvent &&` 做防御性检查,避免 H5 还没注册就推事件导致报错

### 5.4 权限懒加载

首次收到 `speech:start` 时再请求权限,不要 WebView 一挂载就弹 —— 用户体验差。

---

## 6. iOS 配置

- `Info.plist` 加两条权限字符串:
  - `NSMicrophoneUsageDescription`
  - `NSSpeechRecognitionUsageDescription`
- 依赖 `@dbkable/react-native-speech-to-text`(已装,封装 iOS `SFSpeechRecognizer`)
- 模拟器验收:
  - 在模拟器菜单 **I/O → Input → 勾选 Mac 麦克风**
  - 模拟器必须联网(`SFSpeechRecognizer` 在模拟器上走云端)
  - 最终效果验收建议真机(麦克风质量、中文识别准确率)

---

## 7. 要注意的坑

1. **postMessage 只能发字符串** —— H5 必须 `JSON.stringify`,RN 必须 `JSON.parse`。直接发对象会静默失败。
2. **injectJavaScript 是异步的** —— 连续推多条消息可能乱序。如果 H5 发现 `interim` 和 `final` 顺序不对,加个序列号。
3. **H5 卸载时必须清理** —— unmount 时把 `window.onSpeechEvent = null`,同时发 `speech:stop` 给 RN,防止 RN 那边还在录音。
4. **iOS 1 分钟硬限制** —— 用户按住超过 1 分钟系统会自己停,RN 会收到 error 事件,H5 要友好提示。
5. **WebView 切后台** —— H5 监听 `pagehide` / `visibilitychange`,发 `speech:stop`,避免后台录音。
6. **模拟器调试** —— iOS 模拟器借 Mac 麦克风,不开就永远是静音,识别不到。
7. **权限被拒后的恢复** —— 用户只能去「设置 → App」里手动重开,代码没法再弹。H5 要显示"去设置"按钮。
8. **中间结果 vs 最终结果** —— `interim` 是草稿(会被覆盖),`final` 是定稿(累加)。H5 显示逻辑要分清。

---

## 8. 验收清单

### H5 侧

- [ ] 按钮按下 → 发送 `speech:start`
- [ ] 按钮松开 → 发送 `speech:stop`
- [ ] 收到 `interim` → 显示为草稿(灰色)
- [ ] 收到 `final` → 累加到定稿,清草稿
- [ ] 收到 `error` → 按错误码分别提示(包括 `not-available`)
- [ ] 收到 `status` → 更新按钮状态文案
- [ ] 卸载时清 `window.onSpeechEvent` + 发 `speech:stop`
- [ ] `pagehide` / `visibilitychange` 发 `speech:stop`

### RN 侧

- [ ] WebView 容器正确解析 H5 指令
- [ ] `useSpeechToText` hook 事件正确桥接到 `pushToH5`
- [ ] `pushToH5` 用 `JSON.stringify` 转义,末尾加 `true;`
- [ ] 权限首次 `start` 时懒加载,不提前弹
- [ ] 错误码归一化正确(参考 §3.3)

### 端到端

- [ ] 首次按下按钮 → RN 弹权限弹窗(麦克风 + 语音识别)
- [ ] 允许后,说话 → H5 实时显示中间结果
- [ ] 松手 → H5 显示最终文字,可编辑
- [ ] 拒绝权限 → H5 显示"去设置"引导
- [ ] 切换中英文 → 下次录音识别对应语言
- [ ] H5 页面关闭 → RN 自动停止录音
- [ ] iOS 模拟器上能跑通(开 Mac 麦克风)
- [ ] 真机上识别准确率可接受

---

## 9. 取舍记录

| 决策     | 选                                     | 不选                      | 原因                                       |
| -------- | -------------------------------------- | ------------------------- | ------------------------------------------ |
| 通信方式 | postMessage + injectJavaScript         | URL scheme / WebSocket    | 同 App 内 WebView,bridge 足够,无需额外服务 |
| 控制方   | H5 控制 UI                             | RN 控制 UI(全屏 Modal)    | H5 那边 UI 自由度高,RN 侧代码最少          |
| 接口风格 | 多事件细分                             | 单一 result 事件          | 支持"边说边出字"实时体验                   |
| 权限时机 | 首次 start 时懒加载                    | WebView 挂载时预请求      | 避免打扰用户                               |
| ASR 库   | `@dbkable/react-native-speech-to-text` | `expo-speech-recognition` | 后者需装整个 expo SDK,对裸 RN 过重         |

---

## 10. 风险与未决

- **iOS 模拟器稳定性**:偶尔 `SFSpeechRecognizer` 在模拟器上会玄学失败,不代表代码错。验收仍以真机为准。
- **injectJavaScript 顺序**:极端情况下消息可能乱序,H5 侧如发现此问题,需在接口上加序列号。
- **H5 那边的代码位置**:如果 H5 不在当前仓库,RN 侧只交付 bridge + 接口文档,H5 那边由别的团队按本契约实现。
