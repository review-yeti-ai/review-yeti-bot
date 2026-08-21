/**
 * SIP Endpoint Registration Registry with RFC 3581 Symmetric NAT & Keepalive Monitor
 * Complies with RFC 3261 Section 10 & RFC 3581
 */

import { ContactBinding, EndpointStatus, SipEndpoint } from './models/sipEndpoint';

export interface DeviceRegistryOptions {
  defaultExpiresSec?: number;        // Default: 3600 (1 hour)
  minExpiresSec?: number;            // Default: 60
  maxExpiresSec?: number;            // Default: 7200
  keepaliveIntervalMs?: number;      // Default: 30,000 ms (30s)
  maxMissedKeepalives?: number;      // Default: 3
}

export class DeviceRegistry {
  private readonly endpoints: Map<string, SipEndpoint> = new Map(); // aor -> SipEndpoint
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private readonly options: Required<DeviceRegistryOptions>;

  constructor(options: DeviceRegistryOptions = {}) {
    this.options = {
      defaultExpiresSec: options.defaultExpiresSec ?? 3600,
      minExpiresSec: options.minExpiresSec ?? 60,
      maxExpiresSec: options.maxExpiresSec ?? 7200,
      keepaliveIntervalMs: options.keepaliveIntervalMs ?? 30000,
      maxMissedKeepalives: options.maxMissedKeepalives ?? 3,
    };
  }

  public start(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      this.runKeepaliveSweep();
    }, this.options.keepaliveIntervalMs);
    if (this.keepaliveTimer.unref) {
      this.keepaliveTimer.unref();
    }
  }

  public stop(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /**
   * Handles RFC 3261 REGISTER contact binding.
   */
  public registerContact(
    aor: string,
    tenantId: string,
    contactUri: string,
    expiresSec: number,
    callId: string,
    cseq: number,
    userAgent: string,
    sourceIp: string,
    sourcePort: number
  ): SipEndpoint {
    let endpoint = this.endpoints.get(aor);
    if (!endpoint) {
      const extMatch = aor.match(/sip:([^@]+)@/i);
      const extension = extMatch ? extMatch[1] : aor;
      endpoint = {
        aor,
        tenantId,
        extension,
        status: 'UNREGISTERED',
        bindings: [],
        maxBindings: 5,
        missedKeepalives: 0,
      };
      this.endpoints.set(aor, endpoint);
    }

    // RFC 3261 §10.2.2: Contact: * with Expires: 0 deregisters ALL bindings
    if (contactUri === '*' && expiresSec === 0) {
      endpoint.bindings = [];
      endpoint.status = 'UNREGISTERED';
      endpoint.missedKeepalives = 0;
      return endpoint;
    }

    // Single contact deregistration
    if (expiresSec === 0) {
      endpoint.bindings = endpoint.bindings.filter((b) => b.contactUri !== contactUri);
      if (endpoint.bindings.length === 0) {
        endpoint.status = 'UNREGISTERED';
      }
      return endpoint;
    }

    // Bounded expiry
    const clampedExpires = Math.max(
      this.options.minExpiresSec,
      Math.min(this.options.maxExpiresSec, expiresSec > 0 ? expiresSec : this.options.defaultExpiresSec)
    );

    const now = Date.now();
    const expiresAt = new Date(now + clampedExpires * 1000).toISOString();

    // RFC 3581 Symmetric NAT detection
    let natReceived: string | undefined;
    let natRport: number | undefined;
    const uriMatch = contactUri.match(/@([^:;>]+)(?::(\d+))?/);
    if (uriMatch) {
      const hostInUri = uriMatch[1];
      const portInUri = uriMatch[2] ? parseInt(uriMatch[2], 10) : 5060;
      if (hostInUri !== sourceIp || portInUri !== sourcePort) {
        natReceived = sourceIp;
        natRport = sourcePort;
      }
    }

    const newBinding: ContactBinding = {
      contactUri,
      userAgent,
      callId,
      cseq,
      registeredAtIso: new Date(now).toISOString(),
      expiresAtIso: expiresAt,
      expiresSeconds: clampedExpires,
      sourceIp,
      sourcePort,
      natReceived,
      natRport,
    };

    // Update existing binding or append
    const existingIdx = endpoint.bindings.findIndex((b) => b.contactUri === contactUri);
    if (existingIdx !== -1) {
      endpoint.bindings[existingIdx] = newBinding;
    } else {
      if (endpoint.bindings.length >= endpoint.maxBindings) {
        // Evict oldest binding
        endpoint.bindings.shift();
      }
      endpoint.bindings.push(newBinding);
    }

    endpoint.status = 'REGISTERED';
    endpoint.missedKeepalives = 0;
    endpoint.lastKeepaliveIso = new Date(now).toISOString();

    return endpoint;
  }

  public unregisterContact(aor: string, contactUri: string): boolean {
    const endpoint = this.endpoints.get(aor);
    if (!endpoint) return false;

    if (contactUri === '*') {
      endpoint.bindings = [];
      endpoint.status = 'UNREGISTERED';
      return true;
    }

    const initialLen = endpoint.bindings.length;
    endpoint.bindings = endpoint.bindings.filter((b) => b.contactUri !== contactUri);
    if (endpoint.bindings.length === 0) {
      endpoint.status = 'UNREGISTERED';
    }
    return endpoint.bindings.length < initialLen;
  }

  public getEndpoint(aor: string): SipEndpoint | null {
    return this.endpoints.get(aor) ?? null;
  }

  public getActiveBindings(aor: string): ContactBinding[] {
    const endpoint = this.endpoints.get(aor);
    if (!endpoint || endpoint.status === 'OFFLINE' || endpoint.status === 'UNREGISTERED') {
      return [];
    }
    const now = Date.now();
    return endpoint.bindings.filter((b) => new Date(b.expiresAtIso).getTime() > now);
  }

  /**
   * SIP OPTIONS keepalive cycle.
   */
  public runKeepaliveSweep(): { expiredCount: number; offlineCount: number } {
    const now = Date.now();
    let expiredCount = 0;
    let offlineCount = 0;

    for (const endpoint of this.endpoints.values()) {
      // 1. Purge expired bindings
      const validBindings = endpoint.bindings.filter((b) => {
        const isValid = new Date(b.expiresAtIso).getTime() > now;
        if (!isValid) expiredCount++;
        return isValid;
      });
      endpoint.bindings = validBindings;

      // 2. If no valid bindings left, unregister
      if (endpoint.bindings.length === 0 && endpoint.status === 'REGISTERED') {
        endpoint.status = 'UNREGISTERED';
      }

      // 3. Keepalive check
      if (endpoint.status === 'REGISTERED') {
        endpoint.missedKeepalives++;
        if (endpoint.missedKeepalives >= this.options.maxMissedKeepalives) {
          endpoint.status = 'OFFLINE';
          offlineCount++;
        }
      }
    }

    return { expiredCount, offlineCount };
  }

  public clear(): void {
    this.endpoints.clear();
  }
}
