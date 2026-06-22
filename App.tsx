//@ts-nocheck
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  SafeAreaView,
  StyleSheet,
  View,
  Text,
  StatusBar,
  TouchableOpacity,
  Pressable,
  ScrollView,
  Modal,
  Animated,
  ActivityIndicator,
} from 'react-native';
import Video from 'react-native-video';
import {useAutoHideControls} from './hooks/useAutoHideControls';
import {useScrubber} from './hooks/useScrubber';
import {useVideoSequenceTimelinePlayer} from './hooks/useVideoSequenceTimelinePlayer';
import {colors, spacing, radius, typography, shadow} from './theme/qi';

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function App(): React.JSX.Element {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [muted, setMuted] = useState(false);
  const log = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 19);
    // eslint-disable-next-line no-console
    console.log(`[${ts}] ${msg}`);
  }, []);

  // Stitched clips (URL only). Durations are read from <Video onLoad> for accuracy.
  const CLIPS = useMemo(
    () => [
      {
        uri: 'https://bdcloud-player-new.cdn.bcebos.com/testvideo/mp4/360video/ThaiKongfu.mp4',
      },
      {
        uri: 'https://media.w3.org/2010/05/sintel/trailer.mp4',
      },
      {
        uri: 'https://sf1-cdn-tos.huoshanstatic.com/obj/media-fe/xgplayer_doc_video/mp4/xgplayer-demo-360p.mp4',
      },
    ],
    [],
  );

  const mp4Urls = useMemo(() => CLIPS.map(c => c.uri), [CLIPS]);

  const {
    preloadNode,
    videoSlots,
    activePlayer,

    playing,
    setPlaying,
    playingRef,
    hasCompletedPlayback,

    isLoading,
    isBuffering,

    currentIndex: mp4Index,
    currentTimeRef,

    ready: timelineReady,
    virtualTime,
    totalSafe,
    setIsSeeking,

    seekVirtual,
    queueResumeForCurrentClip,
  } = useVideoSequenceTimelinePlayer({
    urls: mp4Urls,
  });

  const canCompleteMission = hasCompletedPlayback;

  const setPlayingLogged = useCallback(
    (next: boolean, reason: string) => {
      setPlaying(next);
      log(`SET playing=${String(next)} reason=${reason}`);
    },
    [log, setPlaying],
  );

  useEffect(() => {
    log(`STATE playing=${String(playing)}`);
  }, [log, playing]);

  const onScrubCommit = useCallback(
    (t: number, reason: string) => {
      seekVirtual(t);
      setPlayingLogged(true, reason);
      log(
        `scrub commit reason=${reason} t=${t.toFixed(3)} -> seekVirtual + play`,
      );
    },
    [log, seekVirtual, setPlayingLogged],
  );

  const scrubber = useScrubber({
    enabled: timelineReady,
    total: totalSafe,
    baseTime: virtualTime,
    onCommit: onScrubCommit,
    onSeekingChange: setIsSeeking,
  });

  const onVideoBuffer = useCallback(
    (e: any) => {
      log(`buffer isBuffering=${String(!!e?.isBuffering)}`);
    },
    [log],
  );

  const showOverlay = !timelineReady || isLoading || isBuffering;

  const onVideoError = useCallback(
    (e: any) => {
      log(`VIDEO_ERROR ${JSON.stringify(e)}`);
    },
    [log],
  );

  // Toggle our in-app fullscreen modal. The <Video> remounts when moving between
  // inline tree and modal tree, so we capture the current local clip time and queue
  // a pending seek so playback resumes at the same spot in the same clip.
  const toggleFullscreen = useCallback(
    (next: boolean) => {
      let clipIdx = mp4Index;
      let localT = currentTimeRef.current ?? 0;

      if (next) {
        const resume = queueResumeForCurrentClip();
        clipIdx = resume.idx;
        localT = resume.time;
      }

      log(
        `toggleFullscreen next=${String(
          next,
        )} clip=${clipIdx} localT=${localT.toFixed(2)}`,
      );
      setIsFullscreen(next);
    },
    [currentTimeRef, log, mp4Index, queueResumeForCurrentClip],
  );

  // ---- Fullscreen auto-hide controls (iOS-native-player style) ----
  const fsControls = useAutoHideControls({
    enabled: isFullscreen,
    // Treat scrubbing as "paused" so auto-hide timer never fires during drag.
    playing: playing && !scrubber.isSeeking,
    delayMs: 3000,
  });

  const fsControlsVisible = fsControls.visible;
  const fsOpacity = fsControls.opacity;
  const showFsControls = fsControls.show;
  const onFsVideoTap = fsControls.onTap;

  const renderVideo = (extraStyle?: any) => (
    <View style={{flex: 1}}>
      {videoSlots.map((slot, i) => {
        const isActive = i === activePlayer;

        return (
          <Video
            key={i}
            ref={slot.ref}
            source={slot.source}
            paused={slot.paused}
            muted={muted}
            style={[
              StyleSheet.absoluteFill,
              extraStyle,
              {
                opacity: isActive && !isLoading ? 1 : 0,
                zIndex: isActive ? 2 : 1,
              },
            ]}
            resizeMode="contain"
            onLoad={slot.onLoad}
            onProgress={slot.onProgress}
            onEnd={slot.onEnd}
            onBuffer={slot.onBuffer ?? onVideoBuffer}
            onError={onVideoError}
            controls={false}
          />
        );
      })}

      {/* Loading overlay: black bg + spinner, covers all video slots */}
      {showOverlay && (
        <View style={StyleSheet.absoluteFill}>
          <View style={styles.loadingBackdrop} />
          <ActivityIndicator
            size="large"
            color="#ffffff"
            style={styles.loadingSpinner}
          />
        </View>
      )}
    </View>
  );

  const renderFsTopBar = () => (
    <SafeAreaView style={styles.fsTopBar}>
      <TouchableOpacity
        style={styles.fsIconBtn}
        onPress={() => {
          showFsControls();
          toggleFullscreen(false);
        }}
        hitSlop={{top: 12, right: 12, bottom: 12, left: 12}}>
        <Text style={styles.fsIconBtnText}>✕</Text>
      </TouchableOpacity>

      <View style={{flex: 1}} />

      <TouchableOpacity
        style={styles.fsIconBtn}
        onPress={() => {
          showFsControls();
          setMuted(m => !m);
        }}
        hitSlop={{top: 12, right: 12, bottom: 12, left: 12}}>
        <Text style={styles.fsIconBtnText}>{muted ? '🔇' : '🔊'}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );

  const uiTotal = useMemo(() => totalSafe, [totalSafe]);

  const renderFsCenterControls = () => (
    <View style={styles.fsCenterRow} pointerEvents="box-none">
      <TouchableOpacity
        style={styles.fsCenterBtn}
        onPress={() => {
          showFsControls();
          seekVirtual(Math.max(0, virtualTime - 10));
        }}>
        <Text style={styles.fsCenterSkipText}>10</Text>
        <Text style={styles.fsCenterArrowL}>⟲</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.fsCenterPlay}
        onPress={() => {
          showFsControls();
          const next = !playingRef.current;
          setPlayingLogged(next, 'togglePlayButton');
        }}>
        <Text style={styles.fsCenterPlayText}>{playing ? '❚❚' : '▶︎'}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.fsCenterBtn}
        onPress={() => {
          showFsControls();
          seekVirtual(Math.min(uiTotal, virtualTime + 10));
        }}>
        <Text style={styles.fsCenterSkipText}>10</Text>
        <Text style={styles.fsCenterArrowR}>⟳</Text>
      </TouchableOpacity>
    </View>
  );

  const renderFsBottomBar = () => {
    const remaining = Math.max(0, uiTotal - scrubber.displayedTime);

    return (
      <SafeAreaView style={styles.fsBottomBar}>
        <Pressable
          style={[
            styles.scrubTrack,
            styles.fsScrubTrack,
            !timelineReady && styles.scrubTrackDisabled,
          ]}
          ref={scrubber.trackRef as any}
          onLayout={scrubber.onTrackLayout}
          onTouchStart={showFsControls}
          disabled={!timelineReady}>
          {/* Visual rail is thin (4px), but touch target stays 18px */}
          <View style={styles.fsRail} />
          <View style={[styles.fsFill, {width: scrubber.fillW}]} />
          <View style={[styles.scrubThumb, {left: scrubber.thumbLeft}]} />
          <View style={styles.scrubOverlay} {...scrubber.panHandlers} />
        </Pressable>

        <View style={styles.fsTimeRow}>
          <Text style={styles.fsTimeText} numberOfLines={1}>
            {fmtTime(scrubber.displayedTime)}
          </Text>
          <Text style={styles.fsTimeTextDim} numberOfLines={1}>
            -{fmtTime(remaining)}
          </Text>
        </View>
      </SafeAreaView>
    );
  };

  const onViewVideoPress = useCallback(() => {
    setPlayingLogged(true, 'viewVideoTap');
    toggleFullscreen(true);
  }, [setPlayingLogged, toggleFullscreen]);

  const renderMissionScreen = () => (
    <View style={styles.missionScreen}>
      {/* Top nav */}
      <View style={styles.topNav}>
        <TouchableOpacity
          style={styles.topNavBtn}
          hitSlop={{top: 12, right: 12, bottom: 12, left: 12}}>
          <Text style={styles.topNavChevron}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.topNavTitle} numberOfLines={1}>
          AIA Points mission
        </Text>
        <TouchableOpacity
          style={styles.topNavHelp}
          hitSlop={{top: 12, right: 12, bottom: 12, left: 12}}>
          <Text style={styles.topNavHelpText}>?</Text>
        </TouchableOpacity>
      </View>

      {/* Hero placeholder */}
      <View style={styles.heroBox} />

      <View style={styles.missionBody}>
        <Text style={styles.missionH1}>
          Learn more about your{`\n`}Employee benefit
        </Text>

        <View style={styles.pointsRow}>
          <View style={styles.aiaBadge}>
            <Text style={styles.aiaBadgeText}>AIA</Text>
          </View>
          <Text style={styles.pointsText}>Earn 500 points</Text>
        </View>

        <Text style={styles.dateText}>From 01 Jan 2023 to 30 Jan 2023</Text>

        <View style={styles.divider} />

        <Text style={styles.sectionLabel}>Your progress</Text>

        <View style={styles.progressCard}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>The employee benefit video</Text>
            <View
              style={[
                styles.checkCircle,
                !canCompleteMission && styles.checkCirclePending,
              ]}>
              <Text
                style={[
                  styles.checkMark,
                  !canCompleteMission && styles.checkMarkPending,
                ]}>
                {canCompleteMission ? '✓' : '○'}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.viewVideoRow}
            onPress={onViewVideoPress}
            activeOpacity={0.7}>
            <Text style={styles.viewVideoText}>View video</Text>
            <Text style={styles.chevronPink}>›</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>How it works</Text>
        <View style={styles.listBlock}>
          {[
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
            'Sed do eiusmod tempor incididunt ut labore et dolore magna.',
            'Ut enim ad minim veniam, quis nostrud exercitation ullamco.',
            'Duis aute irure dolor in reprehenderit in voluptate velit.',
          ].map((line, i) => (
            <View key={i} style={styles.numberedItem}>
              <Text style={styles.numberedIndex}>{i + 1}.</Text>
              <Text style={styles.numberedText}>{line}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionLabel}>Who can join</Text>
        <View style={styles.listBlock}>
          {[
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
            'Sed do eiusmod tempor incididunt ut labore et dolore magna.',
          ].map((line, i) => (
            <View key={i} style={styles.bulletItem}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{line}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.terms}>Terms and conditions apply.</Text>
      </View>
    </View>
  );

  return (
    <>
      <StatusBar barStyle="dark-content" />
      {preloadNode}
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.missionScroll}>
          {renderMissionScreen()}
        </ScrollView>

        {/* Sticky bottom CTA */}
        <SafeAreaView style={styles.ctaBar}>
          <TouchableOpacity
            style={[
              styles.ctaButton,
              !canCompleteMission && styles.ctaButtonDisabled,
            ]}
            activeOpacity={canCompleteMission ? 0.85 : 1}
            disabled={!canCompleteMission}>
            <Text style={styles.ctaButtonText}>
              {canCompleteMission ? 'Complete' : 'Watch video to complete'}
            </Text>
          </TouchableOpacity>
        </SafeAreaView>
      </SafeAreaView>

      <Modal
        visible={isFullscreen}
        animationType="fade"
        supportedOrientations={['portrait', 'landscape']}
        onRequestClose={() => toggleFullscreen(false)}>
        <StatusBar hidden />
        <View style={styles.fsRoot}>
          <Pressable style={styles.fsVideoWrap} onPress={onFsVideoTap}>
            {renderVideo(styles.fsVideo)}
          </Pressable>

          {/* Top bar overlay */}
          <Animated.View
            pointerEvents={fsControlsVisible ? 'box-none' : 'none'}
            style={[styles.fsTopOverlay, {opacity: fsOpacity}]}>
            {renderFsTopBar()}
          </Animated.View>

          {/* Center play controls overlay — hidden during loading */}
          <Animated.View
            pointerEvents={
              !showOverlay && fsControlsVisible ? 'box-none' : 'none'
            }
            style={[
              styles.fsCenterOverlay,
              {opacity: showOverlay ? 0 : fsOpacity},
            ]}>
            {renderFsCenterControls()}
          </Animated.View>

          {/* Bottom seek bar overlay */}
          <Animated.View
            pointerEvents={fsControlsVisible ? 'box-none' : 'none'}
            style={[styles.fsBottomOverlay, {opacity: fsOpacity}]}>
            {renderFsBottomBar()}
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: colors.surface.page},

  // ---- Mission screen ----
  missionScroll: {paddingBottom: 120},
  missionScreen: {flex: 1, backgroundColor: colors.surface.page},

  topNav: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.s8,
    backgroundColor: colors.surface.default,
  },
  topNavBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topNavChevron: {
    fontSize: 30,
    color: colors.text.default,
    fontWeight: '500',
    marginTop: -4,
  },
  topNavTitle: {
    flex: 1,
    textAlign: 'center',
    ...typography.body2,
    color: colors.text.default,
  },
  topNavHelp: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.text.default,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.s8,
  },
  topNavHelpText: {fontSize: 16, fontWeight: '700', color: colors.text.default},

  heroBox: {height: 220, backgroundColor: '#d1d5db'},

  missionBody: {
    paddingHorizontal: spacing.s24,
    paddingTop: spacing.s24,
    paddingBottom: spacing.s24,
  },

  missionH1: {
    ...typography.h3,
    color: colors.text.default,
    marginBottom: spacing.s16,
  },

  pointsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.s4,
  },
  aiaBadge: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.brand.red,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.s8,
  },
  aiaBadgeText: {
    color: colors.text.inverse,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  pointsText: {...typography.h6, color: colors.text.default},

  dateText: {
    ...typography.body3,
    color: colors.text.subdued,
    marginTop: 2,
    marginLeft: 38,
  },

  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border.subtle,
    marginVertical: spacing.s24,
  },

  sectionLabel: {
    ...typography.body2,
    color: colors.text.default,
    marginTop: spacing.s8,
    marginBottom: spacing.s12,
  },

  progressCard: {
    backgroundColor: colors.surface.default,
    borderRadius: radius.md,
    paddingHorizontal: spacing.s16,
    paddingVertical: spacing.s16,
    marginBottom: spacing.s24,
    ...shadow.card,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.s8,
  },
  cardTitle: {flex: 1, ...typography.body2, color: colors.text.default},
  checkCircle: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: colors.status.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: {
    color: colors.text.inverse,
    fontSize: 13,
    fontWeight: '900',
    marginTop: -1,
  },
  checkCirclePending: {
    backgroundColor: colors.border.default,
  },
  checkMarkPending: {
    color: colors.text.subdued,
  },

  viewVideoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.s4,
  },
  viewVideoText: {
    ...typography.body3,
    color: colors.text.default,
    textDecorationLine: 'underline',
    fontWeight: '600',
  },
  chevronPink: {
    fontSize: 22,
    color: colors.brand.red,
    fontWeight: '700',
    marginLeft: spacing.s8,
  },

  listBlock: {marginBottom: spacing.s24},
  numberedItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.s8,
  },
  numberedIndex: {
    ...typography.body3,
    color: colors.text.default,
    width: 22,
    fontWeight: '700',
  },
  numberedText: {flex: 1, ...typography.body3, color: colors.text.subdued},
  bulletItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.s8,
  },
  bulletDot: {
    fontSize: 16,
    color: colors.text.subdued,
    width: 18,
    lineHeight: 20,
  },
  bulletText: {flex: 1, ...typography.body3, color: colors.text.subdued},

  terms: {
    ...typography.caption,
    color: colors.text.subdued,
    marginTop: spacing.s4,
  },

  ctaBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 10,
    backgroundColor: colors.surface.default,
    paddingHorizontal: spacing.s16,
    paddingTop: spacing.s12,
    paddingBottom: spacing.s40,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.subtle,
  },
  ctaButton: {
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.brand.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaButtonDisabled: {
    backgroundColor: colors.border.default,
  },
  ctaButtonText: {
    ...typography.button,
    color: colors.text.inverse,
    letterSpacing: 0.3,
  },

  fsRoot: {flex: 1, backgroundColor: '#000'},
  fsVideoWrap: {flex: 1, justifyContent: 'center', alignItems: 'stretch'},
  fsVideo: {flex: 1, width: '100%', height: '100%'},

  fsTopOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  fsTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
  },
  fsIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fsIconBtnText: {color: '#fff', fontSize: 20, fontWeight: '700'},

  fsCenterOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fsCenterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fsCenterBtn: {
    width: 64,
    height: 64,
    marginHorizontal: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fsCenterSkipText: {
    position: 'absolute',
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    marginTop: 2,
  },
  fsCenterArrowL: {color: '#fff', fontSize: 44, fontWeight: '300'},
  fsCenterArrowR: {color: '#fff', fontSize: 44, fontWeight: '300'},
  fsCenterPlay: {
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fsCenterPlayText: {color: '#fff', fontSize: 40, fontWeight: '800'},

  fsBottomOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  fsBottomBar: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 6,
  },
  fsScrubTrack: {
    // Keep container's touch height (18px). Draw the thin rail separately.
    backgroundColor: 'transparent',
  },
  fsRail: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 4,
    top: 7, // (18 - 4) / 2
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  fsFill: {
    position: 'absolute',
    left: 0,
    height: 4,
    top: 7,
    borderRadius: 2,
    backgroundColor: '#ffffff',
  },
  fsTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  fsTimeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  fsTimeTextDim: {
    color: '#d7dbe3',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  scrubTrack: {
    width: '100%',
    height: 18,
    borderRadius: 9,
    backgroundColor: '#1b2130',
    overflow: 'hidden',
    marginBottom: 10,
    justifyContent: 'center',
  },
  scrubOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  scrubTrackDisabled: {
    opacity: 0.5,
  },
  scrubFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#ffffff',
  },
  scrubThumb: {
    position: 'absolute',
    top: 1,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#ffffff',
  },

  loadingBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  loadingSpinner: {
    ...StyleSheet.absoluteFillObject,
  },
});
