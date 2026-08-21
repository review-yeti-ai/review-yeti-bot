/**
 * SIP Signaling Server & Message Parser/Serializer
 */

import { SipMessage, SipRequest, SipResponse, SipMethod, parseSipUri, formatSipUri } from './types/sipMessages';
import { SipProtocolError } from '../../src/common/errors';

export class SipServer {
  private isRunning: boolean = false;

  constructor(
    public readonly host: string = '0.0.0.0',
    public readonly port: number = 5060,
    public readonly transport: 'UDP' | 'TCP' = 'UDP'
  ) {}

  public async start(): Promise<void> {
    this.isRunning = true;
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
  }

  public getStatus(): { isRunning: boolean; host: string; port: number; transport: string } {
    return {
      isRunning: this.isRunning,
      host: this.host,
      port: this.port,
      transport: this.transport,
    };
  }

  /**
   * Parses raw RFC 3261 text message into SipMessage object
   */
  public parseMessage(raw: string): SipMessage {
    const lines = raw.split(/\r?\n/);
    if (lines.length === 0 || !lines[0].trim()) {
      throw new SipProtocolError('Empty SIP payload', 400);
    }

    const startLine = lines[0].trim();
    const isRequest = !startLine.startsWith('SIP/2.0');
    const headerLines: string[] = [];
    let bodyStartIndex = -1;

    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '') {
        bodyStartIndex = i + 1;
        break;
      }
      headerLines.push(lines[i]);
    }

    const body = bodyStartIndex !== -1 ? lines.slice(bodyStartIndex).join('\r\n') : undefined;

    const headers: any = {
      via: [],
      custom: {},
      contentLength: 0,
      maxForwards: 70,
    };

    for (const hLine of headerLines) {
      const colonIdx = hLine.indexOf(':');
      if (colonIdx === -1) continue;
      const key = hLine.slice(0, colonIdx).trim().toLowerCase();
      const val = hLine.slice(colonIdx + 1).trim();

      if (key === 'via' || key === 'v') {
        const branchMatch = val.match(/branch=([^\s;]+)/i);
        headers.via.push({
          protocol: 'SIP',
          version: '2.0',
          transport: val.includes('TCP') ? 'TCP' : 'UDP',
          sentBy: { host: '0.0.0.0', port: 5060 },
          branch: branchMatch ? branchMatch[1] : '',
          params: {},
        });
      } else if (key === 'from' || key === 'f') {
        const tagMatch = val.match(/tag=([^\s;]+)/i);
        headers.from = {
          uri: parseSipUri(val),
          tag: tagMatch ? tagMatch[1] : undefined,
          params: {},
        };
      } else if (key === 'to' || key === 't') {
        const tagMatch = val.match(/tag=([^\s;]+)/i);
        headers.to = {
          uri: parseSipUri(val),
          tag: tagMatch ? tagMatch[1] : undefined,
          params: {},
        };
      } else if (key === 'call-id' || key === 'i') {
        headers.callId = val;
      } else if (key === 'cseq') {
        const [seqStr, methodStr] = val.split(' ');
        headers.cseq = {
          sequenceNumber: parseInt(seqStr, 10),
          method: (methodStr || 'INVITE').toUpperCase() as SipMethod,
        };
      } else if (key === 'content-type' || key === 'c') {
        headers.contentType = val;
      } else if (key === 'content-length' || key === 'l') {
        headers.contentLength = parseInt(val, 10);
      } else if (key === 'max-forwards') {
        headers.maxForwards = parseInt(val, 10);
      } else if (key === 'contact' || key === 'm') {
        headers.contact = [{ uri: parseSipUri(val), params: {} }];
      } else {
        headers.custom[key] = val;
      }
    }

    if (isRequest) {
      const parts = startLine.split(' ');
      const method = parts[0].toUpperCase() as SipMethod;
      const requestUri = parseSipUri(parts[1] || 'sip:unknown@example.com');
      return {
        isRequest: true,
        method,
        requestUri,
        version: '2.0',
        headers,
        body,
      } as SipRequest;
    } else {
      const parts = startLine.split(' ');
      const statusCode = parseInt(parts[1], 10);
      const reasonPhrase = parts.slice(2).join(' ') || 'OK';
      return {
        isRequest: false,
        statusCode,
        reasonPhrase,
        version: '2.0',
        headers,
        body,
      } as SipResponse;
    }
  }

  /**
   * Serializes a SipMessage into an RFC 3261 formatted string
   */
  public serializeMessage(msg: SipMessage): string {
    const lines: string[] = [];
    if (msg.isRequest) {
      const req = msg as SipRequest;
      lines.push(`${req.method} ${formatSipUri(req.requestUri)} SIP/2.0`);
    } else {
      const res = msg as SipResponse;
      lines.push(`SIP/2.0 ${res.statusCode} ${res.reasonPhrase}`);
    }

    for (const via of msg.headers.via || []) {
      lines.push(`Via: SIP/2.0/${via.transport} ${via.sentBy.host}${via.sentBy.port ? ':' + via.sentBy.port : ''};branch=${via.branch}`);
    }

    const fromTag = msg.headers.from?.tag ? `;tag=${msg.headers.from.tag}` : '';
    lines.push(`From: ${formatSipUri(msg.headers.from?.uri || parseSipUri('sip:caller@example.com'))}${fromTag}`);

    const toTag = msg.headers.to?.tag ? `;tag=${msg.headers.to.tag}` : '';
    lines.push(`To: ${formatSipUri(msg.headers.to?.uri || parseSipUri('sip:callee@example.com'))}${toTag}`);

    lines.push(`Call-ID: ${msg.headers.callId}`);
    lines.push(`CSeq: ${msg.headers.cseq?.sequenceNumber || 1} ${msg.headers.cseq?.method || 'INVITE'}`);
    lines.push(`Max-Forwards: ${msg.headers.maxForwards || 70}`);

    if (msg.headers.contact && msg.headers.contact.length > 0) {
      lines.push(`Contact: <${formatSipUri(msg.headers.contact[0].uri)}>`);
    }
    if (msg.headers.contentType) {
      lines.push(`Content-Type: ${msg.headers.contentType}`);
    }

    const bodyContent = msg.body ?? '';
    lines.push(`Content-Length: ${Buffer.byteLength(bodyContent, 'utf-8')}`);
    lines.push('');

    return lines.join('\r\n') + (bodyContent ? bodyContent : '');
  }
}
