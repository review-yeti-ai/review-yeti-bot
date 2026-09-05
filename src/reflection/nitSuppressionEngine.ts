import { PRMemoryStore, ResolvedNitPattern } from '../memory/prMemoryStore';
import { LearningStore } from './learningStore';
import { LiveStreamBus } from '../live/liveStreamBus';

export interface Finding {
  id?: string;
  ruleId?: string;
  rule?: string;
  path: string;
  line?: number;
  title: string;
  body?: string;
  severity?: string;
  comment?: string;
  suggestion?: string;
  [key: string]: any;
}

export function isPathMatch(pattern: string | null | undefined, filePath: string): boolean {
  if (!pattern || pattern === '' || pattern === '**' || pattern === '*') {
    return true;
  }
  if (!filePath) {
    return false;
  }
  if (pattern === filePath) {
    return true;
  }

  let regStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '__STAR__')
    .replace(/\?/g, '__QUESTION__');

  regStr = regStr
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/__STAR__/g, '[^/]*')
    .replace(/__QUESTION__/g, '.');

  const regex = new RegExp(`^${regStr}$`);
  return regex.test(filePath);
}

export class NitSuppressionEngine {
  private prMemoryStore: PRMemoryStore;

  constructor(store?: PRMemoryStore | LearningStore | string) {
    if (typeof store === 'string') {
      this.prMemoryStore = new PRMemoryStore(store);
    } else if (store instanceof PRMemoryStore) {
      this.prMemoryStore = store;
    } else if (store && (store as any).getMemoryStore) {
      this.prMemoryStore = (store as any).getMemoryStore();
    } else if (store && (store as any).prMemoryStore) {
      this.prMemoryStore = (store as any).prMemoryStore;
    } else {
      this.prMemoryStore = new PRMemoryStore();
    }
  }

  public getMemoryStore(): PRMemoryStore {
    return this.prMemoryStore;
  }

  /**
   * Evaluates findings against persistent team memory, suppressing matching false-positive nits.
   * SAFETY ENFORCEMENT: Blocking P0/P1 security and correctness issues are NEVER suppressed.
   */
  public async suppressNits(
    repo: string,
    findings: Finding[],
    jobId?: string,
  ): Promise<{
    activeFindings: Finding[];
    suppressedFindings: Array<{ finding: Finding; nitPattern: ResolvedNitPattern }>;
    active?: Finding[];
    suppressed?: Finding[];
  }> {
    const memory = await this.prMemoryStore.queryLearnings(repo);
    const resolvedNits = memory.resolvedNits || [];

    const activeFindings: Finding[] = [];
    const suppressedFindings: Array<{ finding: Finding; nitPattern: ResolvedNitPattern }> = [];

    for (const finding of findings) {
      const severity = String(finding.severity || '').toUpperCase();
      const isBlocking =
        severity === 'P0' ||
        severity === 'P1' ||
        severity === 'CRITICAL' ||
        severity === 'BLOCKER' ||
        severity === 'HIGH' ||
        severity === 'ERROR';

      // SAFETY: Under no circumstances can P0 or P1 security/correctness findings be suppressed.
      if (isBlocking) {
        activeFindings.push(finding);
        continue;
      }

      const findingRuleId = (finding.ruleId || finding.rule || finding.id || '').toLowerCase().trim();
      const textToMatch = `${finding.title} ${finding.body || ''} ${finding.comment || ''} ${findingRuleId}`.toLowerCase();

      const matchedNit = resolvedNits.find((nit: ResolvedNitPattern) => {
        // 1. File path match
        if (!isPathMatch(nit.filePath, finding.path)) {
          return false;
        }

        // 2. Rule ID match
        const nitRuleId = (nit.ruleId || '').toLowerCase().trim();
        if (nitRuleId && findingRuleId && (nitRuleId === findingRuleId || findingRuleId.includes(nitRuleId))) {
          return true;
        }

        // 3. Pattern match
        const pattern = (nit.pattern || '').toLowerCase().trim();
        if (!pattern) return false;

        if (findingRuleId && (pattern === findingRuleId || findingRuleId.includes(pattern))) {
          return true;
        }

        if (textToMatch.includes(pattern)) {
          return true;
        }

        // Regex pattern support
        try {
          const regex = new RegExp(pattern, 'i');
          if (regex.test(textToMatch)) {
            return true;
          }
        } catch (_) {}

        // Multi-word token match
        const words = pattern.split(/\s+/).filter((w: string) => w.length > 0);
        if (words.length > 0 && words.every((word: string) => textToMatch.includes(word))) {
          return true;
        }

        return false;
      });

      if (matchedNit) {
        suppressedFindings.push({ finding, nitPattern: matchedNit });
        if (matchedNit.id) {
          await this.prMemoryStore.incrementNitSuppression(matchedNit.id);
        }

        if (jobId) {
          LiveStreamBus.getInstance().publishEvent({
            jobId,
            timestamp: new Date().toISOString(),
            type: 'nit:suppression',
            persona: 'quality',
            data: {
              findingTitle: finding.title,
              filePath: finding.path,
              pattern: matchedNit.pattern,
              ruleId: matchedNit.ruleId,
              rationale: `Suppressed per repository resolved nit memory rule: ${matchedNit.pattern}`,
            },
          });
        }
      } else {
        activeFindings.push(finding);
      }
    }

    return {
      activeFindings,
      suppressedFindings,
      active: activeFindings,
      suppressed: suppressedFindings.map((sf) => sf.finding),
    };
  }

  public async filterFindings(
    repo: string,
    findings: Finding[],
    jobId?: string,
  ): Promise<{ active: Finding[]; suppressed: Finding[] }> {
    const res = await this.suppressNits(repo, findings, jobId);
    return {
      active: res.activeFindings,
      suppressed: res.suppressedFindings.map((sf) => sf.finding),
    };
  }

  public async recordDismissedNit(
    repo: string,
    prNumber: number,
    nit: { pattern: string; filePath?: string; ruleId?: string; reason?: string }
  ): Promise<ResolvedNitPattern> {
    return this.prMemoryStore.recordResolvedNit(repo, prNumber, {
      pattern: nit.pattern,
      filePath: nit.filePath || '**',
      ruleId: nit.ruleId,
      reason: nit.reason || 'Dismissed nit via review interaction',
    });
  }
}
