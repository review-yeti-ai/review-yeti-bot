/**
 * RFC 3550 RTP/RTCP Binary Wire Layout Serialization & Parsing
 */

import { RtpPacket, RtpHeader, RtcpReceiverReport, RtcpSenderReport, RtcpReportBlock } from './types/rtpTypes';
import { RtpMediaError } from '../../src/common/errors';

export class RtpPacketHandler {
  /**
   * Serializes an RtpPacket into a binary Buffer
   */
  public static serialize(packet: RtpPacket): Buffer {
    const csrcCount = packet.csrc ? packet.csrc.length : 0;
    const hasExtension = !!packet.headerExtension;
    const extensionLength = hasExtension ? 4 + packet.headerExtension!.data.length : 0;
    const headerLength = 12 + csrcCount * 4 + extensionLength;
    const totalLength = headerLength + packet.payload.length;

    const buf = Buffer.alloc(totalLength);

    // Byte 0: V (2b), P (1b), X (1b), CC (4b)
    const v = (packet.version & 0x03) << 6;
    const p = (packet.padding ? 1 : 0) << 5;
    const x = (hasExtension ? 1 : 0) << 4;
    const cc = csrcCount & 0x0f;
    buf.writeUInt8(v | p | x | cc, 0);

    // Byte 1: M (1b), PT (7b)
    const m = (packet.marker ? 1 : 0) << 7;
    const pt = packet.payloadType & 0x7f;
    buf.writeUInt8(m | pt, 1);

    // Bytes 2-3: Sequence number (UInt16BE)
    buf.writeUInt16BE(packet.sequenceNumber & 0xffff, 2);

    // Bytes 4-7: Timestamp (UInt32BE)
    buf.writeUInt32BE(packet.timestamp >>> 0, 4);

    // Bytes 8-11: SSRC (UInt32BE)
    buf.writeUInt32BE(packet.ssrc >>> 0, 8);

    // CSRC identifiers
    let offset = 12;
    if (packet.csrc) {
      for (const csrc of packet.csrc) {
        buf.writeUInt32BE(csrc >>> 0, offset);
        offset += 4;
      }
    }

    // Header extension
    if (hasExtension && packet.headerExtension) {
      buf.writeUInt16BE(packet.headerExtension.profile, offset);
      offset += 2;
      const lengthInWords = Math.ceil(packet.headerExtension.data.length / 4);
      buf.writeUInt16BE(lengthInWords, offset);
      offset += 2;
      packet.headerExtension.data.copy(buf, offset);
      offset += packet.headerExtension.data.length;
    }

    // Payload
    packet.payload.copy(buf, offset);

    return buf;
  }

  /**
   * Deserializes a raw binary Buffer into an RtpPacket
   */
  public static deserialize(buffer: Buffer): RtpPacket {
    if (!buffer || buffer.length < 12) {
      throw new RtpMediaError(`Invalid RTP buffer: length ${buffer?.length ?? 0} < 12 bytes`);
    }

    const byte0 = buffer.readUInt8(0);
    const version = (byte0 >> 6) & 0x03;
    if (version !== 2) {
      throw new RtpMediaError(`Unsupported RTP version: ${version} (expected 2)`);
    }

    const padding = ((byte0 >> 5) & 0x01) === 1;
    const extension = ((byte0 >> 4) & 0x01) === 1;
    const csrcCount = byte0 & 0x0f;

    const byte1 = buffer.readUInt8(1);
    const marker = ((byte1 >> 7) & 0x01) === 1;
    const payloadType = byte1 & 0x7f;

    const sequenceNumber = buffer.readUInt16BE(2);
    const timestamp = buffer.readUInt32BE(4);
    const ssrc = buffer.readUInt32BE(8);

    let offset = 12;
    const csrc: number[] = [];
    for (let i = 0; i < csrcCount; i++) {
      if (offset + 4 > buffer.length) {
        throw new RtpMediaError('Truncated RTP buffer reading CSRC list');
      }
      csrc.push(buffer.readUInt32BE(offset));
      offset += 4;
    }

    let headerExtension: { profile: number; data: Buffer } | undefined;
    if (extension) {
      if (offset + 4 > buffer.length) {
        throw new RtpMediaError('Truncated RTP buffer reading extension header');
      }
      const profile = buffer.readUInt16BE(offset);
      offset += 2;
      const lengthInWords = buffer.readUInt16BE(offset);
      offset += 2;
      const extByteLen = lengthInWords * 4;
      if (offset + extByteLen > buffer.length) {
        throw new RtpMediaError('Truncated RTP buffer reading extension data');
      }
      const extData = buffer.slice(offset, offset + extByteLen);
      offset += extByteLen;
      headerExtension = { profile, data: extData };
    }

    let payloadEnd = buffer.length;
    if (padding) {
      const paddingCount = buffer.readUInt8(buffer.length - 1);
      payloadEnd -= paddingCount;
    }

    const payload = buffer.slice(offset, payloadEnd);

    const header: RtpHeader = {
      version: 2,
      padding,
      extension,
      csrcCount,
      marker,
      payloadType,
      sequenceNumber,
      timestamp,
      ssrc,
      csrc,
      headerExtension,
    };

    return {
      version: 2,
      padding,
      extension,
      csrcCount,
      marker,
      payloadType,
      sequenceNumber,
      timestamp,
      ssrc,
      csrc,
      headerExtension,
      payload,
      header,
    };
  }

