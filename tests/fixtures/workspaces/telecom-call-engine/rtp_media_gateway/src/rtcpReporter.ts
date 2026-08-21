/**
 * RFC 3550 RTCP Reporter & Reception Quality Statistics
 */

import { RtcpReceiverReport, RtcpSenderReport, RtcpReportBlock } from './types/rtpTypes';

export interface RtcpSessionStats {
  ssrc: number;
  packetsSent: number;
  octetsSent: number;
  packetsReceived: number;
  octetsReceived: number;
  packetsLost: number;
  fractionLost: number;
  jitter: number;
  lastSrTimestamp: number;
}

export class RtcpReporter {
  private readonly stats: Map<number, RtcpSessionStats> = new Map();

  public recordPacketReceived(ssrc: number, octets: number): void {
    let stat = this.stats.get(ssrc);
    if (!stat) {
      stat = {
        ssrc,
        packetsSent: 0,
        octetsSent: 0,
        packetsReceived: 0,
        octetsReceived: 0,
        packetsLost: 0,
        fractionLost: 0,
        jitter: 0,
        lastSrTimestamp: 0,
      };
      this.stats.set(ssrc, stat);
    }
    stat.packetsReceived++;
    stat.octetsReceived += octets;
  }

  public generateReceiverReport(reporterSsrc: number, targetSsrc: number): RtcpReceiverReport {
    const stat = this.stats.get(targetSsrc) || {
      ssrc: targetSsrc,
      packetsSent: 0,
      octetsSent: 0,
      packetsReceived: 0,
      octetsReceived: 0,
      packetsLost: 0,
      fractionLost: 0,
      jitter: 0,
      lastSrTimestamp: 0,
    };

    const reportBlock: RtcpReportBlock = {
      ssrc: targetSsrc,
      fractionLost: stat.fractionLost,
      cumulativeLost: stat.packetsLost,
      highestSeqReceived: stat.packetsReceived,
      jitter: stat.jitter,
      lastSrTimestamp: stat.lastSrTimestamp,
      delaySinceLastSr: 0,
    };

    return {
      version: 2,
      padding: false,
      reportCount: 1,
      payloadType: 201,
      length: 7, // 2 header words + 6 report block words - 1 = 7
      ssrc: reporterSsrc,
      reportBlocks: [reportBlock],
    };
  }

  public getStats(ssrc: number): RtcpSessionStats | undefined {
    return this.stats.get(ssrc);
  }

  public clear(): void {
    this.stats.clear();
  }
}
