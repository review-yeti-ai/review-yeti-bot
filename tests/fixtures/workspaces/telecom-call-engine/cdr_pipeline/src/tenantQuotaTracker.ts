/**
 * Multi-Tenant Concurrency & Prepaid Quota Tracker with Threshold Alerts
 */

import { QuotaExceededError } from '../../src/common/errors';

export interface TenantQuotaConfig {
  tenantId: string;
  maxConcurrentCalls: number;       // e.g. 50 simultaneous channels
  monthlyMinuteCap: number;         // e.g. 10,000 minutes
  prepaidBalanceMicros: number;     // e.g. $500.00 = 500,000,000 micros
  isPostpaid: boolean;
  alertThresholdsPct: number[];     // e.g. [80, 90, 100]
}

export interface TenantUsageState {
  tenantId: string;
  activeChannels: number;
  currentMonthMinutesUsed: number;
  prepaidBalanceMicros: number;
  activeCallIds: Set<string>;
  triggeredAlerts: Set<number>;
}

export type QuotaAlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface QuotaAlert {
  tenantId: string;
  thresholdPct: number;
  severity: QuotaAlertSeverity;
  currentUsage: number;
  limit: number;
  message: string;
  timestampIso: string;
}

export class TenantQuotaExceededError extends Error {
  constructor(public readonly tenantId: string, public readonly reason: string) {
    super(`[TenantQuotaExceededError] Tenant ${tenantId} quota breach: ${reason}`);
    this.name = 'TenantQuotaExceededError';
  }
}

export class TenantQuotaTracker {
  private readonly tenantConfigs: Map<string, TenantQuotaConfig> = new Map();
  private readonly tenantStates: Map<string, TenantUsageState> = new Map();
  private readonly alertListeners: Array<(alert: QuotaAlert) => void> = [];

  public registerTenant(config: TenantQuotaConfig): void {
    this.tenantConfigs.set(config.tenantId, { ...config });
    if (!this.tenantStates.has(config.tenantId)) {
      this.tenantStates.set(config.tenantId, {
        tenantId: config.tenantId,
        activeChannels: 0,
        currentMonthMinutesUsed: 0,
        prepaidBalanceMicros: config.prepaidBalanceMicros,
        activeCallIds: new Set(),
        triggeredAlerts: new Set(),
      });
    }
  }

  /**
   * Atomic Channel Acquisition.
   * Returns true if channel reserved under maxConcurrentCalls limit.
   */
  public acquireChannel(tenantId: string, callId: string): boolean {
    const config = this.tenantConfigs.get(tenantId);
    if (!config) {
      throw new QuotaExceededError(`Unregistered tenant: ${tenantId}`);
    }

    const state = this.tenantStates.get(tenantId)!;

    // Check prepaid balance before acquiring channel
    if (!config.isPostpaid && state.prepaidBalanceMicros <= 0) {
      throw new TenantQuotaExceededError(tenantId, 'Prepaid balance depleted ($0.00)');
    }

    // Check monthly minute cap
    if (config.monthlyMinuteCap > 0 && state.currentMonthMinutesUsed >= config.monthlyMinuteCap) {
      throw new TenantQuotaExceededError(tenantId, `Monthly minute cap reached (${config.monthlyMinuteCap} mins)`);
    }

    // Atomic concurrency limit check
    if (state.activeChannels >= config.maxConcurrentCalls) {
      throw new TenantQuotaExceededError(
        tenantId,
        `Max concurrent channel limit reached (${config.maxConcurrentCalls})`
      );
    }

    state.activeChannels++;
    state.activeCallIds.add(callId);
    return true;
  }

  /**
   * Atomic Channel Release.
   */
  public releaseChannel(tenantId: string, callId: string): void {
    const state = this.tenantStates.get(tenantId);
    if (!state) return;

    if (state.activeCallIds.has(callId)) {
      state.activeCallIds.delete(callId);
      state.activeChannels = Math.max(0, state.activeChannels - 1);
    }
  }

  /**
   * Deducts billable cost and minute usage upon call completion.
   */
  public deductUsage(
    tenantId: string,
    billedMinutes: number,
    costMicros: number
  ): {
    remainingBalanceMicros: number;
    totalMonthMinutes: number;
  } {
    const config = this.tenantConfigs.get(tenantId);
    const state = this.tenantStates.get(tenantId);
    if (!config || !state) {
      throw new QuotaExceededError(`Unregistered tenant: ${tenantId}`);
    }

    state.currentMonthMinutesUsed += billedMinutes;

    if (!config.isPostpaid) {
      state.prepaidBalanceMicros = Math.max(0, state.prepaidBalanceMicros - costMicros);
    }

    // Check threshold alerts on monthly minute cap
    if (config.monthlyMinuteCap > 0) {
      const usagePct = (state.currentMonthMinutesUsed / config.monthlyMinuteCap) * 100;
      for (const threshold of config.alertThresholdsPct) {
        if (usagePct >= threshold && !state.triggeredAlerts.has(threshold)) {
          state.triggeredAlerts.add(threshold);
          const severity: QuotaAlertSeverity = threshold >= 100 ? 'CRITICAL' : threshold >= 90 ? 'WARNING' : 'INFO';
          this.emitAlert({
            tenantId,
            thresholdPct: threshold,
            severity,
            currentUsage: state.currentMonthMinutesUsed,
            limit: config.monthlyMinuteCap,
            message: `Tenant ${tenantId} reached ${threshold}% of monthly minute quota (${state.currentMonthMinutesUsed}/${config.monthlyMinuteCap} min)`,
            timestampIso: new Date().toISOString(),
          });
        }
      }
    }

    return {
      remainingBalanceMicros: state.prepaidBalanceMicros,
      totalMonthMinutes: state.currentMonthMinutesUsed,
    };
  }

  /**
   * Pre-flight balance authorization check for outbound call placement.
   */
  public authorizeCallStart(tenantId: string, estimatedMinutes: number = 1): boolean {
    const config = this.tenantConfigs.get(tenantId);
    const state = this.tenantStates.get(tenantId);
    if (!config || !state) return false;

    if (!config.isPostpaid && state.prepaidBalanceMicros <= 0) {
      return false;
    }
    if (config.monthlyMinuteCap > 0 && state.currentMonthMinutesUsed >= config.monthlyMinuteCap) {
      return false;
    }
    if (state.activeChannels >= config.maxConcurrentCalls) {
      return false;
    }
    return true;
  }

  public onAlert(listener: (alert: QuotaAlert) => void): () => void {
    this.alertListeners.push(listener);
    return () => {
      const idx = this.alertListeners.indexOf(listener);
      if (idx !== -1) {
        this.alertListeners.splice(idx, 1);
      }
    };
  }

  private emitAlert(alert: QuotaAlert): void {
    for (const listener of this.alertListeners) {
      try {
        listener(alert);
      } catch (err) {
        console.error('Error executing quota alert listener:', err);
      }
    }
  }

  public getTenantState(tenantId: string): Readonly<TenantUsageState> | undefined {
    return this.tenantStates.get(tenantId);
  }

  public resetMonthlyUsage(tenantId: string): void {
    const state = this.tenantStates.get(tenantId);
    if (state) {
      state.currentMonthMinutesUsed = 0;
      state.triggeredAlerts.clear();
    }
  }

  public clear(): void {
    this.tenantConfigs.clear();
    this.tenantStates.clear();
    this.alertListeners.length = 0;
  }
}