  /**
   * Serializes RTCP Receiver Report (RR) into Buffer (RFC 3550 Section 6.4.2)
   */
  public static serializeRtcpRr(rr: RtcpReceiverReport): Buffer {
    const reportCount = rr.reportBlocks.length & 0x1f;
    const totalWords = 2 + reportCount * 6; // Header (2 words) + 6 words per report block
    const buf = Buffer.alloc(totalWords * 4);

    // Byte 0: V=2, P=0, RC
    buf.writeUInt8((2 << 6) | (rr.padding ? (1 << 5) : 0) | reportCount, 0);
    // Byte 1: PT = 201 (RR)
    buf.writeUInt8(201, 1);
    // Bytes 2-3: Length in 32-bit words - 1
    buf.writeUInt16BE(totalWords - 1, 2);
    // Bytes 4-7: SSRC of sender
    buf.writeUInt32BE(rr.ssrc >>> 0, 4);

    let offset = 8;
    for (const block of rr.reportBlocks) {
      buf.writeUInt32BE(block.ssrc >>> 0, offset);
      // Fraction lost (8 bits) + Cumulative lost (24 bits signed)
      const frac = block.fractionLost & 0xff;
      const cum = block.cumulativeLost & 0x00ffffff;
      buf.writeUInt32BE(((frac << 24) | cum) >>> 0, offset + 4);
      buf.writeUInt32BE(block.highestSeqReceived >>> 0, offset + 8);
      buf.writeUInt32BE(block.jitter >>> 0, offset + 12);
      buf.writeUInt32BE(block.lastSrTimestamp >>> 0, offset + 16);
      buf.writeUInt32BE(block.delaySinceLastSr >>> 0, offset + 20);
      offset += 24;
    }

    return buf;
  }

  /**
   * Parses RTCP SR/RR binary Buffer
   */
  public static parseRtcp(buffer: Buffer): RtcpReceiverReport | RtcpSenderReport {
    if (!buffer || buffer.length < 8) {
      throw new RtpMediaError('Invalid RTCP buffer length');
    }

    const byte0 = buffer.readUInt8(0);
    const version = (byte0 >> 6) & 0x03;
    if (version !== 2) {
      throw new RtpMediaError(`Unsupported RTCP version: ${version}`);
    }

    const padding = ((byte0 >> 5) & 0x01) === 1;
    const reportCount = byte0 & 0x1f;
    const payloadType = buffer.readUInt8(1);
    const lengthInWords = buffer.readUInt16BE(2);
    const ssrc = buffer.readUInt32BE(4);

    if (payloadType === 201) {
      // Receiver Report (RR)
      let offset = 8;
      const reportBlocks: RtcpReportBlock[] = [];
      for (let i = 0; i < reportCount; i++) {
        if (offset + 24 > buffer.length) break;
        const blockSsrc = buffer.readUInt32BE(offset);
        const fracAndCum = buffer.readUInt32BE(offset + 4);
        const fractionLost = (fracAndCum >> 24) & 0xff;
        let cumulativeLost = fracAndCum & 0x00ffffff;
        if (cumulativeLost & 0x00800000) {
          cumulativeLost |= 0xff000000; // Sign-extend 24-bit
        }
        const highestSeqReceived = buffer.readUInt32BE(offset + 8);
        const jitter = buffer.readUInt32BE(offset + 12);
        const lastSrTimestamp = buffer.readUInt32BE(offset + 16);
        const delaySinceLastSr = buffer.readUInt32BE(offset + 20);

        reportBlocks.push({
          ssrc: blockSsrc,
          fractionLost,
          cumulativeLost,
          highestSeqReceived,
          jitter,
          lastSrTimestamp,
          delaySinceLastSr,
        });
        offset += 24;
      }

      return {
        version: 2,
        padding,
        reportCount,
        payloadType: 201,
        length: lengthInWords,
        ssrc,
        reportBlocks,
      };
    } else if (payloadType === 200) {
      // Sender Report (SR)
      if (buffer.length < 28) {
        throw new RtpMediaError('Invalid RTCP SR packet length');
      }
      const ntpTimestampMsw = buffer.readUInt32BE(8);
      const ntpTimestampLsw = buffer.readUInt32BE(12);
      const rtpTimestamp = buffer.readUInt32BE(16);
      const senderPacketCount = buffer.readUInt32BE(20);
      const senderOctetCount = buffer.readUInt32BE(24);

      let offset = 28;
      const reportBlocks: RtcpReportBlock[] = [];
      for (let i = 0; i < reportCount; i++) {
        if (offset + 24 > buffer.length) break;
        const blockSsrc = buffer.readUInt32BE(offset);
        const fracAndCum = buffer.readUInt32BE(offset + 4);
        const fractionLost = (fracAndCum >> 24) & 0xff;
        let cumulativeLost = fracAndCum & 0x00ffffff;
        if (cumulativeLost & 0x00800000) {
          cumulativeLost |= 0xff000000;
        }
        const highestSeqReceived = buffer.readUInt32BE(offset + 8);
        const jitter = buffer.readUInt32BE(offset + 12);
        const lastSrTimestamp = buffer.readUInt32BE(offset + 16);
        const delaySinceLastSr = buffer.readUInt32BE(offset + 20);

        reportBlocks.push({
          ssrc: blockSsrc,
          fractionLost,
          cumulativeLost,
          highestSeqReceived,
          jitter,
          lastSrTimestamp,
          delaySinceLastSr,
        });
        offset += 24;
      }

      return {
        version: 2,
        padding,
        reportCount,
        payloadType: 200,
        length: lengthInWords,
        ssrc,
        ntpTimestampMsw,
        ntpTimestampLsw,
        rtpTimestamp,
        senderPacketCount,
        senderOctetCount,
        reportBlocks,
      };
    } else {
      throw new RtpMediaError(`Unsupported RTCP payload type: ${payloadType}`);
    }
  }
}
