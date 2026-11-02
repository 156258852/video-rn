#import "NativePlaylistPlayerView.h"

#import <AVFoundation/AVFoundation.h>
#import <React/RCTLog.h>

@interface NativePlaylistPlayerView ()

@property (nonatomic, strong, nullable) AVQueuePlayer *player;
@property (nonatomic, strong) NSArray<AVPlayerItem *> *items;
@property (nonatomic, strong) NSArray<NSNumber *> *durations; // 每段时长（秒）
@property (nonatomic, strong) NSArray<NSNumber *> *offsets;   // 每段起点（全局秒）
@property (nonatomic, assign) NSInteger currentIndex;

@property (nonatomic, strong, nullable) id timeObserver;
@property (nonatomic, strong) NSMutableArray<id> *endObservers;

@end

static void *NativePlaylistPlayerCurrentItemContext = &NativePlaylistPlayerCurrentItemContext;
static void *NativePlaylistPlayerStatusContext = &NativePlaylistPlayerStatusContext;
static void *NativePlaylistPlayerBufferEmptyContext = &NativePlaylistPlayerBufferEmptyContext;
static void *NativePlaylistPlayerBufferFullContext = &NativePlaylistPlayerBufferFullContext;

@implementation NativePlaylistPlayerView

+ (Class)layerClass
{
  return [AVPlayerLayer class];
}

- (AVPlayerLayer *)playerLayer
{
  return (AVPlayerLayer *)self.layer;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    _paused = YES;
    _muted = NO;
    _resizeMode = @"contain";
    _progressIntervalMs = 500;
    _items = @[];
    _durations = @[];
    _offsets = @[];
    _endObservers = [NSMutableArray array];
    self.playerLayer.videoGravity = AVLayerVideoGravityResizeAspect;
  }
  return self;
}

- (void)dealloc
{
  [self teardown];
}

- (void)removeFromSuperview
{
  [self teardown];
  [super removeFromSuperview];
}

#pragma mark - props

- (void)setSources:(NSArray<NSString *> *)sources
{
  if ([sources isEqualToArray:_sources]) {
    return;
  }
  _sources = [sources copy];
  [self reload];
}

- (void)setPaused:(BOOL)paused
{
  _paused = paused;
  [self applyPaused];
}

- (void)setMuted:(BOOL)muted
{
  _muted = muted;
  self.player.muted = muted;
}

- (void)setResizeMode:(NSString *)resizeMode
{
  _resizeMode = [resizeMode copy];
  [self applyGravity];
}

- (void)setProgressIntervalMs:(NSInteger)progressIntervalMs
{
  _progressIntervalMs = progressIntervalMs > 0 ? progressIntervalMs : 500;
  [self installProgressObserver];
}

#pragma mark - 装载

- (void)reload
{
  [self teardown];

  NSMutableArray<NSURL *> *urls = [NSMutableArray array];
  for (NSString *s in self.sources) {
    NSURL *url = [NSURL URLWithString:s];
    if (url) {
      [urls addObject:url];
    }
  }
  if (urls.count == 0) {
    return;
  }

  NSMutableArray<AVPlayerItem *> *items = [NSMutableArray array];
  for (NSURL *url in urls) {
    AVPlayerItem *item = [AVPlayerItem playerItemWithURL:url];
    item.preferredForwardBufferDuration = 10;
    [items addObject:item];
  }
  self.items = items;
  self.currentIndex = 0;

  AVQueuePlayer *player = [AVQueuePlayer queuePlayerWithItems:items];
  player.muted = self.muted;
  self.player = player;
  self.playerLayer.player = player;

  [self applyGravity];
  [self observePlayer:player];
  [self observeItem:items.firstObject];
  [self installProgressObserver];
  [self applyPaused];

  [self loadDurationsOfURLs:urls];
}

#pragma mark - 每段时长（算好总时长再抛 onLoad）

- (void)loadDurationsOfURLs:(NSArray<NSURL *> *)urls
{
  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    NSMutableArray<NSNumber *> *durations = [NSMutableArray arrayWithCapacity:urls.count];
    for (NSURL *url in urls) {
      AVURLAsset *asset = [AVURLAsset assetWithURL:url];
      dispatch_semaphore_t sema = dispatch_semaphore_create(0);
      __block double seconds = 0;
      [asset loadValuesAsynchronouslyForKeys:@[@"duration"] completionHandler:^{
        seconds = CMTimeGetSeconds(asset.duration);
        dispatch_semaphore_signal(sema);
      }];
      dispatch_semaphore_wait(sema, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)));
      [durations addObject:@(isfinite(seconds) && seconds > 0 ? seconds : 0)];
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      [self applyDurations:durations];
    });
  });
}

