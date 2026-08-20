/**
 * RFC 2617 / RFC 7616 HTTP Digest Authentication Engine with Constant-Time Verification
 */

import crypto from 'node:crypto';
import { AuthenticationError } from '../../src/common/errors';

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque: string;
  algorithm: 'MD5' | 'SHA-256';
  qop: 'auth';
}

export interface DigestAuthorizationHeader {
  username: string;
  realm: string;
  nonce: string;
  uri: string;
  response: string;
  algorithm?: 'MD5' | 'SHA-256';
  cnonce?: string;
  nc?: string;                      // Nonce count: e.g. "00000001"
  qop?: 'auth';
  opaque?: string;
}

export interface DigestCredentialsStore {
  getPassword(username: string, realm: string): Promise<string | null>;
  getHA1?(username: string, realm: string): Promise<string | null>;
}

export class AuthenticationFailedError extends AuthenticationError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationFailedError';
  }
}

export class DigestAuthenticator {
  private readonly secretKey: string;
  private readonly nonceTtlMs: number;
  private readonly usedNonces: Map<string, number> = new Map(); // Nonce -> Expiry timestamp

  constructor(secretKey?: string, nonceTtlSeconds: number = 300) {
    this.secretKey = secretKey ?? crypto.randomBytes(32).toString('hex');
    this.nonceTtlMs = nonceTtlSeconds * 1000;
  }

  /**
   * Generates RFC 2617 WWW-Authenticate challenge header value.
   */
  public createChallenge(realm: string, clientIp: string): DigestChallenge {
    const timestampMs = Date.now();
    const hmac = crypto.createHmac('sha256', this.secretKey);
    hmac.update(`${timestampMs}:${clientIp}`);
    const signature = hmac.digest('hex');
    const noncePayload = `${timestampMs}:${signature}`;
    const nonce = Buffer.from(noncePayload, 'utf-8').toString('base64');
    const opaque = crypto.randomBytes(8).toString('hex');

    return {
      realm,
      nonce,
      opaque,
      algorithm: 'MD5',
      qop: 'auth',
    };
  }

  public formatChallengeHeader(challenge: DigestChallenge): string {
    return `Digest realm="${challenge.realm}", nonce="${challenge.nonce}", opaque="${challenge.opaque}", algorithm=${challenge.algorithm}, qop="${challenge.qop}"`;
  }

  /**
   * Parses incoming Authorization / Proxy-Authorization header string.
   */
  public parseAuthorizationHeader(headerValue: string): DigestAuthorizationHeader | null {
    if (!headerValue || !headerValue.toLowerCase().startsWith('digest ')) {
      return null;
    }

    const authParams = headerValue.slice(7).trim();
    const params: Record<string, string> = {};
    const regex = /(\w+)=(?:"([^"]*)"|([\w.-]+))/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(authParams)) !== null) {
      const key = match[1].toLowerCase();
      const val = match[2] !== undefined ? match[2] : match[3];
      params[key] = val;
    }

    if (!params['username'] || !params['realm'] || !params['nonce'] || !params['uri'] || !params['response']) {
      return null;
    }

    return {
      username: params['username'],
      realm: params['realm'],
      nonce: params['nonce'],
      uri: params['uri'],
      response: params['response'],
      algorithm: (params['algorithm']?.toUpperCase() as any) || 'MD5',
      cnonce: params['cnonce'],
      nc: params['nc'],
      qop: params['qop'] as any,
      opaque: params['opaque'],
    };
  }

  /**
   * Validates SIP Digest response using constant-time comparison.
   */
  public async verifyResponse(
    header: DigestAuthorizationHeader,
    method: string,
    clientIp: string,
    credentialsStore: DigestCredentialsStore
  ): Promise<boolean> {
    this.purgeExpiredNonces();

    // 1. Nonce validation
    let noncePayload: string;
    try {
      noncePayload = Buffer.from(header.nonce, 'base64').toString('utf-8');
    } catch {
      throw new AuthenticationFailedError('Malformed nonce encoding');
    }

    const colonIdx = noncePayload.indexOf(':');
    if (colonIdx === -1) {
      throw new AuthenticationFailedError('Invalid nonce structure');
    }

    const nonceTimeStr = noncePayload.slice(0, colonIdx);
    const nonceSig = noncePayload.slice(colonIdx + 1);
    const nonceTime = parseInt(nonceTimeStr, 10);
    const now = Date.now();

    if (isNaN(nonceTime) || now - nonceTime > this.nonceTtlMs || nonceTime > now + 60000) {
      throw new AuthenticationFailedError('Nonce has expired (stale=true)');
    }

    // Verify HMAC signature of nonce
    const hmac = crypto.createHmac('sha256', this.secretKey);
    hmac.update(`${nonceTime}:${clientIp}`);
    const expectedSig = hmac.digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(nonceSig), Buffer.from(expectedSig))) {
      throw new AuthenticationFailedError('Invalid nonce signature');
    }

    // Nonce replay tracking for one-time or counted nonce
    const nonceKey = `${header.nonce}:${header.nc ?? '0'}`;
    if (this.usedNonces.has(nonceKey)) {
      throw new AuthenticationFailedError('Nonce replay detected');
    }
    this.usedNonces.set(nonceKey, now + this.nonceTtlMs);

    // 2. Fetch credentials
    const password = await credentialsStore.getPassword(header.username, header.realm);
    if (password === null || password === undefined) {
      throw new AuthenticationFailedError(`User not found: ${header.username}`);
    }

    // 3. Compute expected response
    const ha1 = this.computeHA1(header.username, header.realm, password);
    const ha2 = this.computeHA2(method, header.uri);

    const expectedResponse = header.qop === 'auth'
      ? this.computeDigestResponse(
          ha1,
          header.nonce,
          header.nc ?? '00000001',
          header.cnonce ?? '',
          'auth',
          ha2
        )
      : crypto.createHash('md5').update(`${ha1}:${header.nonce}:${ha2}`).digest('hex');

    // 4. Constant-time comparison
    if (header.response.length !== expectedResponse.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(header.response, 'utf-8'),
      Buffer.from(expectedResponse, 'utf-8')
    );
  }

  public computeHA1(username: string, realm: string, pass: string): string {
    return crypto.createHash('md5').update(`${username}:${realm}:${pass}`).digest('hex');
  }

  public computeHA2(method: string, uri: string): string {
    return crypto.createHash('md5').update(`${method.toUpperCase()}:${uri}`).digest('hex');
  }

  public computeDigestResponse(
    ha1: string,
    nonce: string,
    nc: string,
    cnonce: string,
    qop: string,
    ha2: string
  ): string {
    return crypto
      .createHash('md5')
      .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      .digest('hex');
  }

  private purgeExpiredNonces(): void {
    const now = Date.now();
    for (const [key, expiry] of this.usedNonces.entries()) {
      if (now >= expiry) {
        this.usedNonces.delete(key);
      }
    }
  }

  public clear(): void {
    this.usedNonces.clear();
  }
}
