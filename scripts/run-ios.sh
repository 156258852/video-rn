#!/bin/bash
# 编译、安装并启动 iOS 版到「已启动」的模拟器。
#
# 为什么不直接用 `npx react-native run-ios`：
#   Xcode 27 移除了独立的 Simulator.app，而 RN CLI 的 runOnSimulator.js
#   在编译之前会无条件 `open Simulator.app`，必然报
#   "The file .../Simulator.app does not exist"。本脚本用 xcodebuild + simctl 绕过。
#
# 用法：yarn ios
set -e
cd "$(dirname "$0")/.."

SCHEME=StitchRNPOCModern
WORKSPACE=ios/StitchRNPOCModern.xcworkspace

# 取当前已启动的模拟器 UDID
UDID=$(xcrun simctl list devices | grep -m1 Booted | grep -oE '[0-9A-Fa-f-]{36}')
if [ -z "$UDID" ]; then
  echo "没有已启动的模拟器。先启动一个，例如："
  echo "  xcrun simctl list devices          # 查可用设备"
  echo "  xcrun simctl boot <UDID>"
  exit 1
fi
echo "目标模拟器: $UDID"

# 注意：mktemp 的模板必须以 XXXXXX 结尾，写成 /tmp/rnbuild.XXXXXX.log 在 macOS 上
# 会报 "mkstemp failed on ...: File exists"，所以这里直接自己拼文件名。
LOG="/tmp/rnbuild-$(date +%Y%m%d-%H%M%S).log"
echo "编译中（日志: $LOG）..."
if ! xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" \
    -configuration Debug -sdk iphonesimulator -destination "id=$UDID" \
    -derivedDataPath ios/build/DerivedData build > "$LOG" 2>&1; then
  echo "编译失败，错误如下："
  grep -E "error:" "$LOG" | head -20
  echo "完整日志: $LOG"
  exit 1
fi
grep -E "BUILD " "$LOG"

APP=$(find ios/build/DerivedData -name "$SCHEME.app" -type d | head -1)
echo "安装: $APP"
xcrun simctl install "$UDID" "$APP"

# 注意：defaults read 只认 domain 名，不认 plist 路径，会报
# "Domain '.../Info' not found."，这里用 plutil 直接从 Info.plist 取值。
BUNDLE_ID=$(plutil -extract CFBundleIdentifier raw -o - "$APP/Info.plist")
echo "启动: $BUNDLE_ID"
xcrun simctl launch "$UDID" "$BUNDLE_ID"

echo
echo "完成。看插件/JS 日志："
echo "  xcrun simctl spawn $UDID log stream --level debug \\"
echo "    --predicate 'process == \"$SCHEME\"' | grep -E 'Playlist|SOURCE|VIDEO_ERROR'"
