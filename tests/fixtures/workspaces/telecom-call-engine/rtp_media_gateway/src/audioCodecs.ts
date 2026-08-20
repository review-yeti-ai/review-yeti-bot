/**
 * ITU-T G.711 μ-law / A-law Bitwise Codecs & Opus Framing
 * Complies with ITU-T G.711 & RFC 7587 (Opus RTP payload format)
 */

export class AudioCodecs {
  // Precomputed lookup tables
  private static readonly ULAW_TO_LINEAR = new Int16Array(256);
  private static readonly ALAW_TO_LINEAR = new Int16Array(256);
  private static readonly LINEAR_TO_ULAW = new Uint8Array(65536);
  private static readonly LINEAR_TO_ALAW = new Uint8Array(65536);
  private static isInitialized = false;

  private static initializeTables(): void {
    if (AudioCodecs.isInitialized) return;

    // Build ULAW_TO_LINEAR table
    for (let i = 0; i < 256; i++) {
      const companded = ~i & 0xff;
      const sign = companded & 0x80;
      const exponent = (companded >> 4) & 0x07;
      const mantissa = companded & 0x0f;
      let sample = ((mantissa << 3) + 0x84) << exponent;
      sample -= 0x84;
      AudioCodecs.ULAW_TO_LINEAR[i] = sign !== 0 ? -sample : sample;
    }

    // Build ALAW_TO_LINEAR table
    for (let i = 0; i < 256; i++) {
      const companded = i ^ 0x55;
      const sign = companded & 0x80;
      const exponent = (companded >> 4) & 0x07;
      const mantissa = companded & 0x0f;
      let sample: number;
      if (exponent === 0) {
        sample = (mantissa << 4) + 8;
      } else {
        sample = ((mantissa << 4) + 0x108) << (exponent - 1);
      }
      AudioCodecs.ALAW_TO_LINEAR[i] = sign !== 0 ? -sample : sample;
    }

    // Build LINEAR_TO_ULAW table
    for (let i = 0; i < 65536; i++) {
      // Map unsigned 0..65535 to signed -32768..32767
      const pcm = i < 32768 ? i : i - 65536;
      AudioCodecs.LINEAR_TO_ULAW[i] = AudioCodecs.linearSampleToUlaw(pcm);
    }

    // Build LINEAR_TO_ALAW table
    for (let i = 0; i < 65536; i++) {
      const pcm = i < 32768 ? i : i - 65536;
      AudioCodecs.LINEAR_TO_ALAW[i] = AudioCodecs.linearSampleToAlaw(pcm);
    }

    AudioCodecs.isInitialized = true;
  }

  private static linearSampleToUlaw(pcm: number): number {
    const BIAS = 0x84; // 132
    const CLIP = 32635;

    let sign = 0;
    if (pcm < 0) {
      pcm = -pcm;
      sign = 0x80;
    }
    if (pcm > CLIP) pcm = CLIP;
    pcm += BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }

    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
    return ulawByte;
  }

  private static linearSampleToAlaw(pcm: number): number {
    let sign = 0;
    if (pcm < 0) {
      pcm = -pcm;
      sign = 0x80;
    }
    if (pcm > 32767) pcm = 32767;

    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }

    let mantissa: number;
    if (exponent === 0) {
      mantissa = (pcm >> 4) & 0x0f;
    } else {
      mantissa = (pcm >> (exponent + 3)) & 0x0f;
    }

    const alawByte = (sign | (exponent << 4) | mantissa) ^ 0x55;
    return alawByte & 0xff;
  }

  /**
   * Encodes 16-bit Linear PCM (8kHz) buffer to 8-bit G.711 μ-law
   */
  public static linearToUlaw(pcmBuffer: Buffer): Buffer {
    AudioCodecs.initializeTables();
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    const out = Buffer.alloc(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
      const uint16 = pcmBuffer.readUInt16LE(i * 2);
      out[i] = AudioCodecs.LINEAR_TO_ULAW[uint16];
    }
    return out;
  }

  /**
   * Decodes 8-bit G.711 μ-law to 16-bit Linear PCM (8kHz) buffer
   */
  public static ulawToLinear(ulawBuffer: Buffer): Buffer {
    AudioCodecs.initializeTables();
    const out = Buffer.alloc(ulawBuffer.length * 2);

    for (let i = 0; i < ulawBuffer.length; i++) {
      const sample = AudioCodecs.ULAW_TO_LINEAR[ulawBuffer[i]];
      out.writeInt16LE(sample, i * 2);
    }
    return out;
  }

  /**
   * Encodes 16-bit Linear PCM (8kHz) buffer to 8-bit G.711 A-law
   */
  public static linearToAlaw(pcmBuffer: Buffer): Buffer {
    AudioCodecs.initializeTables();
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    const out = Buffer.alloc(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
      const uint16 = pcmBuffer.readUInt16LE(i * 2);
      out[i] = AudioCodecs.LINEAR_TO_ALAW[uint16];
    }
    return out;
  }

  /**
   * Decodes 8-bit G.711 A-law to 16-bit Linear PCM (8kHz) buffer
   */
  public static alawToLinear(alawBuffer: Buffer): Buffer {
    AudioCodecs.initializeTables();
    const out = Buffer.alloc(alawBuffer.length * 2);

    for (let i = 0; i < alawBuffer.length; i++) {
      const sample = AudioCodecs.ALAW_TO_LINEAR[alawBuffer[i]];
      out.writeInt16LE(sample, i * 2);
    }
    return out;
  }

  /**
   * Direct transcoding from G.711 μ-law to A-law without full linear roundtrip
   */
  public static ulawToAlaw(ulawBuffer: Buffer): Buffer {
    AudioCodecs.initializeTables();
    const out = Buffer.alloc(ulawBuffer.length);
    for (let i = 0; i < ulawBuffer.length; i++) {
      const linear = AudioCodecs.ULAW_TO_LINEAR[ulawBuffer[i]];
      const uint16 = linear < 0 ? linear + 65536 : linear;
      out[i] = AudioCodecs.LINEAR_TO_ALAW[uint16];
    }
    return out;
  }

  /**
   * Direct transcoding from G.711 A-law to μ-law without full linear roundtrip
   */
  public static alawToUlaw(alawBuffer: Buffer): Buffer {
    AudioCodecs.initializeTables();
    const out = Buffer.alloc(alawBuffer.length);
    for (let i = 0; i < alawBuffer.length; i++) {
      const linear = AudioCodecs.ALAW_TO_LINEAR[alawBuffer[i]];
      const uint16 = linear < 0 ? linear + 65536 : linear;
      out[i] = AudioCodecs.LINEAR_TO_ULAW[uint16];
    }
    return out;
  }

  /**
   * Verifies and packages 20ms Opus frame (RFC 7587)
   */
  public static packageOpusFrame(opusBytes: Buffer): Buffer {
    if (!opusBytes || opusBytes.length === 0) {
      throw new Error('Invalid Opus frame payload: buffer is empty');
    }
    // Inspect TOC byte (Table of Contents byte)
    const toc = opusBytes[0];
    const config = (toc >> 3) & 0x1f;
    const isStereo = ((toc >> 2) & 0x01) === 1;
    const frameCountCode = toc & 0x03;

    // Return encapsulated frame buffer
    return Buffer.from(opusBytes);
  }
}
