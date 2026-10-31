#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"StitchRNPOCModern";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  // 视频 HTTP 缓存：内存 50MB + 磁盘 200MB，回退重播时从缓存读取
  NSURLCache *videoCache = [[NSURLCache alloc] initWithMemoryCapacity:50 * 1024 * 1024
                                                        diskCapacity:200 * 1024 * 1024
                                                          directoryURL:nil];
  [NSURLCache setSharedURLCache:videoCache];

  // 注册原生播放列表合成插件：iOS 侧把多段 MP4 合成一条连续时间轴，
  // 交互 UI 仍然由 RN 自绘。走 NSClassFromString 是为了避免 .mm 引入 Swift 头文件。
  Class playlistPlugin = NSClassFromString(@"StitchRNPOCModern.PlaylistComposerPlugin");
  SEL registerSelector = NSSelectorFromString(@"register");
  NSLog(@"[Playlist] 注册开始 class=%@", playlistPlugin ? @"找到了" : @"❌ 没找到");
  if (playlistPlugin && [playlistPlugin respondsToSelector:registerSelector]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    [playlistPlugin performSelector:registerSelector];
    NSLog(@"[Playlist] ✅ 注册成功");
#pragma clang diagnostic pop
  } else {
    NSLog(@"[Playlist] ❌ 注册失败 class=%@ selectorOK=%@",
          playlistPlugin ? @"找到了" : @"没找到",
          playlistPlugin ? ([playlistPlugin respondsToSelector:registerSelector] ? @"YES" : @"NO") : @"n/a");
  }

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
