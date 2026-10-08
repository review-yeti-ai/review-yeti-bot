export const PROVIDER_ATTEMPT_BUDGET_VERSION = 'ReviewProviderAttemptBudget.v1' as const;

export type ProviderAttemptPhase = 'investigation' | 'verification';

export interface ProviderAttemptBudgetLimits {
  totalLimit: number;
  investigationLimit: number;
  verificationLimit: number;
}

export interface ProviderAttemptBudgetSnapshot extends ProviderAttemptBudgetLimits {
  version: typeof PROVIDER_ATTEMPT_BUDGET_VERSION;
  totalStarted: number;
  investigationStarted: number;
  verificationStarted: number;
  deniedAttempts: number;
  investigationDenied: number;
  verificationDenied: number;
}

export class ProviderAttemptBudgetExceededError extends Error {
  readonly failureClass = 'budget_exhausted' as const;

  constructor(readonly phase: ProviderAttemptPhase) {
    super(`Review provider request budget exhausted during ${phase}`);
    this.name = 'ProviderAttemptBudgetExceededError';
  }
}

/** One synchronous, run-scoped budget for every initiated worker-to-gateway request attempt. */
export class ProviderAttemptBudget {
  private totalStarted = 0;
  private investigationStarted = 0;
  private verificationStarted = 0;
  private deniedAttempts = 0;
  private investigationDenied = 0;
  private verificationDenied = 0;

  readonly limits: Readonly<ProviderAttemptBudgetLimits>;

  constructor(limits: ProviderAttemptBudgetLimits) {
    const { totalLimit, investigationLimit, verificationLimit } = limits;
    if (![totalLimit, investigationLimit, verificationLimit].every(Number.isSafeInteger)
      || totalLimit < 1 || investigationLimit < 1 || verificationLimit < 0
      || totalLimit !== investigationLimit + verificationLimit) {
      throw new RangeError('Review provider request budget limits are invalid');
    }
    this.limits = Object.freeze({ totalLimit, investigationLimit, verificationLimit });
  }

  /** Call immediately before each fetch. Denied attempts never reach the network. */
  beginAttempt(phase: ProviderAttemptPhase): void {
    const phaseStarted = phase === 'investigation' ? this.investigationStarted : this.verificationStarted;
    const phaseLimit = phase === 'investigation' ? this.limits.investigationLimit : this.limits.verificationLimit;
    if (this.totalStarted >= this.limits.totalLimit || phaseStarted >= phaseLimit) {
      this.deniedAttempts += 1;
      if (phase === 'investigation') this.investigationDenied += 1;
      else this.verificationDenied += 1;
      throw new ProviderAttemptBudgetExceededError(phase);
    }
    this.totalStarted += 1;
    if (phase === 'investigation') this.investigationStarted += 1;
    else this.verificationStarted += 1;
  }

  snapshot(): ProviderAttemptBudgetSnapshot {
    return {
      version: PROVIDER_ATTEMPT_BUDGET_VERSION,
      ...this.limits,
      totalStarted: this.totalStarted,
      investigationStarted: this.investigationStarted,
      verificationStarted: this.verificationStarted,
      deniedAttempts: this.deniedAttempts,
      investigationDenied: this.investigationDenied,
      verificationDenied: this.verificationDenied,
    };
  }
}
