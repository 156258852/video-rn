const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // 项目在 ~/Desktop 下，macOS TCC 会阻止 watchman 打开该目录，
    // 导致 metro 启动时崩在 `open: ...: Operation not permitted`。
    // 关掉 watchman 后 Metro 走 Node crawler（metro/src/node-haste/
    // DependencyGraph/createFileMap.js:105 `forceNodeFilesystemAPI: !config.resolver.useWatchman`）。
    // 若哪天给终端/watchman 开了「完全磁盘访问权限」，可改回 true 以恢复更快的增量监听。
    // useWatchman: false,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
