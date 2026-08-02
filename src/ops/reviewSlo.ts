export interface ReviewSloSnapshot {
  queueLatencyMs: number;
  firstCommentLatencyMs: number;
  completionLatencyMs: number;
  providerAvailability: number;
  indexFreshness: number;
  costUSD: number;
  falsePositiveFeedback?: number;
}

export class ReviewSlo {
  private queuedAt?: number;
  private startedAt?: number;
  private firstCommentAt?: number;
  private completedAt?: number;

  markQueued(at: number): void { this.queuedAt = at; }
  markStarted(at: number): void { this.startedAt = at; }
  markFirstComment(at: number): void { this.firstCommentAt = at; }
  markCompleted(at: number): void { this.completedAt = at; }

  snapshot(input: { now: number; providerAvailability: number; indexFreshness: number; costUSD: number; falsePositiveFeedback?: number }): ReviewSloSnapshot {
    const queuedAt = this.queuedAt ?? input.now;
    const startedAt = this.startedAt ?? input.now;
    const firstCommentAt = this.firstCommentAt ?? input.now;
    const completedAt = this.completedAt ?? input.now;
    return {
      queueLatencyMs: Math.max(0, startedAt - queuedAt),
      firstCommentLatencyMs: Math.max(0, firstCommentAt - queuedAt),
      completionLatencyMs: Math.max(0, completedAt - queuedAt),
      providerAvailability: Math.max(0, Math.min(1, input.providerAvailability)),
      indexFreshness: Math.max(0, Math.min(1, input.indexFreshness)),
      costUSD: input.costUSD,
      falsePositiveFeedback: input.falsePositiveFeedback,
    };
  }
}
