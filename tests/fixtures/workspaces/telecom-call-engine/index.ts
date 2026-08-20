/**
 * Generic Telecom Call Engine — Root Unified Entrypoint
 * Re-exports all micro-modules and shared common types.
 */

// Shared Common Abstractions
export * from './src/common/types';
export * from './src/common/errors';
export * from './src/common/logger';
export * from './src/common/events';

// Module 1: SIP Signaling Service
export * as SipSignaling from './sip_signaling_service';
export {
  SipServer,
  SipStateMachine,
  SipStateMachine as SipTransactionManager,
  DialogManager,
  SdpNegotiator,
  CallRouter,
  CallTransferCoordinator,
  CallTransferCoordinator as TransferController,
  CallState,
} from './sip_signaling_service';

// Module 2: RTP Media Gateway
export * as RtpMedia from './rtp_media_gateway';
export {
  PortAllocator,
  JitterBuffer,
  AudioCodecs,
  AudioCodecs as AudioTranscoder,
  MediaBridge,
  RtcpReporter,
  RtpPacketHandler,
} from './rtp_media_gateway';

// Module 3: CDR Pipeline
export * as CdrPipeline from './cdr_pipeline';
export {
  CdrIngestionService,
  CdrIngestionService as CdrIngestion,
  TariffRatingEngine,
  TariffRatingEngine as RatingEngine,
  TenantQuotaTracker,
  BatchSqlLogger,
  E164RadixTrie,
} from './cdr_pipeline';

// Module 4: PBX Device Manager
export * as PbxDeviceManager from './pbx_device_manager';
export {
  DeviceRegistry,
  DigestAuthenticator,
  DigestAuthenticator as DigestAuth,
  TrunkAllocator,
  CtiWebhookDispatcher,
  CtiWebhookDispatcher as WebhookDispatcher,
} from './pbx_device_manager';
