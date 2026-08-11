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
│       (H5 注册,RN 调用)         │
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

H5 通过 `window.ReactNativeWebView.postMessage(JSON.stringify(msg))` 发消息。**只能发字符串**,发非字符串会告警,Android 上直接抛异常。

| msg.type              | 触发时机            | payload                        |
| --------------------- | ------------------- | ------------------------------ |
| `speech:start`        | 按钮按下            | `{locale: 'zh-CN' \| 'en-US'}` |
| `speech:stop`         | 按钮松开 / 触摸取消 | 无                             |
| `speech:openSettings` | 点击"去设置"按钮    | 无                             |

**幂等约定**:`listening` / `processing` 中再收到 `speech:start` → 忽略;非录音状态收到 `speech:stop` → 忽略(no-op)。两条消息都幂等,H5 不需要做防抖。

> 注意:没有 `speech:check` 之类的"探路"消息。H5 直接显示按钮,用户按下后如果设备不支持,RN 会回 `error: not-available`,H5 按错误处理即可。少一次 bridge 往返,逻辑更简单。

### 3.2 RN → H5(推事件)

RN 通过 `webViewRef.injectJavaScript(...)` 调 H5 全局函数 `window.onSpeechEvent(data)`。

| data.type | 触发时机             | data 字段                                                                               |
| --------- | -------------------- | --------------------------------------------------------------------------------------- |
| `status`  | 状态变化             | `{status: 'idle' \| 'requesting-permission' \| 'listening' \| 'processing' \| 'error'}` |
| `interim` | 边说边出字(中间结果) | `{text: '...'}` —— 本句草稿,会被后续 `interim` 整体覆盖                                 |
| `final`   | 一句话结束(最终结果) | `{text: '...'}` —— **本句增量文本(不是累计全文)**,H5 直接累加到定稿                     |
| `error`   | 出错                 | `{code: '...', message: '...'}`                                                         |

**状态语义补充**:

- `processing`:松手(`speech:stop`)之后、最终结果返回之前的短暂状态。`final` 是异步到达的,这段时间 H5 可显示"处理中..."
- `error`:不需要手动复位,下次 `speech:start` 自动回到正常流程

**为什么拆这么多事件,不直接一个 `result`?**

因为 H5 要"边说边出字" —— 中间结果(`interim`)要实时推,最终结果(`final`)才稳定。H5 拿到 `interim` 显示成灰色草稿,拿到 `final` 才定稿(增量累加,见 §4.1)。

### 3.3 错误码

| code            | 含义                   | H5 推荐处理                               |
| --------------- | ---------------------- | ----------------------------------------- |
| `mic-denied`    | 麦克风权限被拒         | 显示"去设置"引导                          |
| `speech-denied` | 语音识别权限被拒       | 显示"去设置"引导                          |
| `not-available` | 设备不支持             | 显示“此设备不支持语音识别”                |
| `network`       | 网络错误(模拟器需联网) | 显示"请检查网络"                          |
| `rate-limited`  | iOS 调用频率限制       | 显示"请稍后再试"                          |
| `max-duration`  | 超过 iOS 1 分钟硬限制  | 显示"已达最长录音时长",**保留已识别文字** |
| `unknown`       | 其他                   | 显示 message                              |

> `max-duration` 本质是"系统自动停止",不是失败:此前识别的文字仍然有效,RN 保证 `final` 先于该 error 推送。H5 只提示,不要清空已定稿的文字。

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
        setDraft(''); // 清掉残留的灰色草稿
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
  onTouchCancel={() => post({type: 'speech:stop'})} // 来电/系统手势打断时不触发 touchend
  onMouseDown={...}   // PC 调试用
  onMouseUp={...}
>
  {status === 'listening'
    ? '识别中...'
    : status === 'processing'
    ? '处理中...'
    : '按住说话'}
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

按 §3.3 错误码分别处理。权限被拒时,H5 显示"去设置"按钮,点击后发 `speech:openSettings`,由 RN 调 `Linking.openSettings()` 跳转。

> **不要**在 H5 里用 `location.href = 'app-settings:'` 直接跳 —— WKWebView 会拦截自定义 scheme,跳不出去。去设置必须走 bridge。

