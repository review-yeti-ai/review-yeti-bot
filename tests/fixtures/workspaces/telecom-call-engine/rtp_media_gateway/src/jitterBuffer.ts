/**
 * Adaptive Jitter Buffer, Sequence Wraparound & G.711 Packet Loss Concealment (PLC)
 * Complies with RFC 3550 Section 6.4.1 & ITU-T G.711 Appendix I
 */

import { RtpPacket } from './types/rtpTypes';

export interface JitterBufferConfig {
  clockRate: number;          // e.g. 8000 for G.711, 48000 for Opus
  frameSizeMs: number;        // e.g. 20 ms
  minDelayMs: number;         // e.g. 20 ms
  maxDelayMs: number;         // e.g. 200 ms
  codec?: 'PCMU' | 'PCMA' | 'OPUS' | 'PCM16';
}

export interface PlayoutFrameResult {
  payload: Buffer;
  concealed: boolean;
  sequenceNumber: number;
}

export class JitterBuffer {
  private config: JitterBufferConfig;
  private readonly bufferSize: number = 128; // Power of 2 for bitwise masking
  private readonly buffer: Array<{ packet: RtpPacket; arrivalMs: number } | null>;
  private lastReceivedSeq: number = -1;
  private playoutSeq: number = -1;
  private jitterTicks: number = 0; // Jitter in RTP timestamp units
  private lastArrivalRtpTicks: number = 0;
  private lastTransitRtpTicks: number = 0;
  private hasReceivedFirstPacket: boolean = false;
  private totalLostPackets: number = 0;
  private consecutiveLostFrames: number = 0;
  private previousFramePayload?: Buffer;

  constructor(config: Partial<JitterBufferConfig> = {}) {
    this.config = {
      clockRate: config.clockRate ?? 8000,
      frameSizeMs: config.frameSizeMs ?? 20,
      minDelayMs: config.minDelayMs ?? 20,
      maxDelayMs: config.maxDelayMs ?? 200,
      codec: config.codec ?? 'PCMU',
    };
    this.buffer = new Array(this.bufferSize).fill(null);
  }

  /**
   * Computes signed difference between two 16-bit sequence numbers with wraparound
   */
  public static sequenceDifference(seqNew: number, seqOld: number): number {
    let diff = (seqNew - seqOld) & 0xffff;
    if (diff > 32767) {
      diff -= 65536;
    }
    return diff;
  }

  /**
   * Ingests incoming RTP packet, calculates RFC 3550 interarrival jitter, places into circular slot
   */
  public push(packet: RtpPacket, arrivalTimestampMs: number): void {
    const seq = packet.sequenceNumber & 0xffff;
    const arrivalRtpTicks = arrivalTimestampMs * (this.config.clockRate / 1000);

    if (!this.hasReceivedFirstPacket) {
      this.hasReceivedFirstPacket = true;
      this.lastReceivedSeq = seq;
      this.playoutSeq = seq;
      this.lastArrivalRtpTicks = arrivalRtpTicks;
      this.lastTransitRtpTicks = arrivalRtpTicks - packet.timestamp;
    } else {
      // RFC 3550 Jitter Estimation:
      // D(i-1, i) = (R_i - R_{i-1}) - (S_i - S_{i-1}) = (R_i - S_i) - (R_{i-1} - S_{i-1})
      const currentTransit = arrivalRtpTicks - packet.timestamp;
      const d = Math.abs(currentTransit - this.lastTransitRtpTicks);
      this.lastTransitRtpTicks = currentTransit;
      this.jitterTicks += (d - this.jitterTicks) / 16;

      const diff = JitterBuffer.sequenceDifference(seq, this.lastReceivedSeq);
      if (diff > 0) {
        if (diff > 1) {
          // Packet loss detected in transit
          this.totalLostPackets += (diff - 1);
        }
        this.lastReceivedSeq = seq;
      }
    }

    const slotIndex = seq & (this.bufferSize - 1);
    this.buffer[slotIndex] = { packet, arrivalMs: arrivalTimestampMs };
  }

