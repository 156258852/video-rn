---
kind: external_dependency
name: React Native 0.74.3
slug: react-native
category: external_dependency
category_hints:
    - client_constraint
scope:
    - '**'
source_files:
    - package.json
    - app.json
    - metro.config.js
---

### Mobile app framework
- iOS-focused POC targeting iPhone 17 Pro simulator
- Requires Xcode + CocoaPods for iOS dependencies
- Metro bundler for JavaScript compilation
- Node.js 18+ runtime requirement
- Platform detection via `Platform.OS` for iOS/Android specific behavior