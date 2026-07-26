import { PRMemoryStore } from '../memory/prMemoryStore';
import { LearningStore } from './learningStore';

export interface Finding {
  id?: string;
  path: string;
  line?: number;
  title: string;
  body?: string;
  severity?: string;
}

function isPathMatch(pattern: string | null | undefined, filePath: string): boolean {
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

  constructor(store: PRMemoryStore | LearningStore) {
    if (store instanceof PRMemoryStore) {
      this.prMemoryStore = store;
    } else {
      this.prMemoryStore = (store as any).prMemoryStore || new PRMemoryStore();
    }
  }

  public async suppressNits(
    repo: string,
    findings: Finding[]
  ): Promise<{
    activeFindings: Finding[];
    suppressedFindings: Array<{ finding: Finding; nitPattern: any }>;
    active?: Finding[];
    suppressed?: Finding[];
  }> {
    const memory = await this.prMemoryStore.queryLearnings(repo);
    const resolvedNits = memory.resolvedNits || [];

    const activeFindings: Finding[] = [];
    const suppressedFindings: Array<{ finding: Finding; nitPattern: any }> = [];

    for (const finding of findings) {
      const isNit = finding.severity === 'nit' || finding.severity === 'minor' || finding.severity === 'P2';
      const textToMatch = `${finding.title} ${finding.body || ''}`.toLowerCase();

      const matchedNit = resolvedNits.find((nit: any) => {
        if (!isPathMatch(nit.filePath, finding.path)) {
          return false;
        }

        const pattern = (nit.pattern || '').toLowerCase().trim();
        if (!pattern) return false;

        if (textToMatch.includes(pattern)) {
          return true;
        }

        const words = pattern.split(/\s+/).filter((w: string) => w.length > 0);
        if (words.length > 0 && words.every((word: string) => textToMatch.includes(word))) {
          return true;
        }

        return false;
      });

      if (isNit && matchedNit) {
        suppressedFindings.push({ finding, nitPattern: matchedNit });
        if (matchedNit.id) {
          await this.prMemoryStore.incrementNitSuppression(matchedNit.id);
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
    findings: Finding[]
  ): Promise<{ active: Finding[]; suppressed: Finding[] }> {
    const res = await this.suppressNits(repo, findings);
    return {
      active: res.activeFindings,
      suppressed: res.suppressedFindings.map((sf) => sf.finding),
    };
  }
}

