/**
 * SIP Endpoint & Contact Binding Models
 */

export type EndpointStatus = 'REGISTERED' | 'UNREGISTERED' | 'OFFLINE' | 'BUSY';

export interface ContactBinding {
  contactUri: string;               // e.g. "sip:1001@192.168.1.50:5060;transport=udp"
  userAgent: string;                // e.g. "Generic-SIP-Phone/v2.1"
  callId: string;
  cseq: number;
  registeredAtIso: string;
  expiresAtIso: string;
  expiresSeconds: number;
  sourceIp: string;
  sourcePort: number;
  natReceived?: string;             // RFC 3581 received IP
  natRport?: number;                // RFC 3581 rport
}

export interface SipEndpoint {
  aor: string;                      // Address of Record: e.g. "sip:1001@telecom.local"
  tenantId: string;
  extension: string;                // "1001"
  status: EndpointStatus;
  bindings: ContactBinding[];
  maxBindings: number;              // Default: 5
  lastKeepaliveIso?: string;
  missedKeepalives: number;
}
