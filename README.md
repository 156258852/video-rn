# StitchRNPOCModern

React Native (iOS-focused) POC for **virtual stitching** multiple MP4 clips into a single continuous timeline with a custom scrubber.

This app is part of the broader POC in this workspace:

- `Stitch_Video_POC/` – Vite dev server that serves MP4 files (and a Node stitch API used by the web/HLS POC)
- `Stitch_RN_POC/StitchRNPOCModern/` – this React Native app

## What this app does

### MP4 “virtual stitch” mode

- Plays a list of MP4 URLs sequentially.
- Treats them as **one continuous timeline**:
  - total duration = sum of per-clip durations
  - timeline scrubbing seeks across clip boundaries
- Custom JS scrubber with drag + tap-to-seek.

### HLS mode (optional)

There’s also an HLS tab that can play a stitched HLS URL (if the stitch API is running and reachable).

## Prerequisites

- Node.js (project expects Node 18+)
- Xcode + iOS Simulator
- CocoaPods (for iOS dependencies)

## Start the MP4 server (Vite @ :5173)

The RN app loads MP4 clips over HTTP. It expects the MP4s to be served by the Vite server in `Stitch_Video_POC`.

```zsh
cd "/Users/hcsrzz3/Library/CloudStorage/OneDrive-AIAGroupLtd/Documents/EA/Playground/Stitch_Video_POC"
npm install
npm run dev
```

The demo MP4s are typically available at:

- `http://127.0.0.1:5173/videos/v1/v1.mp4`
- `http://127.0.0.1:5173/videos/v2/v2.mp4`
- `http://127.0.0.1:5173/videos/v3/v3.mp4`

## (Optional) Start the stitch API (@ :8787)

Only needed for the **HLS (Stitched)** tab.

If it’s not running you’ll see `probe api failed: Network request failed` in the Debug pane — MP4 mode still works.

## Install dependencies (RN app)

```zsh
cd "/Users/hcsrzz3/Library/CloudStorage/OneDrive-AIAGroupLtd/Documents/EA/Playground/Stitch_RN_POC/StitchRNPOCModern"
npm install
cd ios
pod install
cd ..
```

## Run (iOS simulator)

Start Metro:

```zsh
cd "/Users/hcsrzz3/Library/CloudStorage/OneDrive-AIAGroupLtd/Documents/EA/Playground/Stitch_RN_POC/StitchRNPOCModern"
npx react-native start
```

In another terminal, build & run:

```zsh
cd "/Users/hcsrzz3/Library/CloudStorage/OneDrive-AIAGroupLtd/Documents/EA/Playground/Stitch_RN_POC/StitchRNPOCModern"
npx react-native run-ios --simulator "iPhone 17 Pro"
```

## How to use the app

### 1) Set host

At the top, set `Host`:

- **iOS Simulator**: use `127.0.0.1`
- **Physical device**: use your Mac’s LAN IP (example: `10.x.x.x`)

The Debug panel probes:

- MP4: `http://<host>:5173/videos/v1/v1.mp4`
- API: `http://<host>:8787/api/health` (optional)

### 2) MP4 Virtual Stitch tab

- Configure the clip list in `App.tsx` via `CLIPS = [{ uri, duration }, ...]`.
- Press **▶︎** to play.
- Scrub:
  - drag to preview
  - release to commit seek

Controls:

- `↺` start over (seek to 0 + play)
- `⟲5` / `5⟳` seek backward/forward 5 seconds
- `▶︎ / ❚❚` play/pause

### 3) Debug log

- Debug pane lists player events (load, progress, seeks, buffering, etc.).
- Press **Copy** to copy the full log.

## Troubleshooting

### MP4 probe succeeds but playback fails

Confirm the MP4 is reachable:

```zsh
curl -I http://127.0.0.1:5173/videos/v1/v1.mp4
```

### HLS probe fails

That’s expected if you haven’t started the stitch API on `:8787`.

### Scrubber disabled

In the current demo implementation, clip durations are configured upfront in `App.tsx` via `CLIPS = [{ uri, duration }, ...]`, so the scrubber should be enabled immediately.

If scrubbing is disabled, verify:

- `CLIPS` is non-empty and each item has a valid numeric `duration` (> 0)
- `mp4Total` is > 0 (the UI disables scrubbing when `mp4Total <= 0`)
- the URLs are reachable (playback still depends on network access)

This is a new [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

# Getting Started

> **Note**: Make sure you have completed the [React Native - Environment Setup](https://reactnative.dev/docs/environment-setup) instructions till "Creating a new application" step, before proceeding.

## Step 1: Start the Metro Server

First, you will need to start **Metro**, the JavaScript _bundler_ that ships _with_ React Native.

To start Metro, run the following command from the _root_ of your React Native project:

```bash
# using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Start your Application

Let Metro Bundler run in its _own_ terminal. Open a _new_ terminal from the _root_ of your React Native project. Run the following command to start your _Android_ or _iOS_ app:

### For Android

```bash
# using npm
npm run android

# OR using Yarn
yarn android
```

### For iOS

```bash
# using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up _correctly_, you should see your new app running in your _Android Emulator_ or _iOS Simulator_ shortly provided you have set up your emulator/simulator correctly.

This is one way to run your app — you can also run it directly from within Android Studio and Xcode respectively.

## Step 3: Modifying your App

Now that you have successfully run the app, let's modify it.

1. Open `App.tsx` in your text editor of choice and edit some lines.
2. For **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Developer Menu** (<kbd>Ctrl</kbd> + <kbd>M</kbd> (on Window and Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (on macOS)) to see your changes!

   For **iOS**: Hit <kbd>Cmd ⌘</kbd> + <kbd>R</kbd> in your iOS Simulator to reload the app and see your changes!

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [Introduction to React Native](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you can't get this to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
