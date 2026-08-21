/**
 * RTP Media Gateway Module Entrypoint
 * RFC 3550, RFC 7587, ITU-T G.711 Standard Implementation
 */

export * from './src/types/rtpTypes';
export * from './src/rtpPacketHandler';
export * from './src/jitterBuffer';
export * from './src/audioCodecs';
export * from './src/portAllocator';
export * from './src/mediaBridge';
export * from './src/rtcpReporter';

// Compatibility alias
export { AudioCodecs as AudioTranscoder } from './src/audioCodecs';
