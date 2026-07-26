---
kind: dependency_management
name: Node.js and Ruby Dependency Management via npm and Bundler
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - Gemfile
    - Gemfile.lock
    - .gitignore
---

This React Native project uses two separate dependency management systems for its JavaScript/TypeScript codebase and its iOS build toolchain.

**JavaScript/TypeScript dependencies (npm)**
- Manifest: `package.json` declares runtime dependencies (`react`, `react-native`, `react-native-video`, `@react-native-community/slider`) and development dependencies (Babel, ESLint, Jest, TypeScript, Prettier).
- Lockfile: `package-lock.json` (lockfileVersion 3) pins every transitive dependency with exact versions and integrity hashes, ensuring reproducible installs across environments.
- Node engine constraint: `engines.node >= 18` enforces a minimum Node.js version.
- No vendoring: `node_modules` is listed in `.gitignore`; dependencies are installed from the public npm registry at install time.
- Scripts: standard `react-native run-android`, `react-native run-ios`, `eslint .`, `jest`, and `react-native start` scripts provide the build/test/dev workflow.

**Ruby/iOS build dependencies (Bundler + CocoaPods)**
- Manifest: `Gemfile` sources `https://rubygems.org` and constrains `cocoapods` to `>= 1.13, < 1.15` and `activesupport` to `>= 6.1.7.5, < 7.1.0`, with an explicit note that Cocoapods 1.15 has a known bug breaking builds.
- Lockfile: `Gemfile.lock` records the full resolved dependency tree (CocoaPods 1.14.3, activesupport 6.1.7.10, etc.) under `PLATFORMS ruby` and `RUBY VERSION 2.6.10p210`.
- Vendoring: `vendor` directory is gitignored; no Ruby gems are vendored into the repo.
- CocoaPods is used by React Native to resolve native iOS dependencies; there is no separate `Podfile.lock` visible at this level.

**Conventions observed**
- Runtime vs. dev dependencies are separated in `package.json`.
- Both ecosystems use lockfiles committed to source control for deterministic builds.
- Private registries or scoped packages are not configured; all packages come from public registries (npmjs.org, rubygems.org).
- Version ranges use caret (`^`) for compatible updates on most packages, while core framework versions like `react` and `react-native` are pinned to exact versions.