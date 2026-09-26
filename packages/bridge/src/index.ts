export * from './types';
export * from './validate';
export { BridgeEmitter, frozenCopy } from './emitter';
export { BRIDGE_META_NAME, decodeFrame, encodeFrame, parseBridgeMeta, randomHex, readBridgeMeta, type BridgeMeta, type MetaDocument } from './wire';
export { idleState, nextIndex, previousIndex, silentFrame } from './playback-rules';
export {
  ANDROID_INTERFACE,
  detectTransport,
  directTransport,
  loopbackTransport,
  shimTransport,
  type HostWindow,
  type Transport,
} from './transport';
export { createBridgeClient, type BridgeClient, type BridgeClientOptions } from './client';
export {
  LINK_REFRESH_MARGIN_MS,
  PLAY_LOG_AFTER_SEC,
  REGULAR_MIN_WIDTH_PT,
  START_FADE_SEC,
  WebBridgeAdapter,
  webLayout,
  type WebAdapterEnvironment,
  type WebAdapterOptions,
  type WebAdapterProviders,
  type WebAudioEngine,
  type WebAudioEngineEvents,
  type WebAudioEngineFactory,
  type WebContextData,
  type WebTrack,
  type WebTrackList,
} from './web-adapter';
export { MOCK_LAYOUT, MOCK_TRACKS, MockBridge, type MockBridgeOptions, type MockCall, type MockTrack } from './mock';
export {
  BRIDGE_LIST_TTL_MS,
  BridgeTrackSource,
  accessFor,
  bridgeTrackUrl,
  trackIdFromUrl,
  type BridgeTrackSourceOptions,
  type PlayerTrack,
  type StreamAccess,
  type TrackList,
  type TrackSource,
} from './bridge-track-source';
export { BridgeAudioEngine, type BridgeAudioEngineOptions, type BridgeEngineEvents } from './bridge-audio-engine';
