/**
 * Carrier Trunk Group & Channel Lease Models
 */

export type TrunkStatus = 'ACTIVE' | 'DEGRADED' | 'DOWN';

export interface Trunk {
  id: string;
  trunkGroupId: string;
  name: string;
  host: string;
  port: number;
  weight: number;                   // Positive integer (e.g. 10, 20, 50)
  maxChannels: number;              // Concurrency ceiling
  activeChannels: number;           // Currently leased channels
  status: TrunkStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureIso?: string;
  failoverStatusCodes: number[];    // e.g. [503, 408, 500, 480]
}

export interface TrunkGroup {
  id: string;
  tenantId: string;
  name: string;
  trunks: Trunk[];
  strategy: 'WEIGHTED_ROUND_ROBIN' | 'STRICT_PRIORITY';
}

export interface TrunkLease {
  leaseId: string;
  trunkId: string;
  trunkGroupId: string;
  callId: string;
  allocatedAtIso: string;
  targetHost: string;
  targetPort: number;
}
