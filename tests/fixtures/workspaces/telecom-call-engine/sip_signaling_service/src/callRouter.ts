/**
 * Dial-Plan Prefix Router & Inbound/Outbound Route Selector
 */

export interface DialPlanRule {
  pattern: RegExp;
  targetTrunkGroupId?: string;
  targetExtension?: string;
  stripDigits?: number;
  prependPrefix?: string;
  priority: number;
}

export interface RouteResolution {
  routedNumber: string;
  targetTrunkGroupId?: string;
  targetExtension?: string;
  isInternal: boolean;
}

export class CallRouter {
  private readonly rules: DialPlanRule[] = [];

  constructor() {}

  public addRule(rule: DialPlanRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  public resolveRoute(destination: string): RouteResolution | null {
    const cleaned = destination.replace(/[^\d+]/g, '');

    for (const rule of this.rules) {
      if (rule.pattern.test(cleaned)) {
        let routed = cleaned;
        if (rule.stripDigits && rule.stripDigits > 0) {
          routed = routed.slice(rule.stripDigits);
        }
        if (rule.prependPrefix) {
          routed = `${rule.prependPrefix}${routed}`;
        }
        return {
          routedNumber: routed,
          targetTrunkGroupId: rule.targetTrunkGroupId,
          targetExtension: rule.targetExtension,
          isInternal: !rule.targetTrunkGroupId && !!rule.targetExtension,
        };
      }
    }

    return null;
  }

  public clear(): void {
    this.rules.length = 0;
  }
}