### 4.5 生命周期兜底

- `visibilitychange`(仅 `document.visibilityState === 'hidden'` 时,回前台也会触发该事件)/ `pagehide` → 发 `speech:stop`,避免后台录音
- 组件 unmount → 清 `window.onSpeechEvent` + 发 `speech:stop`

> H5 的兜底只覆盖页面级场景。App 切后台时 WebView 的 JS 可能来不及执行,App 级兜底由 RN 侧负责(§5.5)。

---

## 5. RN 侧职责

### 5.1 WebView 容器组件

```jsx
<WebView
  source={{uri: 'https://your-h5-url'}}
  onMessage={e => {
    let msg;
    try {
      msg = JSON.parse(e.nativeEvent.data); // 页面里其他代码也可能 postMessage
    } catch {
      return; // 非 JSON 直接忽略
    }
    if (typeof msg?.type !== 'string' || !msg.type.startsWith('speech:')) {
      return; // 只处理本契约的消息
    }
    switch (msg.type) {
      case 'speech:start':
        speech.start(msg.locale);
        break;
      case 'speech:stop':
        speech.stop();
        break;
      case 'speech:openSettings':
        Linking.openSettings();
        break;
    }
  }}
  ref={webViewRef}
/>
```

### 5.2 把 hook 事件桥接到 H5

`useSpeechToText` hook 暴露 `text`、`interimText`、`status`、`error`、`isAvailable`。容器组件用 `useEffect` 监听前四个变化,一变就推给 H5(`isAvailable` 只在 RN 本地用,不通过 bridge 推):

