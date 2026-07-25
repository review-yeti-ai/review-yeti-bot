import { PRMemoryStore, ReviewerLearning, ResolvedNitPattern, ADRConstraint } from './prMemoryStore';
import { SymbolGraphStore } from '../indexer/symbolGraphStore';
import { PanelFinding } from '../panel/panelEngine';
import { logger } from '../utils/logger';

export interface FilterResult {
  filteredFindings: PanelFinding[];
  suppressedNits: Array<{ finding: PanelFinding; matchedPattern: ResolvedNitPattern }>;
  appliedADRs: ADRConstraint[];
}

export class GraphLearningEngine {
  private memoryStore: PRMemoryStore;
  private symbolStore: SymbolGraphStore;

  constructor(memoryStore?: PRMemoryStore, symbolStore?: SymbolGraphStore) {
    this.memoryStore = memoryStore || new PRMemoryStore();
    this.symbolStore = symbolStore || new SymbolGraphStore();
  }

  public getMemoryStore(): PRMemoryStore {
    return this.memoryStore;
  }

  public getSymbolStore(): SymbolGraphStore {
    return this.symbolStore;
  }

  /**
   * Analyzes findings against historical resolved nits and ADR constraints.
   * Suppresses matching nit patterns and attaches ADR context warnings.
   */
  public async analyzeAndFilterFindings(
    repo: string,
    findings: PanelFinding[]
  ): Promise<FilterResult> {
    const memory = await this.memoryStore.queryLearnings(repo);
    const filteredFindings: PanelFinding[] = [];
    const suppressedNits: Array<{ finding: PanelFinding; matchedPattern: ResolvedNitPattern }> = [];

    for (const finding of findings) {
      // 1. Check if finding matches a resolved nit pattern
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
          await this.memoryStore.incrementNitSuppression(matchingNit.id);
        }
        suppressedNits.push({ finding, matchedPattern: matchingNit });
        logger.info('Suppressed resolved nit finding', { repo, path: finding.path, pattern: matchingNit.pattern });
      } else {
        filteredFindings.push(finding);
      }
    }

    // 2. Identify relevant ADR constraints based on changed files
    const targetPaths = new Set(findings.map((f) => f.path));
    const appliedADRs = memory.adrConstraints.filter((adr) =>
      adr.targetPaths.some((glob) => Array.from(targetPaths).some((p) => this.matchGlob(glob, p)))
    );

    return { filteredFindings, suppressedNits, appliedADRs };
  }

  /**
   * Evaluates symbol risk score using symbol graph callees/callers and historical memory issues.
   */
  public async calculateSymbolRisk(
    repo: string,
    symbolName: string
  ): Promise<{ symbolName: string; riskScore: number; callersCount: number; pastLearningsCount: number }> {
    let callersCount = 0;
    try {
      const symRes = await this.symbolStore.querySymbols(symbolName);
      callersCount = symRes.callers ? symRes.callers.length : 0;
    } catch (err: any) {
      logger.warn('Failed querying symbols for risk calculation', { symbolName, error: err.message });
    }

    const memory = await this.memoryStore.queryLearnings(repo, { query: symbolName });
    const pastLearningsCount = memory.learnings.length;

    // Risk score heuristic: base score (0.1) + callers weight (0.05 * callers) + past learnings (0.15 * count)
    const rawScore = 0.1 + (callersCount * 0.05) + (pastLearningsCount * 0.15);
    const riskScore = Math.min(1.0, Math.round(rawScore * 100) / 100);

    return { symbolName, riskScore, callersCount, pastLearningsCount };
  }

  private matchGlob(pattern: string, filePath: string): boolean {
    if (pattern === '**' || pattern === '*' || pattern === '') return true;
    try {
      let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      regexStr = regexStr
        .replace(/\/\*\*(\/|$)/g, (_match, suffix) => (suffix === '/' ? '__DIR_WILDCARD_SLASH__' : '__DIR_WILDCARD__'))
        .replace(/^\*\*\//g, '__START_DIR_WILDCARD__')
        .replace(/\*\*/g, '__ANY_WILDCARD__')
        .replace(/\*/g, '__SINGLE_WILDCARD__')
        .replace(/\?/g, '__SINGLE_CHAR__')
        .replace(/__DIR_WILDCARD_SLASH__/g, '(?:/.*)?/')
        .replace(/__DIR_WILDCARD__/g, '(?:/.*)?')
        .replace(/__START_DIR_WILDCARD__/g, '(?:^|.*/)')
        .replace(/__ANY_WILDCARD__/g, '.*')
        .replace(/__SINGLE_WILDCARD__/g, '[^/]*')
        .replace(/__SINGLE_CHAR__/g, '[^/]');
      return new RegExp(`^${regexStr}$`).test(filePath);
    } catch {
      return filePath.includes(pattern);
    }
  }
}
