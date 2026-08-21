/**
 * SIP Dialog Data Models & Lifecycle Types (RFC 3261 Section 12)
 */

import { SipAddressHeader, SipUri } from './sipMessages';

export type DialogState = 'EARLY' | 'CONFIRMED' | 'TERMINATED';

export interface SipDialog {
  dialogId: string;           // Composite key: `${callId}:${localTag}:${remoteTag}`
  tenantId: string;           // Multi-tenant isolation partition key
  callId: string;
  state: DialogState;
  localTag: string;
  remoteTag: string;
  localUri: SipUri;
  remoteUri: SipUri;
  remoteTarget: SipUri;       // Contact URI of the peer (used for Request-URI in mid-dialog requests)
  localCSeq: number;          // Monotonically increasing sequence number for locally initiated requests
  remoteCSeq: number;         // Highest CSeq seen from peer (prevents replay/out-of-order requests)
  routeSet: SipAddressHeader[]; // Record-Route headers determining the SIP proxy path
  secure: boolean;            // TLS / SIPS
  sessionExpiresMs: number;   // RFC 4028 Session Timer expiry
  createdAt: number;
  updatedAt: number;
}