```js
// final:hook 的 text 是会话内累计文本,而契约(§3.2)要求推「本句增量」,
// 所以记录上次已推送的文本,只推新增部分
const lastPushedTextRef = useRef('');
useEffect(() => {
  if (!text || text === lastPushedTextRef.current) return;
  const delta = text.startsWith(lastPushedTextRef.current)
    ? text.slice(lastPushedTextRef.current.length)
    : text; // 新会话导致累计文本重置时,兜底推全量
  lastPushedTextRef.current = text;
  pushToH5({type: 'final', text: delta});
}, [text]);

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

> **`processing` 状态的产生方**:hook 本身可能只有 idle/listening/error。`processing` 由容器组件合成 —— 收到 `speech:stop` 后先推 `{type: 'status', status: 'processing'}`,等 hook 回到 idle(或出 error)时再推真实状态覆盖。

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

### 5.5 App 切后台兜底

H5 的 `visibilitychange` / `pagehide` 在 App 切后台时**不一定来得及触发**(WebView 的 JS 可能直接被挂起),RN 侧必须自己兜底:

```js
useEffect(() => {
  const sub = AppState.addEventListener('change', state => {
    if (state !== 'active') speech.stop();
  });
  return () => sub.remove();
}, []);
```

生命周期兜底是双保险:H5 管页面级(unmount、pagehide),RN 管 App 级(切后台)。

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

1. **postMessage 只能发字符串** —— H5 必须 `JSON.stringify`,RN 必须 `JSON.parse`(记得 try/catch)。发非字符串会告警,Android 上直接抛异常。
2. **injectJavaScript 是异步的** —— 连续推多条消息可能乱序。如果 H5 发现 `interim` 和 `final` 顺序不对,加个序列号。
3. **H5 卸载时必须清理** —— unmount 时把 `window.onSpeechEvent = null`,同时发 `speech:stop` 给 RN,防止 RN 那边还在录音。
4. **iOS 1 分钟硬限制** —— 用户按住超过 1 分钟系统会自己停,RN 会收到 error 事件,H5 要友好提示,但已识别的文字仍然有效(`final` 先于 error 推送),不要清空。
5. **WebView 切后台** —— H5 监听 `pagehide` / `visibilitychange`(判 `hidden`),发 `speech:stop`;但 App 切后台时 WebView JS 可能被挂起,RN 侧必须用 `AppState` 兜底(§5.5)。
6. **模拟器调试** —— iOS 模拟器借 Mac 麦克风,不开就永远是静音,识别不到。
7. **权限被拒后的恢复** —— 用户只能去「设置 → App」里手动重开,代码没法再弹。H5 要显示"去设置"按钮。
8. **中间结果 vs 最终结果** —— `interim` 是草稿(会被覆盖),`final` 是定稿(增量累加)。H5 显示逻辑要分清。
9. **touchend 不一定触发** —— 来电、系统手势、页面滚动会触发 `touchcancel` 而不是 `touchend`,按钮必须同时监听 `onTouchCancel` 发 stop,否则一直录音。

---

## 8. 验收清单

### H5 侧

- [ ] 按钮按下 → 发送 `speech:start`
- [ ] 按钮松开 → 发送 `speech:stop`
- [ ] 触摸被打断(`touchcancel`)→ 同样发送 `speech:stop`
- [ ] 收到 `interim` → 显示为草稿(灰色)
- [ ] 收到 `final` → 累加到定稿,清草稿
- [ ] 收到 `error` → 清草稿,按错误码分别提示(包括 `not-available`)
- [ ] 收到 `status: processing` → 按钮显示"处理中..."
- [ ] 权限被拒 → 显示"去设置"按钮,点击发 `speech:openSettings`
- [ ] 卸载时清 `window.onSpeechEvent` + 发 `speech:stop`
- [ ] `pagehide` / `visibilitychange`(判 `hidden`)发 `speech:stop`

### RN 侧

- [ ] WebView 容器正确解析 H5 指令(`JSON.parse` 有 try/catch + `speech:` 前缀过滤)
- [ ] `useSpeechToText` hook 事件正确桥接到 `pushToH5`
- [ ] `text` 变化 → 推 `final` **增量**(参考 §5.2 delta 逻辑)
- [ ] `pushToH5` 用 `JSON.stringify` 转义,末尾加 `true;`
- [ ] 权限首次 `start` 时懒加载,不提前弹
- [ ] `start` / `stop` 幂等(参考 §3.1 幂等约定)
- [ ] 收到 `speech:openSettings` → `Linking.openSettings()`
- [ ] `AppState` 非 active 时自动 `speech.stop()`(§5.5)
- [ ] 错误码归一化正确(参考 §3.3);`max-duration` 前保证 `final` 已推送

### 端到端

- [ ] 首次按下按钮 → RN 弹权限弹窗(麦克风 + 语音识别)
- [ ] 允许后,说话 → H5 实时显示中间结果
- [ ] 松手 → H5 显示最终文字,可编辑
- [ ] 拒绝权限 → H5 显示"去设置"引导,点击能跳到系统设置
- [ ] 切换中英文 → 下次录音识别对应语言
- [ ] H5 页面关闭 → RN 自动停止录音
- [ ] App 切后台 → 录音自动停止(RN `AppState` 兜底生效)
- [ ] 录音中触摸被打断(如下拉通知中心)→ 录音停止
- [ ] iOS 模拟器上能跑通(开 Mac 麦克风)
- [ ] 真机上识别准确率可接受

---

## 9. 取舍记录

| 决策       | 选                                     | 不选                      | 原因                                       |
| ---------- | -------------------------------------- | ------------------------- | ------------------------------------------ |
| 通信方式   | postMessage + injectJavaScript         | URL scheme / WebSocket    | 同 App 内 WebView,bridge 足够,无需额外服务 |
| 控制方     | H5 控制 UI                             | RN 控制 UI(全屏 Modal)    | H5 那边 UI 自由度高,RN 侧代码最少          |
| 接口风格   | 多事件细分                             | 单一 result 事件          | 支持"边说边出字"实时体验                   |
| 权限时机   | 首次 start 时懒加载                    | WebView 挂载时预请求      | 避免打扰用户                               |
| ASR 库     | `@dbkable/react-native-speech-to-text` | `expo-speech-recognition` | 后者需装整个 expo SDK,对裸 RN 过重         |
| final 语义 | 本句增量,H5 累加                       | 累计全文,H5 替换          | H5 逻辑最简;增量计算收敛在 RN 一处(§5.2)   |
| 去设置     | bridge 消息 + `Linking.openSettings()` | H5 直接跳 `app-settings:` | WKWebView 拦截自定义 scheme,H5 跳不出去    |

---

## 10. 风险与未决

- **iOS 模拟器稳定性**:偶尔 `SFSpeechRecognizer` 在模拟器上会玄学失败,不代表代码错。验收仍以真机为准。
- **injectJavaScript 顺序**:极端情况下消息可能乱序,H5 侧如发现此问题,需在接口上加序列号。
- **H5 那边的代码位置**:如果 H5 不在当前仓库,RN 侧只交付 bridge + 接口文档,H5 那边由别的团队按本契约实现。

---

## 11. 第三方接入点

**核心原则**:ASR 能力**必须在 RN 侧**,因为麦克风权限在 native 层。H5 在 WKWebView 沙盒里拿不到麦克风,所以无论第三方 SDK 是 native 还是纯 JS,都应该接在 `useSpeechToText` hook 内部,bridge 契约(§3)不变。

### 11.1 接入形态

| 第三方 SDK 形态             | 接入位置                | 说明                                                          |
| --------------------------- | ----------------------- | ------------------------------------------------------------- |
| native SDK(讯飞、百度等)    | hook 内部替换           | 直接调 native API,替换 `@dbkable/...`                         |
| 纯 JS SDK(WebSocket 连云端) | hook 内部替换           | RN 侧采集音频 → 喂给 JS SDK → SDK 走 WebSocket → 拿到识别结果 |
| 完整方案(SDK + UI)          | SDK 放 hook 内,UI 放 H5 | 拆开接,bridge 契约仍然是 §3                                   |

### 11.2 讯飞接入示例(iOS)

hook 对外 API 不变:`start(locale)` / `stop()` / `text` / `interimText` / `status` / `error` / `isAvailable`。只替换内部实现。

> **真实 API 来源**:讯飞 iOS SDK 官方文档(https://www.xfyun.cn/doc/asr/voicedictation/iOS-SDK.html),以及现成的 RN 封装库 `react-native-speech-iflytek`(https://github.com/zphhhhh/react-native-speech-iflytek)。下面示例基于这两个真实 API,不是猜的。

```js
// hooks/useSpeechToText.js (讯飞版,基于 react-native-speech-iflytek)
import {useEffect, useRef, useState} from 'react';
import {NativeEventEmitter, PermissionsAndroid, Platform} from 'react-native';
import {Recognizer, SpeechConstant} from 'react-native-speech-iflytek';