- (void)applyDurations:(NSArray<NSNumber *> *)durations
{
  self.durations = durations;

  NSMutableArray<NSNumber *> *offsets = [NSMutableArray arrayWithCapacity:durations.count];
  double acc = 0;
  for (NSNumber *d in durations) {
    [offsets addObject:@(acc)];
    acc += d.doubleValue;
  }
  self.offsets = offsets;

  if (self.onPlayerLoad) {
    self.onPlayerLoad(@{@"duration": @(acc), @"durations": durations});
  }
  [self emitProgress];
  [self applyPaused];
}

- (void)correctDurationOfItem:(AVPlayerItem *)item
{
  NSInteger index = [self.items indexOfObjectIdenticalTo:item];
  if (index == NSNotFound || index >= (NSInteger)self.durations.count) {
    return;
  }
  double seconds = CMTimeGetSeconds(item.duration);
  if (!isfinite(seconds) || seconds <= 0) {
    return;
  }
  if (fabs(self.durations[index].doubleValue - seconds) < 0.05) {
    return;
  }
  NSMutableArray<NSNumber *> *durations = [self.durations mutableCopy];
  durations[index] = @(seconds);
  [self applyDurations:durations];
}

- (double)totalDuration
{
  double lastOffset = self.offsets.lastObject.doubleValue;
  double lastDuration = self.durations.lastObject.doubleValue;
  return self.offsets.count > 0 ? lastOffset + lastDuration : 0;
}

#pragma mark - 命令

- (void)seekToTime:(double)seconds
{
  if (self.offsets.count == 0) {
    [self.player seekToTime:CMTimeMakeWithSeconds(MAX(0, seconds), NSEC_PER_SEC)];
    return;
  }

  double target = MAX(0, MIN(seconds, [self totalDuration]));
  NSInteger index = 0;
  for (NSInteger i = 0; i < (NSInteger)self.offsets.count; i++) {
    if (target >= self.offsets[i].doubleValue) {
      index = i;
    }
  }
  double local = target - self.offsets[index].doubleValue;

  if (index != self.currentIndex) {
    // AVQueuePlayer 播过的 item 会出队，跨段回拖必须重建队列
    [self rebuildQueueFromIndex:index];
  }

  __weak typeof(self) weakSelf = self;
  [self.player seekToTime:CMTimeMakeWithSeconds(local, NSEC_PER_SEC)
          toleranceBefore:kCMTimeZero
           toleranceAfter:kCMTimeZero
        completionHandler:^(BOOL finished) {
          [weakSelf emitProgress];
        }];
}

- (void)rebuildQueueFromIndex:(NSInteger)index
{
  if (index >= (NSInteger)self.items.count) {
    return;
  }
  // 跨段重建前先把旧 item 的 KVO 摘掉，否则同一个 item 会被重复观察，
  // 后续 currentItem 变化时还会回调到已经出队的 item 上。
  if (index != self.currentIndex && self.currentIndex < (NSInteger)self.items.count) {
    [self unobserveItem:self.items[self.currentIndex]];
  }
  self.currentIndex = index;
  [self.player removeAllItems];
  for (NSInteger i = index; i < (NSInteger)self.items.count; i++) {
    [self.player insertItem:self.items[i] afterItem:nil];
  }
  [self observeItem:self.items[index]];
  [self emitSegmentChange:index];
  [self applyPaused];
}

#pragma mark - 观察

- (void)observePlayer:(AVQueuePlayer *)player
{
  [player addObserver:self
           forKeyPath:@"currentItem"
              options:NSKeyValueObservingOptionNew
              context:NativePlaylistPlayerCurrentItemContext];

  for (NSInteger i = 0; i < (NSInteger)self.items.count; i++) {
    AVPlayerItem *item = self.items[i];
    __weak typeof(self) weakSelf = self;
    id observer = [[NSNotificationCenter defaultCenter]
        addObserverForName:AVPlayerItemDidPlayToEndTimeNotification
                    object:item
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *note) {
                  if (i >= (NSInteger)weakSelf.items.count - 1 && weakSelf.onPlayerEnd) {
                    weakSelf.onPlayerEnd(@{@"end": @YES});
                  }
                }];
    [self.endObservers addObject:observer];
  }
}

- (void)observeItem:(AVPlayerItem *)item
{
  if (!item) {
    return;
  }
  [item addObserver:self
         forKeyPath:@"status"
            options:NSKeyValueObservingOptionNew
            context:NativePlaylistPlayerStatusContext];
  [item addObserver:self
         forKeyPath:@"isPlaybackBufferEmpty"
            options:NSKeyValueObservingOptionNew
            context:NativePlaylistPlayerBufferEmptyContext];
  [item addObserver:self
         forKeyPath:@"isPlaybackLikelyToKeepUp"
            options:NSKeyValueObservingOptionNew
            context:NativePlaylistPlayerBufferFullContext];
}

