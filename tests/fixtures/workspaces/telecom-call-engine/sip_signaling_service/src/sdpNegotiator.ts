/**
 * RFC 4566 SDP Parser & Serializer with RFC 3264 Offer/Answer Negotiation
 */

import { SdpNegotiationError } from '../../src/common/errors';

export type AudioCodecName = 'PCMU' | 'PCMA' | 'opus' | 'G722' | 'telephone-event';

export interface SdpCodecFormat {
  payloadType: number;        // Static (0, 8) or Dynamic (96-127, e.g. 111, 101)
  name: AudioCodecName | string;
  clockRate: number;          // e.g. 8000, 48000
  channels?: number;          // e.g. 1 (mono), 2 (stereo)
  parameters?: Record<string, string>; // fmtp parameters (e.g. minptime=10;useinbandfec=1)
}

export interface SdpMediaDescription {
  mediaType: 'audio' | 'video' | 'application';
  port: number;               // RTP port (0 means rejected)
  protocol: 'RTP/AVP' | 'RTP/SAVP' | 'UDP/TLS/RTP/SAVP';
  formats: number[];          // Payload type IDs in priority order
  codecs: SdpCodecFormat[];
  direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
  ptime?: number;             // Frame packetization time in ms (e.g. 20)
  maxptime?: number;
  connection?: {
    netType: 'IN';
    addrType: 'IP4' | 'IP6';
    address: string;
  };
}

export interface SdpSession {
  version: number;            // v=0
  origin: {
    username: string;
    sessionId: string;
    sessionVersion: string;
    netType: 'IN';
    addrType: 'IP4' | 'IP6';
    address: string;
  };
  sessionName: string;        // s=-
  connection: {
    netType: 'IN';
    addrType: 'IP4' | 'IP6';
    address: string;
  };
  time: { startTime: number; stopTime: number }; // t=0 0
  media: SdpMediaDescription[];
  attributes: Record<string, string | string[]>;
}

export interface CodecCapability {
  name: AudioCodecName;
  clockRate: number;
  channels: number;
  preferredPayloadType: number;
  parameters?: Record<string, string>;
}

export const DEFAULT_LOCAL_CAPABILITIES: CodecCapability[] = [
  { name: 'PCMU', clockRate: 8000, channels: 1, preferredPayloadType: 0 },
  { name: 'PCMA', clockRate: 8000, channels: 1, preferredPayloadType: 8 },
  { name: 'opus', clockRate: 48000, channels: 2, preferredPayloadType: 111, parameters: { minptime: '10', useinbandfec: '1' } },
  { name: 'telephone-event', clockRate: 8000, channels: 1, preferredPayloadType: 101, parameters: { '0-16': '' } },
];

export class SdpNegotiator {
  private localCapabilities: CodecCapability[];

  constructor(capabilities: CodecCapability[] = DEFAULT_LOCAL_CAPABILITIES) {
    this.localCapabilities = [...capabilities];
  }