const RecognizerEmitter = new NativeEventEmitter(Recognizer);

export function useSpeechToText() {
  const [text, setText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const localeRef = useRef('zh-CN');

  // 讯飞语言参数映射(§3.1 的 locale → 讯飞 language)
  const mapLocale = locale => {
    switch (locale) {
      case 'zh-CN':
        return 'zh_cn';
      case 'en-US':
        return 'en_us';
      default:
        return 'zh_cn';
    }
  };

  // 讯飞 MSC 错误码 → §3.3 统一错误码
  // 参考:讯飞 MSC 错误码文档 https://www.xfyun.cn/document/err_code
  const mapIFlyError = errorCode => {
    const code = Number(errorCode);
    switch (code) {
      case 10115: // 授权失败(麦克风权限被拒)
      case 11202: // 权限被拒
        return 'mic-denied';
      case 10204: // 网络连接失败
      case 10205: // 网络不可用
      case 10212: // 网络异常
        return 'network';
      case 10405: // 超时(包含 60s 限制)
      case 11201: // 引擎超时
        return 'max-duration';
      case 10406: // 频率限制
        return 'rate-limited';
      case 10200: // 不支持
      case 11200: // 未授权
        return 'not-available';
      default:
        return 'unknown';
    }
  };

  useEffect(() => {
    // 1. 初始化(只需一次,appid 从讯飞开放平台申请)
    Recognizer.init('YOUR_APPID');

    // 2. 监听识别结果
    const resultSub = RecognizerEmitter.addListener('onRecognizerResult', e => {
      // e = { text, result, isLast, duration }
      if (e.isLast) {
        // 最终结果:累加到 text(讯飞每次返回的是增量句子)
        setText(prev => prev + e.text);
        setInterimText('');
      } else {
        // 中间结果:覆盖 interimText
        setInterimText(e.text);
      }
    });

    // 3. 监听错误
    const errorSub = RecognizerEmitter.addListener('onRecognizerError', err => {
      const code = mapIFlyError(err.errorCode);
      setError({
        code,
        message: err.errorDesc || err.plainDescription,
      });
      setStatus('error');
    });

    return () => {
      resultSub.remove();
      errorSub.remove();
    };
  }, []);

  const start = async (locale = 'zh-CN') => {
    setError(null);
    setText('');
    setInterimText('');
    localeRef.current = locale;

    // 4. 权限请求(Android 需要动态请求, iOS 由 SDK 自动弹)
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        setError({code: 'mic-denied', message: '麦克风权限被拒'});
        setStatus('error');
        return;
      }
    }

    setStatus('requesting-permission');

    // 5. 设置讯飞参数
    Recognizer.setParameter('iat', SpeechConstant.DOMAIN); // 听写模式
    Recognizer.setParameter(mapLocale(locale), SpeechConstant.LANGUAGE);
    Recognizer.setParameter('mandarin', SpeechConstant.ACCENT);
    Recognizer.setParameter('json', SpeechConstant.RESULT_TYPE); // 返回 JSON 格式

    // 6. 开始识别
    setStatus('listening');
    await Recognizer.start();
  };

  const stop = async () => {
    await Recognizer.stop();
    // stop 后 onRecognizerResult 还会触发一次 isLast=true 的最终结果,
    // 然后 onEndOfSpeech 触发,此时 status 由容器组件置为 idle
  };

  return {
    text,
    interimText,
    status,
    error,
    isAvailable: true,
    start,
    stop,
  };
}
```

### 11.3 关键替换点

| 原实现(`@dbkable/...`)       | 讯飞实现(`react-native-speech-iflytek`)               | 说明                |
| ---------------------------- | ----------------------------------------------------- | ------------------- |
| `SFSpeechRecognizer`         | `Recognizer.init(appid)` + `Recognizer.start()`       | 初始化 + 开始       |
| `onRecognitionAvailable`     | `onRecognizerResult({ isLast: false })`               | 中间结果            |
| `onFinished`                 | `onRecognizerResult({ isLast: true })`                | 最终结果            |
| `SFSpeechRecognizerError...` | `onRecognizerError({ errorCode })` + `mapIFlyError()` | 错误码归一化到 §3.3 |
| 系统权限弹窗(iOS)            | SDK 自动弹(iOS) / `PermissionsAndroid`(Android)       | 权限请求            |
| `zh-CN` / `en-US`            | `zh_cn` / `en_us`(讯飞格式,下划线小写)                | locale 映射         |

### 11.4 注意事项

1. **现成 RN 库可直接用**:`react-native-speech-iflytek` 已经封装了讯飞 SDK 的 native 层,iOS / Android 双平台都支持。不需要自己写 native module。
2. **讯飞 SDK 文件需手动替换**:安装 `react-native-speech-iflytek` 后,还要去讯飞开放平台下载对应版本的 SDK,替换 `node_modules/react-native-speech-iflytek/{ios,android}/libs` 下的文件(iOS 还要把 `iflyMSC.framework` 拖进 Xcode 工程,并添加 `CoreLocation.framework` / `AVFoundation.framework` 等系统依赖库)。
3. **iOS 权限配置**:Info.plist 需加 `NSMicrophoneUsageDescription`(麦克风)、`NSLocationUsageDescription`(定位,讯飞依赖)等。
4. **locale 映射**:讯飞的语言参数是 `zh_cn` / `en_us` 格式(下划线,小写),和 §3.1 的 `zh-CN` / `en-US` 不同,hook 内部要做映射(见 11.2 `mapLocale`)。
5. **错误码归一化**:讯飞的 MSC 错误码(如 10115、10204、10405)必须映射到 §3.3 的统一错误码(见 11.2 `mapIFlyError`)。
6. **听写结果格式**:讯飞返回的是 JSON 结构化结果(`{sn, ls, ws: [{cw: [{w}]}]}`),`react-native-speech-iflytek` 已经帮你拼成 `e.text` 字符串,直接用即可。
7. **60s 限制**:讯飞听写支持 60s 内音频,超过会自动停止,触发 `onRecognizerError` 报超时错误码。
8. **bridge 契约不变**:hook 对外 API 不变,§5 的容器组件代码完全不用改,§3 的契约完全不用改。

### 11.5 Android 侧原子模块实现

> **真实 API 来源**:讯飞 Android SDK 官方文档(https://www.xfyun.cn/doc/asr/voicedictation/Android-SDK.html)。下面示例基于讯飞 Android SDK 的真实 API。

#### 11.5.1 AndroidManifest.xml 权限配置

```xml
<!-- 网络权限(云端识别必须) -->
<uses-permission android:name="android.permission.INTERNET"/>
<!-- 麦克风权限 -->
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<!-- 网络状态 -->
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE"/>
<uses-permission android:name="android.permission.CHANGE_NETWORK_STATE"/>
<!-- 读取手机信息 -->
<uses-permission android:name="android.permission.READ_PHONE_STATE"/>
<!-- 存储权限(讯飞依赖) -->
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"/>
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"/>
```

#### 11.5.2 Android 原生模块(Java)

```java
// android/app/src/main/java/com/yourapp/IFlyASRModule.java
package com.yourapp;