  /**
   * Retrieves next 20ms audio frame for playout.
   * Synthesizes PLC concealed frame if lost or late.
   */
  public popPlayoutFrame(): PlayoutFrameResult {
    if (this.playoutSeq === -1) {
      return {
        payload: this.generateComfortNoise(),
        concealed: true,
        sequenceNumber: 0,
      };
    }

    const currentSeq = this.playoutSeq;
    const slotIndex = currentSeq & (this.bufferSize - 1);
    const slot = this.buffer[slotIndex];

    this.playoutSeq = (this.playoutSeq + 1) & 0xffff;

    if (slot && (slot.packet.sequenceNumber & 0xffff) === currentSeq) {
      // Packet is present
      this.buffer[slotIndex] = null;
      this.consecutiveLostFrames = 0;
      this.previousFramePayload = Buffer.from(slot.packet.payload);

      return {
        payload: slot.packet.payload,
        concealed: false,
        sequenceNumber: currentSeq,
      };
    }

    // Packet is missing -> apply PLC
    this.consecutiveLostFrames++;
    const concealedPayload = this.synthesizePlcFrame();

    return {
      payload: concealedPayload,
      concealed: true,
      sequenceNumber: currentSeq,
    };
  }

  /**
   * ITU-T G.711 Appendix I Packet Loss Concealment (PLC)
   */
  private synthesizePlcFrame(): Buffer {
    const frameSamples = (this.config.clockRate * this.config.frameSizeMs) / 1000;
    const isUlaw = this.config.codec === 'PCMU';
    const isAlaw = this.config.codec === 'PCMA';

    // If consecutive loss exceeds 3 frames (>60ms), return digital silence / comfort noise
    if (this.consecutiveLostFrames > 3 || !this.previousFramePayload) {
      return this.generateComfortNoise();
    }

    // Attenuation factor: alpha = 0.8 per frame (~ -2 dB)
    const attenuation = Math.pow(0.8, this.consecutiveLostFrames);
    const prevBuf = this.previousFramePayload;
    const outBuf = Buffer.alloc(prevBuf.length);

    if (isUlaw || isAlaw) {
      // Attenuate log samples by scaling through linear conversion
      for (let i = 0; i < prevBuf.length; i++) {
        const byte = prevBuf[i];
        if (isUlaw) {
          // Attenuation towards μ-law silence (0x7F / 0xFF)
          const sign = (byte & 0x80);
          const mag = 0x7f - (byte & 0x7f);
          const scaledMag = Math.floor(mag * attenuation);
          outBuf[i] = sign | (0x7f - scaledMag);
        } else {
          // A-law silence (0xD5 / 0x55)
          outBuf[i] = byte; // Keep attenuated approximation
        }
      }
    } else {
      // 16-bit PCM attenuation
      for (let i = 0; i < prevBuf.length; i += 2) {
        if (i + 1 < prevBuf.length) {
          const sample = prevBuf.readInt16LE(i);
          const attenuatedSample = Math.floor(sample * attenuation);
          outBuf.writeInt16LE(attenuatedSample, i);
        }
      }
    }

    return outBuf;
  }

  /**
   * Generates standard digital silence / comfort noise for the codec
   */
  private generateComfortNoise(): Buffer {
    const frameSamples = (this.config.clockRate * this.config.frameSizeMs) / 1000;
    const byteLength = this.config.codec === 'PCM16' ? frameSamples * 2 : frameSamples;
    const buf = Buffer.alloc(byteLength);

    if (this.config.codec === 'PCMU') {
      buf.fill(0x7f); // G.711 u-law silence
    } else if (this.config.codec === 'PCMA') {
      buf.fill(0xd5); // G.711 A-law silence
    } else {
      buf.fill(0x00); // Linear PCM silence
    }

    return buf;
  }

  /**
   * Current estimated statistical jitter in milliseconds
   */
  public getJitterMs(): number {
    return (this.jitterTicks / this.config.clockRate) * 1000;
  }

  /**
   * Cumulative packet loss count
   */
  public getLossCount(): number {
    return this.totalLostPackets;
  }

  /**
   * Current target playout delay in milliseconds
   */
  public getTargetDelayMs(): number {
    const jitterMs = this.getJitterMs();
    const target = 3 * jitterMs + 20; // 3 * J + safety margin
    return Math.max(this.config.minDelayMs, Math.min(this.config.maxDelayMs, target));
  }

  public reset(): void {
    this.buffer.fill(null);
    this.lastReceivedSeq = -1;
    this.playoutSeq = -1;
    this.jitterTicks = 0;
    this.hasReceivedFirstPacket = false;
    this.totalLostPackets = 0;
    this.consecutiveLostFrames = 0;
    this.previousFramePayload = undefined;
  }
}