  /**
   * Parses raw RFC 4566 SDP string into structured SdpSession object
   */
  public parse(sdpString: string): SdpSession {
    if (!sdpString || typeof sdpString !== 'string') {
      throw new SdpNegotiationError('Empty or invalid SDP string');
    }

    const lines = sdpString.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const session: SdpSession = {
      version: 0,
      origin: {
        username: '-',
        sessionId: '0',
        sessionVersion: '0',
        netType: 'IN',
        addrType: 'IP4',
        address: '0.0.0.0',
      },
      sessionName: '-',
      connection: {
        netType: 'IN',
        addrType: 'IP4',
        address: '0.0.0.0',
      },
      time: { startTime: 0, stopTime: 0 },
      media: [],
      attributes: {},
    };

    let currentMedia: SdpMediaDescription | null = null;

    for (const line of lines) {
      const type = line.charAt(0);
      const val = line.substring(2);

      switch (type) {
        case 'v':
          session.version = parseInt(val, 10);
          break;

        case 'o': {
          const parts = val.split(' ');
          if (parts.length >= 6) {
            session.origin = {
              username: parts[0],
              sessionId: parts[1],
              sessionVersion: parts[2],
              netType: parts[3] as 'IN',
              addrType: parts[4] as 'IP4' | 'IP6',
              address: parts[5],
            };
          }
          break;
        }

        case 's':
          session.sessionName = val;
          break;

        case 'c': {
          const parts = val.split(' ');
          if (parts.length >= 3) {
            const conn = {
              netType: parts[0] as 'IN',
              addrType: parts[1] as 'IP4' | 'IP6',
              address: parts[2],
            };
            if (currentMedia) {
              currentMedia.connection = conn;
            } else {
              session.connection = conn;
            }
          }
          break;
        }

        case 't': {
          const parts = val.split(' ');
          session.time = {
            startTime: parseInt(parts[0], 10) || 0,
            stopTime: parseInt(parts[1], 10) || 0,
          };
          break;
        }

        case 'm': {
          const parts = val.split(' ');
          const mediaType = parts[0] as 'audio' | 'video' | 'application';
          const port = parseInt(parts[1], 10);
          const protocol = parts[2] as 'RTP/AVP' | 'RTP/SAVP' | 'UDP/TLS/RTP/SAVP';
          const formats = parts.slice(3).map((f) => parseInt(f, 10));

          currentMedia = {
            mediaType,
            port,
            protocol,
            formats,
            codecs: [],
            direction: 'sendrecv',
          };
          session.media.push(currentMedia);
          break;
        }

        case 'a': {
          const colonIdx = val.indexOf(':');
          const attrName = colonIdx !== -1 ? val.slice(0, colonIdx) : val;
          const attrVal = colonIdx !== -1 ? val.slice(colonIdx + 1) : '';

          if (currentMedia) {
            if (['sendrecv', 'sendonly', 'recvonly', 'inactive'].includes(attrName)) {
              currentMedia.direction = attrName as any;
            } else if (attrName === 'rtpmap') {
              // a=rtpmap:<payloadType> <codecName>/<clockRate>[/<channels>]
              const [ptStr, rest] = attrVal.split(' ');
              const pt = parseInt(ptStr, 10);
              const codecParts = rest ? rest.split('/') : [];
              const name = codecParts[0];
              const clockRate = parseInt(codecParts[1], 10);
              const channels = codecParts[2] ? parseInt(codecParts[2], 10) : 1;

              const existingCodec = currentMedia.codecs.find((c) => c.payloadType === pt);
              if (existingCodec) {
                existingCodec.name = name;
                existingCodec.clockRate = clockRate;
                existingCodec.channels = channels;
              } else {
                currentMedia.codecs.push({
                  payloadType: pt,
                  name,
                  clockRate,
                  channels,
                });
              }
            } else if (attrName === 'fmtp') {
              // a=fmtp:<payloadType> <param1>=<val1>;<param2>=<val2>
              const spaceIdx = attrVal.indexOf(' ');
              if (spaceIdx !== -1) {
                const pt = parseInt(attrVal.slice(0, spaceIdx), 10);
                const paramsStr = attrVal.slice(spaceIdx + 1);
                const params: Record<string, string> = {};
                for (const pair of paramsStr.split(';')) {
                  const [pk, pv] = pair.split('=');
                  if (pk) {
                    params[pk.trim()] = pv ? pv.trim() : '';
                  }
                }
                const codec = currentMedia.codecs.find((c) => c.payloadType === pt);
                if (codec) {
                  codec.parameters = params;
                }
              }
            } else if (attrName === 'ptime') {
              currentMedia.ptime = parseInt(attrVal, 10);
            } else if (attrName === 'maxptime') {
              currentMedia.maxptime = parseInt(attrVal, 10);
            }
          } else {
            session.attributes[attrName] = attrVal;
          }
          break;
        }
      }
    }

    // Populate default static codecs if not explicitly defined in rtpmap
    for (const m of session.media) {
      for (const pt of m.formats) {
        if (!m.codecs.some((c) => c.payloadType === pt)) {
          if (pt === 0) {
            m.codecs.push({ payloadType: 0, name: 'PCMU', clockRate: 8000, channels: 1 });
          } else if (pt === 8) {
            m.codecs.push({ payloadType: 8, name: 'PCMA', clockRate: 8000, channels: 1 });
          }
        }
      }
    }

    return session;
  }

  /**
   * Serializes structured SdpSession into RFC 4566 compliant string
   */
  public serialize(session: SdpSession): string {
    const lines: string[] = [];

    lines.push(`v=${session.version}`);
    lines.push(
      `o=${session.origin.username} ${session.origin.sessionId} ${session.origin.sessionVersion} ${session.origin.netType} ${session.origin.addrType} ${session.origin.address}`
    );
    lines.push(`s=${session.sessionName}`);
    lines.push(`c=${session.connection.netType} ${session.connection.addrType} ${session.connection.address}`);
    lines.push(`t=${session.time.startTime} ${session.time.stopTime}`);

    for (const [k, v] of Object.entries(session.attributes)) {
      lines.push(v ? `a=${k}:${v}` : `a=${k}`);
    }

    for (const m of session.media) {
      const connStr = m.connection
        ? `c=${m.connection.netType} ${m.connection.addrType} ${m.connection.address}\r\n`
        : '';
      const formatsStr = m.formats.join(' ');
      lines.push(`m=${m.mediaType} ${m.port} ${m.protocol} ${formatsStr}`);
      if (connStr) {
        lines.push(connStr.trim());
      }
      lines.push(`a=${m.direction}`);
      if (m.ptime) {
        lines.push(`a=ptime:${m.ptime}`);
      }
      if (m.maxptime) {
        lines.push(`a=maxptime:${m.maxptime}`);
      }
      for (const codec of m.codecs) {
        const chan = codec.channels && codec.channels > 1 ? `/${codec.channels}` : '';
        lines.push(`a=rtpmap:${codec.payloadType} ${codec.name}/${codec.clockRate}${chan}`);
        if (codec.parameters && Object.keys(codec.parameters).length > 0) {
          const fmtpStr = Object.entries(codec.parameters)
            .map(([pk, pv]) => (pv ? `${pk}=${pv}` : pk))
            .join(';');
          lines.push(`a=fmtp:${codec.payloadType} ${fmtpStr}`);
        }
      }
    }

    return lines.join('\r\n') + '\r\n';
  }

