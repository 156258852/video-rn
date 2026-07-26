---
kind: build_system
name: React Native Build & Toolchain
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - metro.config.js
    - babel.config.js
    - jest.config.js
    - tsconfig.json
    - app.json
---

This project uses the standard React Native (0.74) toolchain with TypeScript, Metro bundler, Babel, Jest, ESLint, and Prettier. There is no custom Makefile, Dockerfile, or CI pipeline; build and development are driven by npm scripts and React Native CLI conventions.

**Build system and tools**
- **Bundler**: Metro via `@react-native/metro-config` with a minimal `metro.config.js` that merges defaults (`metro.config.js`).
- **Transpilation**: Babel using `@react-native/babel-preset` (`babel.config.js`).
- **TypeScript**: Extends `@react-native/typescript-config/tsconfig.json` (`tsconfig.json`).
- **Testing**: Jest with the `react-native` preset (`jest.config.js`, `__tests__/App.test.tsx`).
- **Linting/formatting**: ESLint (`@react-native/eslint-config`) and Prettier (`.prettierrc`, `.prettierignore`).
- **App metadata**: `app.json` defines app name and display name.

**Scripts and commands** (`package.json`)
- `npm start` — starts the Metro dev server (`react-native start`).
- `npm run android` / `npm run ios` — launches the app on Android/iOS simulators/devices via `react-native run-android` / `react-native run-ios`.
- `npm test` — runs Jest tests.
- `npm run lint` — runs ESLint over the codebase.

**Versioning and environment**
- Package version is `0.0.1` (private project).
- Node engine requirement: `>=18`.
- App bundle identifier and display name come from `app.json`.

**Packaging and deployment**
- No explicit packaging scripts for release builds (e.g., `bundle --release`, `gradle assembleRelease`, `fastlane`, or `xcodebuild`) are present in this repo. The project appears to be a local proof-of-concept intended for development and manual testing rather than automated CI/CD.
- No Dockerfile, Makefile, GitHub Actions, or other CI configuration files exist at the repository root.