import android.os.Bundle;
import com.facebook.react.bridge.*;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.iflytek.cloud.*;

public class IFlyASRModule extends ReactContextBaseJavaModule {
    private SpeechRecognizer mIat;
    private ReactApplicationContext mReactContext;

    public IFlyASRModule(ReactApplicationContext reactContext) {
        super(reactContext);
        mReactContext = reactContext;
    }

    @Override
    public String getName() {
        return "IFlyASR";
    }

    // 初始化(在 App 启动时调用)
    @ReactMethod
    public void init(String appid) {
        // 讯飞 SDK 初始化,创建 SpeechUtility
        SpeechUtility.createUtility(mReactContext, SpeechConstant.APPID + "=" + appid);
    }

    // 开始识别
    @ReactMethod
    public void start() {
        if (mIat == null) {
            // 创建识别对象(无 UI 模式)
            mIat = SpeechRecognizer.createRecognizer(mReactContext, new InitListener() {
                @Override
                public void onInit(int code) {
                    if (code != ErrorCode.SUCCESS) {
                        sendError(code, "初始化失败");
                    }
                }
            });
        }

        // 设置参数
        mIat.setParameter(SpeechConstant.DOMAIN, "iat");         // 听写模式
        mIat.setParameter(SpeechConstant.LANGUAGE, "zh_cn");     // 语言
        mIat.setParameter(SpeechConstant.ACCENT, "mandarin");    // 方言
        mIat.setParameter(SpeechConstant.RESULT_TYPE, "json");   // 返回 JSON
        mIat.setParameter(SpeechConstant.VAD_BOS, "4000");       // 前端点超时
        mIat.setParameter(SpeechConstant.VAD_EOS, "1800");       // 后端点超时

        // 开始识别,并设置监听器
        int code = mIat.startListening(mRecogListener);
        if (code != ErrorCode.SUCCESS) {
            sendError(code, "开始识别失败");
        }
    }

