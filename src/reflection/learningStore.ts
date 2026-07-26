import { PRMemoryStore, ReviewerLearning, ResolvedNitPattern } from '../memory/prMemoryStore';
import { ParsedReflectionCommand } from './commandParser';

export class LearningStore {
  private prMemoryStore: PRMemoryStore;

  constructor(memoryStoreOrDbPath?: PRMemoryStore | string) {
    if (memoryStoreOrDbPath instanceof PRMemoryStore) {
      this.prMemoryStore = memoryStoreOrDbPath;
    } else {
      const dbPath = typeof memoryStoreOrDbPath === 'string' ? memoryStoreOrDbPath : '.ct-memory/pr_memory.db';
      this.prMemoryStore = new PRMemoryStore(dbPath);
    }
  }

  public async saveCommandLearning(repo: string, prNumber: number, cmd: ParsedReflectionCommand): Promise<void> {
    if (cmd.type === 'learning') {
      await this.prMemoryStore.recordLearning(repo, prNumber, {
        category: (cmd.category as any) || 'convention',
        title: cmd.title || cmd.description || 'Learned Rule',
        description: cmd.description || cmd.title || 'Learned Rule',
        filePath: cmd.filePath,
      });
    } else if (cmd.type === 'nit') {
      await this.prMemoryStore.recordResolvedNit(repo, prNumber, {
        pattern: cmd.pattern || 'Resolved nit',
        filePath: cmd.filePath || '**',
        reason: cmd.reason || 'Resolved nit',
      });
    } else if (cmd.type === 'adr') {
      await this.prMemoryStore.recordADRConstraint(repo, {
        adrNumber: cmd.adrNumber || 0,
        title: cmd.title || 'ADR',
        status: 'accepted',
        rule: cmd.description || 'ADR Rule',
        targetPaths: cmd.targetPaths || ['**'],
      });
    }
  }

  public async recordFeedbackNit(
    repo: string,
    prNumber: number,
    pattern: string,
    filePath: string,
    reason: string
  ): Promise<void> {
    await this.prMemoryStore.recordResolvedNit(repo, prNumber, {
      pattern,
      filePath: filePath || '**',
      reason,
    });
  }

  public async getLearnedContext(repo: string) {
    return this.prMemoryStore.queryLearnings(repo);
  }

  public async recordRule(repo: string, rule: any): Promise<void> {
    await this.prMemoryStore.recordResolvedNit(repo, 0, {
      id: rule.ruleId,
      pattern: rule.pattern,
      filePath: rule.pathPattern || '**',
      reason: rule.pattern,
    });
    await this.prMemoryStore.recordLearning(repo, 0, {
      category: rule.category || 'convention',
      title: rule.pattern,
      description: rule.pattern,
      filePath: rule.pathPattern,
    });
  }

  public async recordLearning(repo: string, pattern: string): Promise<void> {
    await this.recordRule(repo, { pattern });
  }

  public async queryLearnings(repo: string): Promise<any> {
    return this.prMemoryStore.queryLearnings(repo);
  }

  public async recordFeedback(repo: string, reaction: string): Promise<void> {
    await this.prMemoryStore.recordFeedback(repo, reaction);
  }

  public async getStats(repo: string) {
    const counts = this.prMemoryStore.getCounts();
    const fbCounts = this.prMemoryStore.getFeedbackCounts(repo);
    return {
      learningsCount: counts.learningsCount,
      suppressedNitsCount: counts.suppressedNitsCount,
      positiveFeedbackCount: fbCounts.positiveFeedbackCount,
      negativeFeedbackCount: fbCounts.negativeFeedbackCount,
    };
  }

  public close(): void {
    this.prMemoryStore.close();
  }
}

