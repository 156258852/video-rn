#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>

#import "NativePlaylistPlayerView.h"

@interface NativePlaylistPlayerManager : RCTViewManager
@end

@implementation NativePlaylistPlayerManager

RCT_EXPORT_MODULE(NativePlaylistPlayer)

- (UIView *)view
{
  return [[NativePlaylistPlayerView alloc] init];
}

// props
RCT_EXPORT_VIEW_PROPERTY(sources, NSArray)
RCT_EXPORT_VIEW_PROPERTY(paused, BOOL)
RCT_EXPORT_VIEW_PROPERTY(muted, BOOL)
RCT_EXPORT_VIEW_PROPERTY(resizeMode, NSString)
RCT_EXPORT_VIEW_PROPERTY(progressIntervalMs, NSInteger)

// events
RCT_EXPORT_VIEW_PROPERTY(onPlayerLoad, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPlayerProgress, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPlayerSegmentChange, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPlayerEnd, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPlayerBuffer, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPlayerError, RCTBubblingEventBlock)

// 命令：按全局时间 seek
RCT_EXPORT_METHOD(seek:(nonnull NSNumber *)reactTag seconds:(double)seconds)
{
  [self.bridge.uiManager addUIBlock:^(RCTUIManager *uiManager, NSDictionary<NSNumber *, UIView *> *viewRegistry) {
    UIView *view = viewRegistry[reactTag];
    if (![view isKindOfClass:[NativePlaylistPlayerView class]]) {
      return;
    }
    [(NativePlaylistPlayerView *)view seekToTime:seconds];
  }];
}

@end