- (void)unobserveItem:(AVPlayerItem *)item
{
  if (!item) {
    return;
  }
  @try {
    [item removeObserver:self forKeyPath:@"status"];
    [item removeObserver:self forKeyPath:@"isPlaybackBufferEmpty"];
    [item removeObserver:self forKeyPath:@"isPlaybackLikelyToKeepUp"];
  } @catch (NSException *exception) {
    // 已经移除过，忽略
  }
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary *)change
                       context:(void *)context
{
  if (context == NativePlaylistPlayerCurrentItemContext) {
    AVPlayerItem *item = self.player.currentItem;
    NSInteger index = [self.items indexOfObjectIdenticalTo:item];
    if (index != NSNotFound && index != self.currentIndex) {
      [self unobserveItem:self.items[self.currentIndex]];
      self.currentIndex = index;
      [self observeItem:item];
      [self emitSegmentChange:index];
    }
    return;
  }

  if (context == NativePlaylistPlayerStatusContext) {
    AVPlayerItem *item = (AVPlayerItem *)object;
    if (item.status == AVPlayerItemStatusFailed) {
      if (self.onPlayerError) {
        self.onPlayerError(@{@"error": item.error.localizedDescription ?: @"unknown"});
      }
    } else if (item.status == AVPlayerItemStatusReadyToPlay) {
      // 用播放器实际拿到的时长回填（比 AVURLAsset 探测更准），
      // 探测失败/超时时这里是唯一能拿到真实时长的地方。
      [self correctDurationOfItem:item];
      if (self.onPlayerBuffer) {
        self.onPlayerBuffer(@{@"isBuffering": @NO});
      }
    }
    return;
  }

  if (context == NativePlaylistPlayerBufferEmptyContext) {
    AVPlayerItem *item = (AVPlayerItem *)object;
    if (self.onPlayerBuffer) {
      self.onPlayerBuffer(@{@"isBuffering": @(item.isPlaybackBufferEmpty)});
    }
    return;
  }

  if (context == NativePlaylistPlayerBufferFullContext) {
    AVPlayerItem *item = (AVPlayerItem *)object;
    if (item.isPlaybackLikelyToKeepUp && self.onPlayerBuffer) {
      self.onPlayerBuffer(@{@"isBuffering": @NO});
    }
    return;
  }

  [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

- (void)installProgressObserver
{
  if (self.timeObserver) {
    [self.player removeTimeObserver:self.timeObserver];
    self.timeObserver = nil;
  }
  if (!self.player) {
    return;
  }

  double interval = MAX(0.1, self.progressIntervalMs / 1000.0);
  __weak typeof(self) weakSelf = self;
  self.timeObserver = [self.player
      addPeriodicTimeObserverForInterval:CMTimeMakeWithSeconds(interval, NSEC_PER_SEC)
                                   queue:dispatch_get_main_queue()
                              usingBlock:^(CMTime time) {
                                [weakSelf emitProgress];
                              }];
}

#pragma mark - 事件

- (void)emitProgress
{
  AVPlayerItem *item = self.player.currentItem;
  if (!item) {
    return;
  }
  double local = CMTimeGetSeconds(item.currentTime);
  if (!isfinite(local) || local < 0) {
    local = 0;
  }
  double base = self.currentIndex < (NSInteger)self.offsets.count
      ? self.offsets[self.currentIndex].doubleValue
      : 0;

  if (self.onPlayerProgress) {
    self.onPlayerProgress(@{
      @"currentTime": @(base + local),
      @"segmentIndex": @(self.currentIndex),
      @"segmentTime": @(local),
      @"duration": @([self totalDuration]),
    });
  }
}

- (void)emitSegmentChange:(NSInteger)index
{
  if (self.onPlayerSegmentChange) {
    self.onPlayerSegmentChange(@{@"index": @(index)});
  }
}

#pragma mark - 状态

- (void)applyPaused
{
  if (self.paused) {
    [self.player pause];
  } else {
    [self.player play];
  }
}

- (void)applyGravity
{
  if ([self.resizeMode isEqualToString:@"cover"]) {
    self.playerLayer.videoGravity = AVLayerVideoGravityResizeAspectFill;
  } else if ([self.resizeMode isEqualToString:@"stretch"]) {
    self.playerLayer.videoGravity = AVLayerVideoGravityResize;
  } else {
    self.playerLayer.videoGravity = AVLayerVideoGravityResizeAspect;
  }
}

#pragma mark - 清理

- (void)teardown
{
  if (self.timeObserver) {
    [self.player removeTimeObserver:self.timeObserver];
    self.timeObserver = nil;
  }

  for (id observer in self.endObservers) {
    [[NSNotificationCenter defaultCenter] removeObserver:observer];
  }
  [self.endObservers removeAllObjects];

  @try {
    [self.player removeObserver:self forKeyPath:@"currentItem"];
  } @catch (NSException *exception) {
  }
  if (self.currentIndex < (NSInteger)self.items.count) {
    [self unobserveItem:self.items[self.currentIndex]];
  }

  [self.player pause];
  [self.player removeAllItems];
  self.playerLayer.player = nil;
  self.player = nil;
  self.items = @[];
  self.durations = @[];
  self.offsets = @[];
  self.currentIndex = 0;
}

@end
