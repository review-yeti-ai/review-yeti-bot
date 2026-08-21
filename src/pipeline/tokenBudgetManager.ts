import { CtReviewConfigV3 } from '../config/schema';
import { ChangedFile } from './hunkFilter';

export type ReasoningEffortTier = 'low' | 'medium' | 'high';

export interface TokenBudgetAllocation {
  effortTier: ReasoningEffortTier;
  maxPromptTokensPerPersona: number;
  maxCompletionTokensPerPersona: number;
  maxTokens: number;
  providerEffortSetting: 'low' | 'medium' | 'high';
  estimatedTotalCostUSD: number;
}

export interface CalculateBudgetOptions {
  effortLevel?: ReasoningEffortTier;
  diffLineCount?: number;
  changedFiles?: ChangedFile[];
  config?: CtReviewConfigV3;
}

export function evaluateEffortAndBudget(
  changedFiles: ChangedFile[],
  config?: CtReviewConfigV3
): TokenBudgetAllocation {
  let totalDiffLength = 0;
  let sensitiveFileCount = 0;

  for (const file of changedFiles) {
    totalDiffLength += (file.patch?.length || 0);
    const p = file.path.toLowerCase();
    if (p.includes('auth') || p.includes('security') || p.includes('crypto') || p.includes('permission')) {
      sensitiveFileCount++;
    }
  }

  const lineEstimate = Math.ceil(totalDiffLength / 40);

  let effortTier: ReasoningEffortTier = 'low';

  if (lineEstimate < 50 && sensitiveFileCount === 0) {
    effortTier = 'low';
  } else if (lineEstimate > 500 || sensitiveFileCount > 0 || config?.profile === 'assertive') {
    effortTier = 'high';
  }

  switch (effortTier as ReasoningEffortTier) {
    case 'medium':
      return {
        effortTier: 'medium',
        maxPromptTokensPerPersona: 12000,
        maxCompletionTokensPerPersona: 2000,
        maxTokens: 14000,
        providerEffortSetting: 'medium',
        estimatedTotalCostUSD: 0.02,
      };
    case 'high':
      return {
        effortTier: 'high',
        maxPromptTokensPerPersona: 32000,
        maxCompletionTokensPerPersona: 4000,
        maxTokens: 36000,
        providerEffortSetting: 'high',
        estimatedTotalCostUSD: 0.08,
      };
    case 'low':
    default:
      return {
        effortTier: 'low',
        maxPromptTokensPerPersona: 4000,
        maxCompletionTokensPerPersona: 800,
        maxTokens: 4800,
        providerEffortSetting: 'low',
        estimatedTotalCostUSD: 0.005,
      };
  }
}

export class TokenBudgetManager {
  private readonly reservations = new Map<string, number>();

  /** Atomically reserve a bounded token amount for one review run. */
  public reserve(runId: string, requestedTokens: number, capTokens: number): boolean {
    if (!Number.isFinite(requestedTokens) || requestedTokens < 0 || !Number.isFinite(capTokens) || capTokens < 0) return false;
    const current = this.reservations.get(runId) || 0;
    if (current + requestedTokens > capTokens) return false;
    this.reservations.set(runId, current + requestedTokens);
    return true;
  }

  public release(runId: string, requestedTokens: number): void {
    if (!Number.isFinite(requestedTokens)) return;
    const current = this.reservations.get(runId) || 0;
    const remaining = Math.max(0, current - Math.max(0, requestedTokens));
    if (remaining === 0) this.reservations.delete(runId);
    else this.reservations.set(runId, remaining);
  }

  public reserved(runId: string): number {
    return this.reservations.get(runId) || 0;
  }

  public calculateBudget(options: CalculateBudgetOptions): TokenBudgetAllocation {
    if (options.effortLevel) {
      switch (options.effortLevel) {
        case 'medium':
          return {
            effortTier: 'medium',
            maxPromptTokensPerPersona: 12000,
            maxCompletionTokensPerPersona: 2000,
            maxTokens: 14000,
            providerEffortSetting: 'medium',
            estimatedTotalCostUSD: 0.02,
          };
        case 'high':
          return {
            effortTier: 'high',
            maxPromptTokensPerPersona: 32000,
            maxCompletionTokensPerPersona: 4000,
            maxTokens: 36000,
            providerEffortSetting: 'high',
            estimatedTotalCostUSD: 0.08,
          };
        case 'low':
        default:
          return {
            effortTier: 'low',
            maxPromptTokensPerPersona: 4000,
            maxCompletionTokensPerPersona: 800,
            maxTokens: 4800,
            providerEffortSetting: 'low',
            estimatedTotalCostUSD: 0.005,
          };
      }
    }

    return evaluateEffortAndBudget(options.changedFiles || [], options.config);
  }
}
