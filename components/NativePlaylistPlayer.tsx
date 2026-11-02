import React, {forwardRef, useImperativeHandle, useRef} from 'react';
import {
  Platform,
  StyleProp,
  StyleSheet,
  UIManager,
  ViewStyle,
  findNodeHandle,
  requireNativeComponent,
} from 'react-native';

/**
 * 原生播放列表播放器（iOS）。
 *
 * 和 hooks/usePlaylistPlayback.ts 需要的接口一一对应，所以 hook 不用改：
 *   props  : sources / paused / muted
 *   命令   : seek(全局时间)
 *   事件   : onLoad(duration) / onProgress(currentTime) / onEnd / onBuffer / onError
 *
 * Android 还没实现同构组件，所以 Android 这里仍然返回 null，
 * 由 App.tsx 走原来的 <Video> 路径。
 */

export type NativePlaylistPlayerProps = {
  sources: string[];
  paused: boolean;
  muted?: boolean;
  resizeMode?: 'contain' | 'cover' | 'stretch';
  progressIntervalMs?: number;
  style?: StyleProp<ViewStyle>;
  onLoad?: (e: {duration: number; durations?: number[]}) => void;
  onProgress?: (e: {
    currentTime: number;
    segmentIndex?: number;
    segmentTime?: number;
    duration?: number;
  }) => void;
  onSegmentChange?: (e: {index: number}) => void;
  onEnd?: () => void;
  onBuffer?: (e: {isBuffering: boolean}) => void;
  onError?: (e: {error: string}) => void;
};

export type NativePlaylistPlayerHandle = {
  seek: (seconds: number) => void;
};

const NativeView: any =
  Platform.OS === 'ios' ? requireNativeComponent('NativePlaylistPlayer') : null;

const NativePlaylistPlayer = forwardRef<
  NativePlaylistPlayerHandle,
  NativePlaylistPlayerProps
>((props, ref) => {
  const nodeRef = useRef<any>(null);

  useImperativeHandle(
    ref,
    () => ({
      seek: (seconds: number) => {
        const handle = findNodeHandle(nodeRef.current);
        if (handle == null) {
          return;
        }
        UIManager.dispatchViewManagerCommand(handle, 'seek', [seconds]);
      },
    }),
    [],
  );

  if (!NativeView) {
    return null;
  }

  return (
    <NativeView
      ref={nodeRef}
      style={props.style ?? StyleSheet.absoluteFill}
      sources={props.sources}
      paused={props.paused}
      muted={!!props.muted}
      resizeMode={props.resizeMode ?? 'contain'}
      progressIntervalMs={props.progressIntervalMs ?? 500}
      onPlayerLoad={(e: any) => props.onLoad?.(e.nativeEvent)}
      onPlayerProgress={(e: any) => props.onProgress?.(e.nativeEvent)}
      onPlayerSegmentChange={(e: any) => props.onSegmentChange?.(e.nativeEvent)}
      onPlayerEnd={() => props.onEnd?.()}
      onPlayerBuffer={(e: any) => props.onBuffer?.(e.nativeEvent)}
      onPlayerError={(e: any) => props.onError?.(e.nativeEvent)}
    />
  );
});

export default NativePlaylistPlayer;
