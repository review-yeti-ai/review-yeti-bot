/**
 * UDP Port Pool Manager with Even/Odd RTP/RTCP Pairing & Quarantine Cooldown
 * Complies with RFC 3550 Section 11 (Port Assignment)
 */

import { PortPoolExhaustedError } from '../../src/common/errors';

export interface PortPair {
  rtpPort: number;  // Even
  rtcpPort: number; // Odd (rtpPort + 1)
  tenantId: string;
  callId: string;
  allocatedAt: number;
}

export interface PortAllocatorOptions {
  minPort?: number;       // Default: 16384
  maxPort?: number;       // Default: 32768
  cooldownMs?: number;    // Default: 5000ms
}

export class PortAllocator {
  private readonly minPort: number;
  private readonly maxPort: number;
  private readonly cooldownMs: number;
  private readonly allocatedPorts: Map<number, PortPair> = new Map(); // rtpPort -> PortPair
  private readonly quarantinedPorts: Map<number, number> = new Map(); // rtpPort -> quarantineUntilTimestamp
  private readonly callPortIndex: Map<string, Set<number>> = new Map(); // `${tenantId}:${callId}` -> Set<rtpPort>
  private nextSearchPort: number;

  constructor(options: PortAllocatorOptions = {}) {
    this.minPort = (options.minPort ?? 16384);
    // Ensure minPort is even
    if (this.minPort % 2 !== 0) {
      this.minPort++;
    }
    this.maxPort = options.maxPort ?? 32768;
    this.cooldownMs = options.cooldownMs ?? 5000;
    this.nextSearchPort = this.minPort;
  }

  /**
   * Atomically allocates an even RTP port and odd RTCP port pair
   */
  public async allocatePair(tenantId: string, callId: string): Promise<PortPair> {
    this.purgeExpiredQuarantine();

    const totalPossiblePairs = Math.floor((this.maxPort - this.minPort) / 2);
    let checkedCount = 0;
    let candidatePort = this.nextSearchPort;

    while (checkedCount < totalPossiblePairs) {
      if (candidatePort >= this.maxPort) {
        candidatePort = this.minPort;
      }

      if (!this.allocatedPorts.has(candidatePort) && !this.quarantinedPorts.has(candidatePort)) {
        // Port is available
        const pair: PortPair = {
          rtpPort: candidatePort,
          rtcpPort: candidatePort + 1,
          tenantId,
          callId,
          allocatedAt: Date.now(),
        };

        this.allocatedPorts.set(candidatePort, pair);

        const callKey = `${tenantId}:${callId}`;
        if (!this.callPortIndex.has(callKey)) {
          this.callPortIndex.set(callKey, new Set());
        }
        this.callPortIndex.get(callKey)!.add(candidatePort);

        this.nextSearchPort = candidatePort + 2;
        return pair;
      }

      candidatePort += 2;
      checkedCount++;
    }

    throw new PortPoolExhaustedError(
      `All UDP RTP/RTCP ports in range [${this.minPort}, ${this.maxPort}] are allocated or quarantined`
    );
  }

  /**
   * Releases an allocated port pair and moves them into cooldown quarantine
   */
  public async releasePair(rtpPort: number): Promise<void> {
    const pair = this.allocatedPorts.get(rtpPort);
    if (!pair) {
      return;
    }

    this.allocatedPorts.delete(rtpPort);
    const callKey = `${pair.tenantId}:${pair.callId}`;
    const portSet = this.callPortIndex.get(callKey);
    if (portSet) {
      portSet.delete(rtpPort);
      if (portSet.size === 0) {
        this.callPortIndex.delete(callKey);
      }
    }

    // Move to quarantine cooldown to prevent delayed packet crosstalk
    this.quarantinedPorts.set(rtpPort, Date.now() + this.cooldownMs);
  }

  /**
   * Releases all ports associated with a call (crash safety / cleanup)
   */
  public async releaseCallPorts(tenantId: string, callId: string): Promise<void> {
    const callKey = `${tenantId}:${callId}`;
    const portSet = this.callPortIndex.get(callKey);
    if (!portSet) {
      return;
    }

    const portsToRelease = Array.from(portSet);
    for (const port of portsToRelease) {
      await this.releasePair(port);
    }
  }

  /**
   * Removes expired ports from quarantine pool
   */
  private purgeExpiredQuarantine(): void {
    const now = Date.now();
    for (const [port, expiry] of this.quarantinedPorts.entries()) {
      if (now >= expiry) {
        this.quarantinedPorts.delete(port);
      }
    }
  }

  /**
   * Returns current pool utilization metrics
   */
  public getMetrics(): {
    totalPairs: number;
    allocatedPairs: number;
    quarantinedPairs: number;
    availablePairs: number;
  } {
    this.purgeExpiredQuarantine();
    const totalPairs = Math.floor((this.maxPort - this.minPort) / 2);
    const allocatedPairs = this.allocatedPorts.size;
    const quarantinedPairs = this.quarantinedPorts.size;
    const availablePairs = Math.max(0, totalPairs - allocatedPairs - quarantinedPairs);

    return {
      totalPairs,
      allocatedPairs,
      quarantinedPairs,
      availablePairs,
    };
  }

  public clear(): void {
    this.allocatedPorts.clear();
    this.quarantinedPorts.clear();
    this.callPortIndex.clear();
    this.nextSearchPort = this.minPort;
  }
}
