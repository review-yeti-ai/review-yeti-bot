import { logger } from "../../utils/logger";
import {
  MemoryAdapter,
  ReviewerLearning,
  ResolvedNitPattern,
  ADRConstraint,
  PathInstructionRule,
  LearningQueryOptions,
  CompositeAdapterConfig,
} from "./types";

export class CompositeMemoryAdapter implements MemoryAdapter {
  public readonly providerName = "composite";
  public readonly primary: MemoryAdapter;
  public readonly secondary: MemoryAdapter;
  private writeAsync: boolean;

  constructor(config: CompositeAdapterConfig) {
    this.primary = config.primary;
    this.secondary = config.secondary;
    this.writeAsync = config.writeAsync ?? true;
  }

  public async initialize(): Promise<void> {
    await this.primary.initialize();
    try {
      await this.secondary.initialize();
    } catch (err: any) {
      logger.warn("Secondary memory adapter failed initialization; continuing with primary", {
        primary: this.primary.providerName,
        secondary: this.secondary.providerName,
        error: err?.message,
      });
    }
  }

  public async recordLearning(
    repo: string,
    prNumber: number,
    learning: Omit<ReviewerLearning, "repo" | "prNumber">
  ): Promise<ReviewerLearning> {
    const primaryRecord = await this.primary.recordLearning(repo, prNumber, learning);

    const syncSecondary = async () => {
      try {
        await this.secondary.recordLearning(repo, prNumber, primaryRecord);
      } catch (err: any) {
        logger.warn("Failed dual-write learning to secondary adapter", {
          secondary: this.secondary.providerName,
          error: err?.message,
        });
      }
    };

    if (this.writeAsync) {
      syncSecondary().catch(() => {});
    } else {
      await syncSecondary();
    }

    return primaryRecord;
  }

  public async getLearnings(repo: string, options?: LearningQueryOptions): Promise<ReviewerLearning[]> {
    const primaryResults = await this.primary.getLearnings(repo, options);
    if (primaryResults.length > 0) {
      return primaryResults;
    }

    try {
      const secondaryResults = await this.secondary.getLearnings(repo, options);
      // Seed back into primary cache
      for (const item of secondaryResults) {
        await this.primary.recordLearning(repo, item.prNumber || 0, item).catch(() => {});
      }
      return secondaryResults;
    } catch (err: any) {
      logger.warn("Failed secondary getLearnings query", { error: err?.message });
      return primaryResults;
    }
  }

  public async recordResolvedNit(
    repo: string,
    prNumber: number,
    nit: Omit<ResolvedNitPattern, "repo" | "prNumber">
  ): Promise<ResolvedNitPattern> {
    const primaryRecord = await this.primary.recordResolvedNit(repo, prNumber, nit);

    const syncSecondary = async () => {
      try {
        await this.secondary.recordResolvedNit(repo, prNumber, primaryRecord);
      } catch (err: any) {
        logger.warn("Failed dual-write nit to secondary adapter", {
          secondary: this.secondary.providerName,
          error: err?.message,
        });
      }
    };

    if (this.writeAsync) {
      syncSecondary().catch(() => {});
    } else {
      await syncSecondary();
    }

    return primaryRecord;
  }

  public async getResolvedNits(repo: string, filePath?: string): Promise<ResolvedNitPattern[]> {
    const primaryResults = await this.primary.getResolvedNits(repo, filePath);
    if (primaryResults.length > 0) {
      return primaryResults;
    }

    try {
      const secondaryResults = await this.secondary.getResolvedNits(repo, filePath);
      for (const item of secondaryResults) {
        await this.primary.recordResolvedNit(repo, item.prNumber || 0, item).catch(() => {});
      }
      return secondaryResults;
    } catch (err: any) {
      logger.warn("Failed secondary getResolvedNits query", { error: err?.message });
      return primaryResults;
    }
  }

  public async incrementNitSuppression(id: string): Promise<void> {
    await this.primary.incrementNitSuppression(id);
    this.secondary.incrementNitSuppression(id).catch(() => {});
  }

  public async recordAdrConstraint(
    repo: string,
    constraint: Omit<ADRConstraint, "repo">
  ): Promise<ADRConstraint> {
    const primaryRecord = await this.primary.recordAdrConstraint(repo, constraint);
    this.secondary.recordAdrConstraint(repo, primaryRecord).catch(() => {});
    return primaryRecord;
  }

  public async getAdrConstraints(
    repo: string,
    status?: "draft" | "accepted" | "deprecated"
  ): Promise<ADRConstraint[]> {
    const primaryResults = await this.primary.getAdrConstraints(repo, status);
    if (primaryResults.length > 0) {
      return primaryResults;
    }
    return await this.secondary.getAdrConstraints(repo, status).catch(() => primaryResults);
  }

  public async clear(repo?: string): Promise<void> {
    await this.primary.clear?.(repo);
    await this.secondary.clear?.(repo);
  }

  public async close(): Promise<void> {
    await this.primary.close?.();
    await this.secondary.close?.();
  }
}
