/**
 * RFC 3261 Standard SIP Message Types & Interfaces
 */

export type SipMethod =
  | 'INVITE'
  | 'ACK'
  | 'BYE'
  | 'CANCEL'
  | 'OPTIONS'
  | 'REGISTER'
  | 'PRACK'
  | 'SUBSCRIBE'
  | 'NOTIFY'
  | 'REFER'
  | 'INFO'
  | 'UPDATE'
  | 'MESSAGE';

export type SipStatusCodeClass =
  | 'PROVISIONAL_1XX'
  | 'SUCCESS_2XX'
  | 'REDIRECTION_3XX'
  | 'CLIENT_ERROR_4XX'
  | 'SERVER_ERROR_5XX'
  | 'GLOBAL_FAILURE_6XX';

export interface SipUri {
  scheme: 'sip' | 'sips';
  user?: string;
  password?: string;
  host: string;
  port?: number;
  parameters: Record<string, string>;
  headers: Record<string, string>;
}

export interface SipViaHeader {
  protocol: 'SIP';
  version: '2.0';
  transport: 'UDP' | 'TCP' | 'TLS' | 'WS' | 'WSS';
  sentBy: { host: string; port?: number };
  branch: string; // Must begin with "z9hG4bK" per RFC 3261
  received?: string;
  rport?: number;
  maddr?: string;
  ttl?: number;
  params: Record<string, string>;
}

export interface SipAddressHeader {
  displayName?: string;
  uri: SipUri;
  tag?: string;
  params: Record<string, string>;
}

export interface SipCSeqHeader {
  sequenceNumber: number;
  method: SipMethod;
}

export interface SipHeaderMap {
  via: SipViaHeader[];
  from: SipAddressHeader;
  to: SipAddressHeader;
  callId: string;
  cseq: SipCSeqHeader;
  contact?: SipAddressHeader[];
  contentType?: string;
  contentLength: number;
  maxForwards: number;
  recordRoute?: SipAddressHeader[];
  route?: SipAddressHeader[];
  allow?: SipMethod[];
  supported?: string[];
  require?: string[];
  expires?: number;
  userAgent?: string;
  authorization?: string;
  wwwAuthenticate?: string;
  event?: string;
  subscriptionState?: string;
  referTo?: SipAddressHeader;
  referredBy?: SipAddressHeader;
  replaces?: string; // RFC 3891 Replaces header string: Call-ID;to-tag=...;from-tag=...
  reason?: string;
  custom: Record<string, string | string[]>;
}

export interface SipMessage {
  isRequest: boolean;
  version: '2.0';
  headers: SipHeaderMap;
  body?: string;
  rawBuffer?: Buffer;
}

export interface SipRequest extends SipMessage {
  isRequest: true;
  method: SipMethod;
  requestUri: SipUri;
}

export interface SipResponse extends SipMessage {
  isRequest: false;
  statusCode: number;
  reasonPhrase: string;
}

export function parseSipUri(uriStr: string): SipUri {
  const cleaned = uriStr.trim().replace(/^<|>$/g, '');
  const schemeMatch = cleaned.match(/^(sips?):/i);
  const scheme = (schemeMatch ? schemeMatch[1].toLowerCase() : 'sip') as 'sip' | 'sips';
  let rest = schemeMatch ? cleaned.slice(schemeMatch[0].length) : cleaned;

  const headers: Record<string, string> = {};
  const headerIdx = rest.indexOf('?');
  if (headerIdx !== -1) {
    const queryPart = rest.slice(headerIdx + 1);
    rest = rest.slice(0, headerIdx);
    const params = new URLSearchParams(queryPart);
    for (const [k, v] of params.entries()) {
      headers[k] = v;
    }
  }

  const parameters: Record<string, string> = {};
  const semiIdx = rest.indexOf(';');
  if (semiIdx !== -1) {
    const paramPart = rest.slice(semiIdx + 1);
    rest = rest.slice(0, semiIdx);
    const parts = paramPart.split(';');
    for (const p of parts) {
      const [pk, pv] = p.split('=');
      if (pk) {
        parameters[pk.trim()] = pv ? pv.trim() : '';
      }
    }
  }

  let user: string | undefined;
  let password: string | undefined;
  let host = rest;
  let port: number | undefined;

  const atIdx = rest.indexOf('@');
  if (atIdx !== -1) {
    const userinfo = rest.slice(0, atIdx);
    host = rest.slice(atIdx + 1);
    const colonIdx = userinfo.indexOf(':');
    if (colonIdx !== -1) {
      user = userinfo.slice(0, colonIdx);
      password = userinfo.slice(colonIdx + 1);
    } else {
      user = userinfo;
    }
  }

  const hostPortIdx = host.indexOf(':');
  if (hostPortIdx !== -1) {
    port = parseInt(host.slice(hostPortIdx + 1), 10);
    host = host.slice(0, hostPortIdx);
  }

  return {
    scheme,
    user,
    password,
    host,
    port: isNaN(port!) ? undefined : port,
    parameters,
    headers,
  };
}

export function formatSipUri(uri: SipUri): string {
  let str = `${uri.scheme}:`;
  if (uri.user) {
    str += uri.password ? `${uri.user}:${uri.password}@` : `${uri.user}@`;
  }
  str += uri.host;
  if (uri.port) {
    str += `:${uri.port}`;
  }
  for (const [k, v] of Object.entries(uri.parameters)) {
    str += v ? `;${k}=${v}` : `;${k}`;
  }
  const headerKeys = Object.keys(uri.headers);
  if (headerKeys.length > 0) {
    const q = headerKeys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(uri.headers[k])}`).join('&');
    str += `?${q}`;
  }
  return str;
}