    // 停止识别
    @ReactMethod
    public void stop() {
        if (mIat != null && mIat.isListening()) {
            mIat.stopListening(mRecogListener);
        }
    }

    // 取消识别
    @ReactMethod
    public void cancel() {
        if (mIat != null && mIat.isListening()) {
            mIat.cancel();
        }
    }

    // 识别监听器
    private RecognizerListener mRecogListener = new RecognizerListener() {
        // 中间结果(边说边出字)
        @Override
        public void onResult(RecognizerResult result, boolean isLast) {
            // result.getResultString() 返回 JSON 格式:
            // {"sn":1,"ls":false,"ws":[{"cw":[{"w":"今天"}]}]}
            // 需要解析 JSON 提取文本
            String text = JsonParser.parseIatResult(result.getResultString());
            WritableMap map = Arguments.createMap();
            map.putString("text", text);
            map.putBoolean("isLast", isLast);
            sendEvent("onRecognizerResult", map);
        }

        // 音量变化
        @Override
        public void onVolumeChanged(int volume) {
            WritableMap map = Arguments.createMap();
            map.putInt("volume", volume);
            sendEvent("onRecognizerVolumeChanged", map);
        }

        // 开始录音
        @Override
        public void onBeginOfSpeech() {
            sendEvent("onBeginOfSpeech", null);
        }

        // 结束录音
        @Override
        public void onEndOfSpeech() {
            sendEvent("onEndOfSpeech", null);
        }

        // 识别完成
        @Override
        public void onCompleted(SpeechError error) {
            if (error != null) {
                sendError(error.getErrorCode(), error.getErrorDescription());
            }
        }

        // 会话取消
        @Override
        public void onCancel() {
            sendEvent("onCancel", null);
        }
    };

