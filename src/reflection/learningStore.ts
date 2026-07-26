import { PRMemoryStore, ReviewerLearning, ResolvedNitPattern, ADRConstraint } from '../memory/prMemoryStore';
import { logger } from '../utils/logger';

export class LearningStore {
  private prMemoryStore: PRMemoryStore;

  constructor(prMemoryStore?: PRMemoryStore) {
    this.prMemoryStore = prMemoryStore || new PRMemoryStore();
  }

  public getMemoryStore(): PRMemoryStore {
    return this.prMemoryStore;
  }

  public async recordLearning(
    repo: string,
    prNumber: number,
    learning: Omit<ReviewerLearning, 'repo' | 'prNumber'>
  ): Promise<ReviewerLearning> {
    logger.info('Record reviewer learning', { repo, prNumber, category: learning.category, title: learning.title });
    return this.prMemoryStore.recordLearning(repo, prNumber, learning);
  }

  public async recordFeedbackNit(
    repo: string,
    prNumber: number,
    pattern: string,
    filePath: string,
    reason: string,
    headSha?: string
  ): Promise<ResolvedNitPattern> {
    logger.info('Record feedback nit pattern', { repo, prNumber, pattern, filePath });
    return this.prMemoryStore.recordResolvedNit(repo, prNumber, {
      pattern,
      filePath,
      reason,
      headSha,
    });
  }

  public async recordADRConstraint(
    repo: string,
    adr: Omit<ADRConstraint, 'repo'>
  ): Promise<ADRConstraint> {
    logger.info('Record ADR constraint', { repo, adrNumber: adr.adrNumber, title: adr.title });
    return this.prMemoryStore.recordADRConstraint(repo, adr);
  }

  public async recordRule(
    repo: string,
    rule: { pattern: string; filePath?: string; category?: any; description?: string }
  ): Promise<void> {
    logger.info('Record explicit team rule via @ct-review learn', { repo, pattern: rule.pattern });
    await this.prMemoryStore.recordResolvedNit(repo, 0, {
      pattern: rule.pattern,
      filePath: rule.filePath || '**',
      reason: rule.description || 'Learned team rule via @ct-review learn command',
    });
  }

  public async saveCommandLearning(repo: string, prNumber: number, command: any): Promise<void> {
    if (!command) return;

    if (command.type === 'adr' || command.adrNumber) {
      await this.prMemoryStore.recordADRConstraint(repo, {
        adrNumber: command.adrNumber || 1,
        title: command.title || command.pattern || 'ADR Constraint',
        status: command.status || 'accepted',
        rule: command.rule || command.description || 'ADR Rule',
        targetPaths: command.targetPaths || ['src/**'],
      });
    } else if (command.type === 'nit' || command.pattern) {
      await this.prMemoryStore.recordResolvedNit(repo, prNumber, {
        pattern: command.pattern,
        filePath: command.filePath || '**',
        reason: command.description || 'Learned nit pattern via @ct-review learn',
      });
    } else {
      await this.prMemoryStore.recordLearning(repo, prNumber, {
        category: command.category || 'convention',
        title: command.title || command.pattern || 'Learned Rule',
        description: command.description || command.pattern || 'Learned Rule',
        filePath: command.filePath,
      });
    }
  }

  public async getLearnedRules(repo: string): Promise<string[]> {
    const memory = await this.prMemoryStore.queryLearnings(repo);
    return memory.resolvedNits.map((n) => n.pattern);
  }

  public async learnPattern(repo: string, pattern: string): Promise<void> {
    await this.recordRule(repo, { pattern });
  }

  public async queryLearnings(repo: string): Promise<any> {
    return this.prMemoryStore.queryLearnings(repo);
  }

  public async getLearnedContext(repo: string): Promise<any> {
    return this.prMemoryStore.queryLearnings(repo);
  }

  public async recordFeedback(repo: string, reaction: string): Promise<void> {
    const isNegative = reaction === '-1' || reaction === 'thumbsdown' || reaction === 'thumbs_down' || reaction === 'dislike';
    const feedbackType = isNegative ? 'negative' : 'positive';
    await this.prMemoryStore.recordFeedback(repo, reaction, feedbackType);
  }

  public async getStats(repo: string) {
    const counts = this.prMemoryStore.getCounts();
    const fbCounts = this.prMemoryStore.getFeedbackCounts(repo);
    return {
      learningsCount: counts.learningsCount,
      suppressedNitsCount: counts.suppressedNitsCount,
      adrConstraintsCount: counts.adrConstraintsCount,
      positiveFeedbackCount: fbCounts.positiveFeedbackCount,
      negativeFeedbackCount: fbCounts.negativeFeedbackCount,
    };
  }

  public close(): void {
    if (this.prMemoryStore && typeof this.prMemoryStore.close === 'function') {
      this.prMemoryStore.close();
    }
  }
}