  /**
   * Generates initial SDP Offer (RFC 3264)
   */
  public createOffer(
    localIp: string,
    localPort: number,
    options?: { direction?: 'sendrecv' | 'sendonly'; ptime?: number }
  ): SdpSession {
    const sessionId = `${Date.now()}`;
    const formats = this.localCapabilities.map((c) => c.preferredPayloadType);
    const codecs: SdpCodecFormat[] = this.localCapabilities.map((c) => ({
      payloadType: c.preferredPayloadType,
      name: c.name,
      clockRate: c.clockRate,
      channels: c.channels,
      parameters: c.parameters ? { ...c.parameters } : undefined,
    }));

    return {
      version: 0,
      origin: {
        username: '-',
        sessionId,
        sessionVersion: '1',
        netType: 'IN',
        addrType: 'IP4',
        address: localIp,
      },
      sessionName: 'TelecomCallEngine',
      connection: {
        netType: 'IN',
        addrType: 'IP4',
        address: localIp,
      },
      time: { startTime: 0, stopTime: 0 },
      media: [
        {
          mediaType: 'audio',
          port: localPort,
          protocol: 'RTP/AVP',
          formats,
          codecs,
          direction: options?.direction ?? 'sendrecv',
          ptime: options?.ptime ?? 20,
        },
      ],
      attributes: {},
    };
  }

  /**
   * Generates SDP Answer from received Offer per RFC 3264 Offer/Answer Model
   */
  public createAnswer(
    offer: SdpSession,
    localIp: string,
    localPort: number,
    preferredDirection: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive' = 'sendrecv'
  ): {
    answer: SdpSession;
    selectedCodec: SdpCodecFormat;
    remoteIp: string;
    remotePort: number;
  } {
    const offerAudioMedia = offer.media.find((m) => m.mediaType === 'audio');
    if (!offerAudioMedia) {
      throw new SdpNegotiationError('No audio media stream found in SDP offer');
    }

    const remoteIp = offerAudioMedia.connection?.address ?? offer.connection.address;
    const remotePort = offerAudioMedia.port;

    if (remotePort === 0) {
      throw new SdpNegotiationError('Offered audio media port is 0 (stream rejected by peer)');
    }

    // Intersect codecs between Offer codecs and local capabilities matching by name
    const negotiatedCodecs: SdpCodecFormat[] = [];
    const negotiatedFormats: number[] = [];

    for (const offerCodec of offerAudioMedia.codecs) {
      const match = this.localCapabilities.find(
        (local) => local.name.toLowerCase() === offerCodec.name.toLowerCase()
      );
      if (match) {
        negotiatedCodecs.push({
          payloadType: offerCodec.payloadType, // Preserve offerer's payload type per RFC 3264
          name: match.name,
          clockRate: match.clockRate,
          channels: match.channels,
          parameters: offerCodec.parameters ?? match.parameters,
        });
        negotiatedFormats.push(offerCodec.payloadType);
      }
    }

    if (negotiatedCodecs.length === 0) {
      throw new SdpNegotiationError('No common audio codecs could be negotiated between offer and local capabilities');
    }

    // Direction negotiation matrix (RFC 3264 Section 6.1)
    let negotiatedDirection: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive' = 'sendrecv';
    const offDir = offerAudioMedia.direction;

    if (offDir === 'inactive' || preferredDirection === 'inactive') {
      negotiatedDirection = 'inactive';
    } else if (offDir === 'sendrecv') {
      negotiatedDirection = preferredDirection;
    } else if (offDir === 'sendonly') {
      negotiatedDirection = preferredDirection === 'sendrecv' || preferredDirection === 'recvonly' ? 'recvonly' : 'inactive';
    } else if (offDir === 'recvonly') {
      negotiatedDirection = preferredDirection === 'sendrecv' || preferredDirection === 'sendonly' ? 'sendonly' : 'inactive';
    }

    const answerSession: SdpSession = {
      version: 0,
      origin: {
        username: '-',
        sessionId: offer.origin.sessionId,
        sessionVersion: `${parseInt(offer.origin.sessionVersion, 10) + 1}`,
        netType: 'IN',
        addrType: 'IP4',
        address: localIp,
      },
      sessionName: 'TelecomCallEngine',
      connection: {
        netType: 'IN',
        addrType: 'IP4',
        address: localIp,
      },
      time: { startTime: 0, stopTime: 0 },
      media: [
        {
          mediaType: 'audio',
          port: localPort,
          protocol: offerAudioMedia.protocol,
          formats: negotiatedFormats,
          codecs: negotiatedCodecs,
          direction: negotiatedDirection,
          ptime: offerAudioMedia.ptime ?? 20,
        },
      ],
      attributes: {},
    };

    return {
      answer: answerSession,
      selectedCodec: negotiatedCodecs[0],
      remoteIp,
      remotePort,
    };
  }
}
