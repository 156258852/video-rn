---
kind: configuration_system
name: No centralized configuration system
category: configuration_system
scope:
    - '**'
source_files:
    - app.json
    - metro.config.js
    - babel.config.js
    - jest.config.js
    - package.json
    - hooks/useVideoSequencePlayer.ts
---

This repository does not implement a dedicated runtime configuration system. There is no config directory, no .env files, no dotenv usage, and no process.env-based settings loader anywhere in the codebase.

Configuration-like values are scattered as inline constants or small module-level objects:
- `app.json` holds only the React Native app name and displayName.
- `metro.config.js`, `babel.config.js`, and `jest.config.js` are build-time tooling configs with minimal customization (Metro merges defaults, Babel uses the RN preset, Jest uses the RN preset).
- `package.json` declares dependencies, scripts, and an engines constraint for Node >= 18.
- Video buffering behavior is controlled by a local `BUFFER_CONFIG = {cacheSizeMB: 200}` constant inside `hooks/useVideoSequencePlayer.ts`.
- App data such as video clip URIs (`CLIPS`) and UI strings are hardcoded directly in `App.tsx`.

There is no mechanism to load environment variables, feature flags, remote configuration, or per-environment overrides at runtime. All tunables are embedded in source code.