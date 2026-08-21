/**
 * Generic Telecom Call Engine — Shared Common Types
 * Standard compliance: RFC 3261, RFC 3550, RFC 4566, ITU-T E.164
 */

export type CallId = string;
export type TenantId = string;
export type E164PhoneNumber = string;
export type IPAddress = string;
export type PortNumber = number;
export type Milliseconds = number;
export type TimestampISO = string;

export type AudioCodec = 'PCMU' | 'PCMA' | 'OPUS' | 'G722' | 'TELEPHONE_EVENT';

export interface CodecCapability {
  name: AudioCodec;
  payloadType: number;
  clockRate: number;
  channels: number;
  formatParams?: Record<string, string>;
}

export type TelephonyResult<T, E = Error> =
  | { success: true; value: T; error?: never }
  | { success: false; value?: never; error: E };

export interface DisposableResource {
  dispose(): Promise<void> | void;
}
