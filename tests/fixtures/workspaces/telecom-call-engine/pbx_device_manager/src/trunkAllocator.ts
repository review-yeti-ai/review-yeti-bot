/**
 * Carrier Trunk Allocator with Weighted Round-Robin & Circuit Breaker Failover
 */

import crypto from 'node:crypto';
import { Trunk, TrunkGroup, TrunkLease } from './models/trunkGroup';

export class NoTrunkAvailableError extends Error {
  constructor(public readonly trunkGroupId: string) {
    super(`[NoTrunkAvailableError] No available healthy trunk in group: ${trunkGroupId}`);
    this.name = 'NoTrunkAvailableError';
  }
}

export interface CircuitBreakerConfig {
  failureThreshold?: number;         // e.g. 5 consecutive errors to trip DOWN
  successThreshold?: number;         // e.g. 3 consecutive successes to restore ACTIVE
  cooldownMs?: number;               // e.g. 30,000 ms before probing DOWN trunk
}

export class TrunkAllocator {
  private readonly trunkGroups: Map<string, TrunkGroup> = new Map();
  private readonly trunksById: Map<string, Trunk> = new Map();
  private readonly activeLeases: Map<string, TrunkLease> = new Map(); // leaseId -> TrunkLease
  private readonly roundRobinIndices: Map<string, number> = new Map(); // trunkGroupId -> current weighted index
  private readonly circuitConfig: Required<CircuitBreakerConfig>;

  constructor(circuitConfig: CircuitBreakerConfig = {}) {
    this.circuitConfig = {
      failureThreshold: circuitConfig.failureThreshold ?? 5,
      successThreshold: circuitConfig.successThreshold ?? 3,
      cooldownMs: circuitConfig.cooldownMs ?? 30000,
    };
  }

  public registerTrunkGroup(group: TrunkGroup): void {
    const clonedTrunks = group.trunks.map((t) => ({ ...t }));
    this.trunkGroups.set(group.id, {
      ...group,
      trunks: clonedTrunks,
    });
    for (const trunk of clonedTrunks) {
      this.trunksById.set(trunk.id, trunk);
    }
    if (!this.roundRobinIndices.has(group.id)) {
      this.roundRobinIndices.set(group.id, 0);
    }
  }

  /**
   * Selects trunk via Weighted Round-Robin and atomically allocates channel lease.
   */
  public allocateTrunk(trunkGroupId: string, callId: string): TrunkLease {
    const group = this.trunkGroups.get(trunkGroupId);
    if (!group || group.trunks.length === 0) {
      throw new NoTrunkAvailableError(trunkGroupId);
    }

    // Filter candidate healthy trunks with available capacity
    const candidates = group.trunks.filter(
      (t) => t.status !== 'DOWN' && t.activeChannels < t.maxChannels
    );

    if (candidates.length === 0) {
      throw new NoTrunkAvailableError(trunkGroupId);
    }

    let selectedTrunk: Trunk;

    if (group.strategy === 'STRICT_PRIORITY') {
      // Pick first healthy candidate
      selectedTrunk = candidates[0];
    } else {
      // Weighted Round-Robin selection
      const totalWeight = candidates.reduce((sum, t) => sum + Math.max(1, t.weight), 0);
      let currentIndex = this.roundRobinIndices.get(trunkGroupId) ?? 0;
      let targetWeight = currentIndex % totalWeight;

      selectedTrunk = candidates[0];
      let accWeight = 0;
      for (const t of candidates) {
        accWeight += Math.max(1, t.weight);
        if (targetWeight < accWeight) {
          selectedTrunk = t;
          break;
        }
      }

      this.roundRobinIndices.set(trunkGroupId, (currentIndex + 1) % 1000000);
    }

    // Atomically increment active channels
    selectedTrunk.activeChannels++;

    const leaseId = `lease_${crypto.randomUUID()}`;
    const lease: TrunkLease = {
      leaseId,
      trunkId: selectedTrunk.id,
      trunkGroupId,
      callId,
      allocatedAtIso: new Date().toISOString(),
      targetHost: selectedTrunk.host,
      targetPort: selectedTrunk.port,
    };

    this.activeLeases.set(leaseId, lease);
    return lease;
  }

  /**
   * Releases leased channel and decrements active channel count.
   */
  public releaseTrunk(leaseId: string): void {
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return;

    this.activeLeases.delete(leaseId);
    const trunk = this.trunksById.get(lease.trunkId);
    if (trunk) {
      trunk.activeChannels = Math.max(0, trunk.activeChannels - 1);
    }
  }

  /**
   * Records SIP response status for trunk health monitoring.
   */
  public recordCallResult(trunkId: string, sipResponseCode: number): void {
    const trunk = this.trunksById.get(trunkId);
    if (!trunk) return;

    const isFailure = trunk.failoverStatusCodes.includes(sipResponseCode);

    if (isFailure) {
      trunk.consecutiveFailures++;
      trunk.consecutiveSuccesses = 0;
      trunk.lastFailureIso = new Date().toISOString();

      if (trunk.consecutiveFailures >= this.circuitConfig.failureThreshold) {
        trunk.status = 'DOWN';
      } else if (trunk.consecutiveFailures >= 2) {
        trunk.status = 'DEGRADED';
      }
    } else if (sipResponseCode >= 200 && sipResponseCode < 300) {
      trunk.consecutiveSuccesses++;
      trunk.consecutiveFailures = 0;

      if (trunk.consecutiveSuccesses >= this.circuitConfig.successThreshold) {
        trunk.status = 'ACTIVE';
      }
    }
  }

  public getTrunk(trunkId: string): Trunk | null {
    return this.trunksById.get(trunkId) ?? null;
  }

  public getTrunkGroup(groupId: string): TrunkGroup | null {
    return this.trunkGroups.get(groupId) ?? null;
  }

  public getActiveLeasesCount(): number {
    return this.activeLeases.size;
  }

  public clear(): void {
    this.trunkGroups.clear();
    this.trunksById.clear();
    this.activeLeases.clear();
    this.roundRobinIndices.clear();
  }
}
