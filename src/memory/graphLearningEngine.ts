import { PRMemoryStore, ReviewerLearning, ResolvedNitPattern, ADRConstraint } from './prMemoryStore';
import { PlatformMemoryStore, PlatformPattern } from './platformMemoryStore';
import { SymbolGraphStore } from '../indexer/symbolGraphStore';
import { PanelFinding } from '../panel/panelEngine';
import { logger } from '../utils/logger';

export interface FilterResult {
  filteredFindings: PanelFinding[];
  suppressedNits: Array<{ finding: PanelFinding; matchedPattern: ResolvedNitPattern }>;
  appliedADRs: ADRConstraint[];
  platformInsights: PlatformPattern[];
}

export class GraphLearningEngine {
  private memoryStore: PRMemoryStore;
  private symbolStore: SymbolGraphStore;
  private platformStore: PlatformMemoryStore;

  constructor(memoryStore?: PRMemoryStore, symbolStore?: SymbolGraphStore, platformStore?: PlatformMemoryStore) {
    this.memoryStore = memoryStore || new PRMemoryStore();
    this.symbolStore = symbolStore || new SymbolGraphStore();
    this.platformStore = platformStore || new PlatformMemoryStore();
  }

  public getMemoryStore(): PRMemoryStore {
    return this.memoryStore;
  }

  public getSymbolStore(): SymbolGraphStore {
    return this.symbolStore;
  }

  public getPlatformStore(): PlatformMemoryStore {
    return this.platformStore;
  }

  /**
   * Calculates a symbol's risk score based on callers and historical repo learnings.
   */
  public async calculateSymbolRisk(
    repo: string,
    symbolName: string
  ): Promise<{
    symbolName: string;
    riskScore: number;
    callersCount: number;
    pastLearningsCount: number;
  }> {
    const memory = await this.memoryStore.queryLearnings(repo);
    let callersCount = 0;

    if (this.symbolStore && typeof (this.symbolStore as any).queryCallers === 'function') {
      try {
        const callers = await (this.symbolStore as any).queryCallers(symbolName);
        callersCount = Array.isArray(callers) ? callers.length : 0;
      } catch {
        callersCount = 0;
      }
    } else if (this.symbolStore && typeof (this.symbolStore as any).getCallersCount === 'function') {
      callersCount = await (this.symbolStore as any).getCallersCount(symbolName);
    }

    const pastLearningsCount = memory.learnings.filter(
      (l) => l.title.includes(symbolName) || l.description.includes(symbolName) || (l.filePath && l.filePath.includes(symbolName))
    ).length;

    let rawScore = 0.1 + callersCount * 0.05 + pastLearningsCount * 0.15;
    const riskScore = Math.min(1.0, Math.round(rawScore * 100) / 100);

    return {
      symbolName,
      riskScore,
      callersCount,
      pastLearningsCount,
    };
  }

  /**
   * Analyzes findings against historical resolved nits, ADR constraints, AND global platform memory patterns.
   * Suppresses matching nit patterns and attaches ADR/Platform context warnings.
   */
  public async analyzeAndFilterFindings(
    repo: string,
    findings: PanelFinding[]
  ): Promise<FilterResult> {
    const memory = await this.memoryStore.queryLearnings(repo);
    const platformPatterns = await this.platformStore.queryPlatformPatterns();
    const filteredFindings: PanelFinding[] = [];
    const suppressedNits: Array<{ finding: PanelFinding; matchedPattern: ResolvedNitPattern }> = [];

    const matchedNitIds: string[] = [];

    for (const finding of findings) {
      // 1. Check if finding matches a local repo resolved nit pattern
      const matchingNit = memory.resolvedNits.find((nit) => {
        if (nit.filePath && nit.filePath !== finding.path && nit.filePath !== '') return false;
        try {
          const regex = new RegExp(nit.pattern, 'i');
          return regex.test(finding.title) || regex.test(finding.body);
        } catch {
          const pat = nit.pattern.toLowerCase();
          return finding.title.toLowerCase().includes(pat) || finding.body.toLowerCase().includes(pat);
        }
      });

      if (matchingNit) {
        if (matchingNit.id) {
          matchedNitIds.push(matchingNit.id);
        }
        suppressedNits.push({ finding, matchedPattern: matchingNit });
        logger.info('Suppressed resolved nit finding via repo memory', { repo, path: finding.path, pattern: matchingNit.pattern });
      } else {
        filteredFindings.push(finding);
      }
    }

    if (matchedNitIds.length > 0) {
      if (typeof (this.memoryStore as any).incrementNitSuppressionBatch === 'function') {
        await (this.memoryStore as any).incrementNitSuppressionBatch(matchedNitIds);
      } else {
        for (const id of matchedNitIds) {
          await this.memoryStore.incrementNitSuppression(id);
        }
      }
    }

    // 2. Identify relevant ADR constraints based on changed files
    const targetPaths = new Set(findings.map((f) => f.path));
    const appliedADRs = memory.adrConstraints.filter((adr) =>
      adr.targetPaths.some((glob) => Array.from(targetPaths).some((p) => this.matchGlob(glob, p)))
    );

    return {
      filteredFindings,
      suppressedNits,
      appliedADRs,
      platformInsights: platformPatterns,
    };
  }

  /**
   * Learns a new rule from a team interaction and elevates it to global platform memory.
   */
  public async learnAndElevatePattern(
    repo: string,
    category: 'security' | 'architecture' | 'performance' | 'quality' | 'convention',
    pattern: string,
    description: string,
    prNumber: number = 0
  ): Promise<void> {
    // 1. Store in local repository memory
    await this.memoryStore.recordLearning(repo, prNumber, {
      category: category === 'quality' ? 'convention' : category,
      title: pattern,
      description,
    });

    // 2. Elevate to global platform memory for cross-repo intelligence
    const platCategory = category === 'convention' ? 'quality' : category;
    await this.platformStore.recordPlatformPattern(platCategory, pattern, description, repo);
  }

  private matchGlob(pattern: string, filePath: string): boolean {
    if (pattern === '*' || pattern === '**') return true;

    const cleanPattern = pattern.startsWith('!') ? pattern.slice(1) : pattern;

    // Root-level wildcard like *.ts should only match root files without slashes
    if (cleanPattern.startsWith('*.') && !cleanPattern.includes('/')) {
      const ext = cleanPattern.slice(1);
      return filePath.endsWith(ext) && !filePath.includes('/');
    }

    if (cleanPattern.startsWith('**/')) {
      const sub = cleanPattern.slice(3);
      if (sub.startsWith('*.')) {
        return filePath.endsWith(sub.slice(1));
      }
      return filePath.endsWith(sub) || filePath.includes('/' + sub);
    }

    if (filePath === cleanPattern || filePath.endsWith('/' + cleanPattern)) return true;

    try {
      const regexStr = '^' + cleanPattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.)\*/g, '[^/]*') + '$';
      const regex = new RegExp(regexStr);
      if (regex.test(filePath)) return true;
    } catch {
      // Fallback
    }

    return filePath.includes(cleanPattern.replace(/\*/g, ''));
  }
}
