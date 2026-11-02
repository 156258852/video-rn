#!/usr/bin/env node
/**
 * 升级 react-native-video 后的「插件契约自检」。
 *
 * 背景：PlaylistComposerPlugin 依赖的是官方标记为 experimental 的插件接口，
 * 升级库版本后接口可能被改。这个脚本在跑构建之前先把契约检查一遍，
 * 避免"升完版本才发现拼接失效"。
 *
 * 检查项：
 *   1. node_modules 里实际装的版本 === package.json 声明的版本
 *   2. Android 接口 RNVExoplayerPlugin 仍然提供 overrideMediaSourceFactory
 *   3. iOS 接口 RNVAVPlayerPlugin 仍然提供 overridePlayerAsset
 *   4. OverridePlayerAssetType 仍然是 .full / .partial 两种
 *
 * 用法：yarn verify:rnv   （或 node scripts/check-rnv-contract.js）
 * 退出码：0 全部通过；1 有失败项。
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const libDir = path.join(root, 'node_modules', 'react-native-video');

const results = [];
const add = (ok, name, detail) => results.push({ok, name, detail});

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

// ---------- 1. 版本一致 ----------
const appPkgPath = path.join(root, 'package.json');
const libPkgPath = path.join(libDir, 'package.json');

const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
const declared = appPkg.dependencies['react-native-video'];

const libPkgRaw = readIfExists(libPkgPath);
const installed = libPkgRaw ? JSON.parse(libPkgRaw).version : null;

add(
  !!installed && installed === declared,
  '版本一致',
  installed
    ? `package.json=${declared} / node_modules=${installed}`
    : 'node_modules/react-native-video 不存在，先 yarn install',
);

if (installed && installed !== declared) {
  add(
    false,
    '版本未被 caret 漂移',
    `声明 ${declared}，实际 ${installed}。package.json 里应写精确版本（不要 ^）`,
  );
}

// ---------- 2. Android 接口 ----------
const androidIface = path.join(
  libDir,
  'android/src/main/java/com/brentvatne/exoplayer/RNVExoplayerPlugin.kt',
);
const androidSrc = readIfExists(androidIface);

add(
  !!androidSrc,
  'Android 接口文件存在',
  androidSrc ? androidIface.replace(root, '.') : `找不到 ${androidIface}`,
);

if (androidSrc) {
  add(
    /fun\s+overrideMediaSourceFactory\s*\(/.test(androidSrc),
    'Android: overrideMediaSourceFactory 仍在',
    'RNVExoplayerPlugin.overrideMediaSourceFactory(source, mediaSourceFactory, mediaDataSourceFactory)',
  );
}

const androidManager = path.join(
  libDir,
  'android/src/main/java/com/brentvatne/react/ReactNativeVideoManager.kt',
);
const managerSrc = readIfExists(androidManager);
add(
  !!managerSrc && /fun\s+registerPlugin\s*\(/.test(managerSrc),
  'Android: registerPlugin 仍在',
  'ReactNativeVideoManager.getInstance().registerPlugin(...)',
);

// ---------- 3. iOS 接口 ----------
const iosIface = path.join(
  libDir,
  'ios/Video/RNVAVPlayerPlugin.swift',
);
const iosSrc = readIfExists(iosIface);

add(
  !!iosSrc,
  'iOS 接口文件存在',
  iosSrc ? iosIface.replace(root, '.') : `找不到 ${iosIface}`,
);

if (iosSrc) {
  add(
    /func\s+overridePlayerAsset\s*\(/.test(iosSrc),
    'iOS: overridePlayerAsset 仍在',
    'RNVAVPlayerPlugin.overridePlayerAsset(source:asset:) async -> OverridePlayerAssetResult?',
  );
}

// OverridePlayerAssetType 定义在单独文件里
const assetTypeFile = path.join(
  libDir,
  'ios/Video/DataStructures/OverridePlayerAsset.swift',
);
const assetTypeSrc = readIfExists(assetTypeFile);
add(
  !!assetTypeSrc &&
    /enum\s+OverridePlayerAssetType/.test(assetTypeSrc) &&
    /case\s+full/.test(assetTypeSrc) &&
    /case\s+partial/.test(assetTypeSrc),
  'iOS: OverridePlayerAssetType.full 仍在',
  assetTypeFile.replace(root, '.') + ' — 我们用的是 .full（完全接管 asset，跳过默认 prepare）',
);

// ---------- 输出 ----------
let failed = 0;
console.log('\nreact-native-video 插件契约自检');
console.log('================================');
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) {
    failed++;
  }
  console.log(`[${mark}] ${r.name}`);
  if (r.detail) {
    console.log(`        ${r.detail}`);
  }
}
console.log('================================');
console.log(
  failed === 0
    ? '全部通过：拼接插件依赖的接口都还在。\n（编译通过后仍需跑一遍文档第 17 节的 5 项冒烟）\n'
    : `${failed} 项失败：升级后插件可能失效，请看上面明细，并对照 docs/PLAYLIST_PLUGIN.md 第 17 节处理。\n`,
);

process.exit(failed === 0 ? 0 : 1);
