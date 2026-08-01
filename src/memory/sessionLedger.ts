import fs from 'fs';
import path from 'path';

export interface TurnSessionData {
  owner: string;
  repo: string;
  prNumber: number | string;
  headSha: string;
  branch?: string;
  title?: string;
  currentTurn: number;
  maxTurns: number;
  arbitration: {
    verdict: string;
    rationale: string;
    metrics: { p0Count: number; p1Count: number; p2Count: number };
  };
  personaResults: Array<{
    id: string;
    displayName: string;
    decision: string;
    findings: Array<{ severity: string; title: string; path: string; line?: number }>;
  }>;
  costUSD?: number;
  durationMs?: number;
}

export interface SessionMetadata {
  owner: string;
  repo: string;
  prNumber: string;
  branch: string;
  title: string;
  initialHeadSha: string;
  currentHeadSha: string;
  totalTurns: number;
  maxTurns: number;
  createdAt: string;
  updatedAt: string;
  lastVerdict: string;
  history: Array<{ turn: number; headSha: string; timestamp: string; verdict: string; findingsCount: number }>;
}

export class SessionLedger {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(process.cwd(), 'sessions');
  }

  private getSessionDir(owner: string, repo: string, prNumber: string | number): string {
    return path.join(this.baseDir, owner.toLowerCase(), repo.toLowerCase(), `pr-${prNumber}`);
  }

  /**
   * Persists review turn session data and updates global index.
   */
  public recordTurn(data: TurnSessionData): { sessionDir: string; metadata: SessionMetadata } {
    const prStr = String(data.prNumber);
    const sessionDir = this.getSessionDir(data.owner, data.repo, prStr);
    fs.mkdirSync(sessionDir, { recursive: true });

    const now = new Date().toISOString();
    const metaFile = path.join(sessionDir, 'metadata.json');

    let metadata: SessionMetadata;
    if (fs.existsSync(metaFile)) {
      try {
        metadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        metadata.currentHeadSha = data.headSha;
        metadata.totalTurns = data.currentTurn;
        metadata.updatedAt = now;
        metadata.lastVerdict = data.arbitration.verdict;
        metadata.history.push({
          turn: data.currentTurn,
          headSha: data.headSha,
          timestamp: now,
          verdict: data.arbitration.verdict,
          findingsCount: data.personaResults.reduce((acc, p) => acc + p.findings.length, 0),
        });
      } catch (_) {
        metadata = this.createInitialMetadata(data, now);
      }
    } else {
      metadata = this.createInitialMetadata(data, now);
    }

    fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2), 'utf-8');

    // Write turn log JSON file
    const turnFile = path.join(sessionDir, `turn-${data.currentTurn}.json`);
    fs.writeFileSync(turnFile, JSON.stringify({ ...data, recordedAt: now }, null, 2), 'utf-8');

    // Update global search index (sessions/index.json)
    this.updateGlobalIndex(metadata);

    return { sessionDir, metadata };
  }

  private createInitialMetadata(data: TurnSessionData, now: string): SessionMetadata {
    const totalFindings = data.personaResults.reduce((acc, p) => acc + p.findings.length, 0);
    return {
      owner: data.owner,
      repo: data.repo,
      prNumber: String(data.prNumber),
      branch: data.branch || 'main',
      title: data.title || 'PR Review',
      initialHeadSha: data.headSha,
      currentHeadSha: data.headSha,
      totalTurns: data.currentTurn,
      maxTurns: data.maxTurns,
      createdAt: now,
      updatedAt: now,
      lastVerdict: data.arbitration.verdict,
      history: [
        {
          turn: data.currentTurn,
          headSha: data.headSha,
          timestamp: now,
          verdict: data.arbitration.verdict,
          findingsCount: totalFindings,
        },
      ],
    };
  }

  /**
   * Retrieves previous turn context to augment reviewer prompts.
   */
  public getPreviousTurnContext(owner: string, repo: string, prNumber: string | number): {
    hasHistory: boolean;
    previousTurn?: number;
    lastVerdict?: string;
    previousFindings?: Array<{ severity: string; title: string; path: string }>;
    remainingTurns: number;
    augmentedHeader?: string;
  } {
    const prStr = String(prNumber);
    const sessionDir = this.getSessionDir(owner, repo, prStr);
    const metaFile = path.join(sessionDir, 'metadata.json');

    if (!fs.existsSync(metaFile)) {
      return { hasHistory: false, remainingTurns: 20 };
    }

    try {
      const metadata: SessionMetadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      const lastTurn = metadata.totalTurns;
      const lastTurnFile = path.join(sessionDir, `turn-${lastTurn}.json`);
      let previousFindings: Array<{ severity: string; title: string; path: string }> = [];

      if (fs.existsSync(lastTurnFile)) {
        const lastTurnData: TurnSessionData = JSON.parse(fs.readFileSync(lastTurnFile, 'utf-8'));
        lastTurnData.personaResults.forEach((p) => {
          p.findings.forEach((f) => {
            previousFindings.push({ severity: f.severity, title: f.title, path: f.path });
          });
        });
      }

      const remainingTurns = Math.max(0, (metadata.maxTurns || 20) - lastTurn);

      const header = `## 🔄 Multi-Turn Review Context (Turn ${lastTurn + 1} of ${metadata.maxTurns || 20})
- **Repository**: \`${owner}/${repo}\` | **PR**: \`#${prNumber}\`
- **Remaining Turn Budget**: \`${remainingTurns}\` turn(s) left
- **Previous Verdict (Turn ${lastTurn})**: \`${metadata.lastVerdict}\`
- **Prior Findings Tracked**: \`${previousFindings.length}\` finding(s) from Turn ${lastTurn}
${previousFindings.map((f) => `  - [${f.severity}] ${f.title} (\`${f.path}\`)`).join('\n')}`;

      return {
        hasHistory: true,
        previousTurn: lastTurn,
        lastVerdict: metadata.lastVerdict,
        previousFindings,
        remainingTurns,
        augmentedHeader: header,
      };
    } catch (_) {
      return { hasHistory: false, remainingTurns: 20 };
    }
  }

  private updateGlobalIndex(meta: SessionMetadata): void {
    const indexFile = path.join(this.baseDir, 'index.json');
    let index: Record<string, any> = {};
    if (fs.existsSync(indexFile)) {
      try {
        index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      } catch (_) {}
    }

    const key = `${meta.owner}/${meta.repo}#${meta.prNumber}`;
    index[key] = {
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      title: meta.title,
      branch: meta.branch,
      currentHeadSha: meta.currentHeadSha,
      totalTurns: meta.totalTurns,
      maxTurns: meta.maxTurns,
      lastVerdict: meta.lastVerdict,
      updatedAt: meta.updatedAt,
    };

    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf-8');
  }
}

function dataOwnerRepoPr(owner: string, repo: string, prNumber: string | number): string {
  return `${owner}/${repo}/${prNumber}`;
}
