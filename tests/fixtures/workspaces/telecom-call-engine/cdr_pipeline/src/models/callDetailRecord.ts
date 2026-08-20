/**
 * Canonical Call Detail Record (CDR) Data Models & Q.850 Mappings
 * Complies with ITU-T Q.850 & E.164
 */

export type CallDisposition = 
  | 'ANSWERED'
  | 'BUSY'
  | 'NO_ANSWER'
  | 'FAILED'
  | 'CANCELLED';

export type CallDirection = 'INBOUND' | 'OUTBOUND' | 'INTERNAL';

export interface Q850Cause {
  code: number;
  description: string;
}

export const Q850_CAUSES: Record<number, string> = {
  16: 'NORMAL_CLEARING',
  17: 'USER_BUSY',
  19: 'NO_ANSWER',
  21: 'CALL_REJECTED',
  34: 'NO_CIRCUIT_AVAILABLE',
  38: 'NETWORK_OUT_OF_ORDER',
  41: 'TEMPORARY_FAILURE',
  102: 'RECOVERY_ON_TIMER_EXPIRY',
};

export interface MediaQualityMetrics {
  callerJitterMs: number;
  calleeJitterMs: number;
  callerPacketLossPct: number;
  calleePacketLossPct: number;
  callerMosEstimate: number;    // Mean Opinion Score: 1.0 to 5.0
  calleeMosEstimate: number;
  audioCodec: 'PCMU' | 'PCMA' | 'OPUS' | 'G722';
  ingressBytes: number;
  egressBytes: number;
}

export interface RawCallEvent {
  tenantId: string;
  callId: string;
  direction: CallDirection;
  caller: string;               // E.164 formatted string or internal extension
  callee: string;               // E.164 formatted string
  ingressTrunkId?: string;
  egressTrunkId?: string;
  sipResponseCode: number;      // e.g. 200, 486, 408, 503
  q850ReasonCode?: number;      // e.g. 16, 17, 34
  startTimeMs: number;          // Epoch ms of INVITE receipt
  ringingTimeMs?: number;       // Epoch ms of 180 Ringing / 183 Session Progress
  answerTimeMs?: number;        // Epoch ms of 200 OK
  endTimeMs: number;            // Epoch ms of BYE / CANCEL / failure
  mediaMetrics?: Partial<MediaQualityMetrics>;
}

export interface NormalizedCdr {
  id: string;                   // UUIDv4
  tenantId: string;
  callId: string;
  direction: CallDirection;
  caller: string;
  callee: string;
  ingressTrunkId: string | null;
  egressTrunkId: string | null;
  disposition: CallDisposition;
  sipResponseCode: number;
  q850Reason: Q850Cause;
  startIso: string;             // ISO-8601 UTC
  answerIso: string | null;     // ISO-8601 UTC or null
  endIso: string;               // ISO-8601 UTC
  totalDurationMs: number;
  setupDurationMs: number;      // Post-Dial Delay (PDD)
  billableDurationSec: number;
  mediaMetrics: MediaQualityMetrics;
  createdAtIso: string;
}
