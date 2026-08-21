/**
 * RFC 3550 RTP & RTCP Protocol Types & Interfaces
 */

export interface RtpHeaderExtension {
  profile: number;
  data: Buffer;
}

export interface RtpHeader {
  version: number;          // Fixed to 2
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;      // 0=PCMU, 8=PCMA, 111=Opus, 101=telephone-event
  sequenceNumber: number;   // 16-bit unsigned (0..65535)
  timestamp: number;        // 32-bit unsigned
  ssrc: number;             // 32-bit unsigned
  csrc: number[];
  headerExtension?: RtpHeaderExtension;
}

export interface RtpPacket {
  version: 2;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  csrc: number[];
  headerExtension?: RtpHeaderExtension;
  payload: Buffer;
  header?: RtpHeader;
}

export interface RtcpReportBlock {
  ssrc: number;               // SSRC of source being reported
  fractionLost: number;       // 8 bits (0-255 representing fraction / 256)
  cumulativeLost: number;     // 24 bits signed
  highestSeqReceived: number; // 32 bits extended sequence number
  jitter: number;             // 32 bits interarrival jitter estimate
  lastSrTimestamp: number;    // Middle 32 bits of NTP timestamp from last SR
  delaySinceLastSr: number;   // In units of 1/65536 seconds
}

export interface RtcpReceiverReport {
  version: 2;
  padding: boolean;
  reportCount: number;
  payloadType: 201;           // 201 = RR
  length: number;             // Length in 32-bit words - 1
  ssrc: number;               // SSRC of packet sender
  reportBlocks: RtcpReportBlock[];
}

export interface RtcpSenderReport {
  version: 2;
  padding: boolean;
  reportCount: number;
  payloadType: 200;           // 200 = SR
  length: number;
  ssrc: number;
  ntpTimestampMsw: number;    // NTP timestamp seconds
  ntpTimestampLsw: number;    // NTP timestamp fractional
  rtpTimestamp: number;       // Corresponding RTP timestamp
  senderPacketCount: number;  // Cumulative packets sent
  senderOctetCount: number;   // Cumulative payload octets sent
  reportBlocks: RtcpReportBlock[];
}