    // 发送错误事件
    private void sendError(int errorCode, String errorDesc) {
        WritableMap map = Arguments.createMap();
        map.putInt("errorCode", errorCode);
        map.putString("errorDesc", errorDesc);
        sendEvent("onRecognizerError", map);
    }

    // 发送事件到 JS 层
    private void sendEvent(String eventName, WritableMap params) {
        mReactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit(eventName, params);
    }
}
```

#### 11.5.3 Android 原生模块注册

```java
// android/app/src/main/java/com/yourapp/IFlyASRPackage.java
package com.yourapp;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class IFlyASRPackage implements ReactPackage {
    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
        return Arrays.<NativeModule>asList(new IFlyASRModule(reactContext));
    }

    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
        return Collections.emptyList();
    }
}
```

```java
// android/app/src/main/java/com/yourapp/MainApplication.java
@Override
protected List<ReactPackage> getPackages() {
    return Arrays.<ReactPackage>asList(
        new MainReactPackage(),
        new IFlyASRPackage()  // 注册自定义模块
    );
}
```

#### 11.5.4 Android 关键 API 对照

| 讯飞 Android SDK API                                                  | 说明                   |
| --------------------------------------------------------------------- | ---------------------- |
| `SpeechUtility.createUtility(context, SpeechConstant.APPID + "=xxx")` | 初始化 SDK             |
| `SpeechRecognizer.createRecognizer(context, listener)`                | 创建识别器(无 UI)      |
| `mIat.setParameter(SpeechConstant.DOMAIN, "iat")`                     | 设置听写模式           |
| `mIat.setParameter(SpeechConstant.LANGUAGE, "zh_cn")`                 | 设置语言               |
| `mIat.startListening(mRecogListener)`                                 | 开始识别               |
| `mIat.stopListening(mRecogListener)`                                  | 停止识别               |
| `mIat.cancel()`                                                       | 取消识别               |
| `onResult(RecognizerResult result, boolean isLast)`                   | 识别结果回调           |
| `onCompleted(SpeechError error)`                                      | 识别完成回调           |
| `error.getErrorCode()`                                                | 获取错误码(MSC 错误码) |
| `error.getErrorDescription()`                                         | 获取错误描述           |

#### 11.5.5 Android 注意事项

1. **讯飞 SDK 文件需手动拷贝**:把 `Android_voice_xxx/libs` 下的 `.so` 和 `.jar` 拷贝到 `android/app/libs` 目录,并在 `build.gradle` 添加依赖。
2. **混淆配置**:如果开启混淆,需要在 `proguard-rules.pro` 添加 `-keep class com.iflytek.**{*;}`。
3. **音频格式**:讯飞只支持 16 位 Intel PCM 格式,采样率 16k 或 8k,单声道。
4. **60s 限制**:讯飞听写支持 60s 内音频,超过会自动停止,触发 `onCompleted` 报超时错误。
5. **权限动态请求**:Android 6.0+ 需要在 JS 层用 `PermissionsAndroid.request()` 动态请求麦克风权限。
6. **bridge 契约不变**:Android 原生模块暴露的事件(`onRecognizerResult` / `onRecognizerError`)和 iOS 一致,JS 层的 `useSpeechToText` hook 完全不用改。
