#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <React/RCTComponent.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * 原生播放列表播放器（一个 video，不拼接）。
 *
 * RN 传一个 url 列表进来，原生用 AVQueuePlayer 顺序播（内部自动预缓冲下一段），
 * 并把「全局时间」算好通过事件抛给 RN。
 */
@interface NativePlaylistPlayerView : UIView

// props
@property (nonatomic, copy) NSArray<NSString *> *sources;
@property (nonatomic, assign) BOOL paused;
@property (nonatomic, assign) BOOL muted;
@property (nonatomic, copy) NSString *resizeMode;
@property (nonatomic, assign) NSInteger progressIntervalMs;

// events
@property (nonatomic, copy, nullable) RCTBubblingEventBlock onPlayerLoad;          // {duration, durations}
@property (nonatomic, copy, nullable) RCTBubblingEventBlock onPlayerProgress;      // {currentTime, segmentIndex, segmentTime, duration}
@property (nonatomic, copy, nullable) RCTBubblingEventBlock onPlayerSegmentChange; // {index}
@property (nonatomic, copy, nullable) RCTBubblingEventBlock onPlayerEnd;
@property (nonatomic, copy, nullable) RCTBubblingEventBlock onPlayerBuffer;        // {isBuffering}
@property (nonatomic, copy, nullable) RCTBubblingEventBlock onPlayerError;         // {error}

// 命令：按全局时间 seek
- (void)seekToTime:(double)seconds;

@end

NS_ASSUME_NONNULL_END
