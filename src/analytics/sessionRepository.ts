import fs from 'fs';
import path from 'path';
import { dashboardStore } from '../persistence/dashboardStore';
import {
  SessionFilterOptions,
  SessionRecord,
  SessionDetail,
  SessionFinding,
  TurnDelta,
  SessionTurnDetail,
  FindingsDelta,
} from './types';
import { computeFindingsDelta } from './kpiCalculator';

export class SessionRepository {
  private baseDir: string;
  private store: any;

  constructor(baseDir?: string, store?: any) {
    this.baseDir = baseDir || path.join(process.cwd(), 'sessions');
    this.store = store || dashboardStore;
  }

  public getAllSessions(): SessionRecord[] {
    return this.getSessions();
  }

  public getSessions(filter?: SessionFilterOptions): SessionRecord[] {
    let sessions = this.loadDiskSessions();

    if (sessions.length === 0) {
      sessions = this.loadFallbackSessions();
    }

    if (!filter) {
      return sessions;
    }

    return sessions.filter((s) => this.matchesFilter(s, filter));
  }

  public getSessionById(id: string): SessionDetail | null {
    // Normalization: e.g. "owner/repo#123" or "owner/repo/123"
    const cleanedId = id.replace('/', '__').replace('#', '__');
    const sessions = this.getSessions();
    const target = sessions.find((s) => {
      const sCleaned = s.id.replace('/', '__').replace('#', '__');
      return (
        s.id === id ||
        sCleaned === cleanedId ||
        `${s.owner}/${s.repo}#${s.prNumber}` === id ||
        `${s.owner}/${s.repo}/${s.prNumber}` === id
      );
    });

    if (!target) return null;

    // Load full turn details from disk if available
    const diskDetail = this.loadDiskSessionDetail(target.owner, target.repo, target.prNumber);
    if (diskDetail) {
      return diskDetail;
    }

    // Otherwise construct detail from session record
    const history: TurnDelta[] = [
      {
        turn: target.totalTurns || 1,
        headSha: target.currentHeadSha || '',
        timestamp: target.updatedAt || target.createdAt || new Date().toISOString(),
        verdict: target.lastVerdict,
        findingsCount: target.findings.length,
        findings: target.findings,
        deltaFromPrevious: target.findingsDelta,
      },
    ];

    const turns: SessionTurnDetail[] = [
      {
        turn: target.totalTurns || 1,
        headSha: target.currentHeadSha || '',
        recordedAt: target.updatedAt || target.createdAt,
        arbitration: {
          verdict: target.lastVerdict,
          rationale: `Verdict for ${target.id}`,
          metrics: {
            p0Count: target.findings.filter((f) => f.severity.toUpperCase() === 'P0').length,
            p1Count: target.findings.filter((f) => f.severity.toUpperCase() === 'P1').length,
            p2Count: target.findings.filter((f) => f.severity.toUpperCase() === 'P2').length,
          },
        },
        personaResults: [
          {
            id: 'default',
            displayName: 'Review Persona',
            decision: target.lastVerdict,
            findings: target.findings,
          },
        ],
        costUSD: target.costUSD,
        durationMs: target.latencyMs,
        tokens: target.tokens,
      },
    ];

    return {
      ...target,
      history,
      turns,
    };
  }

  private loadDiskSessions(): SessionRecord[] {
    if (!fs.existsSync(this.baseDir)) {
      return [];
    }

    const indexFile = path.join(this.baseDir, 'index.json');
    const records: SessionRecord[] = [];

    if (fs.existsSync(indexFile)) {
      try {
        const indexData = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        const entries = Array.isArray(indexData) ? indexData : Object.values(indexData);

        for (const entry of entries as any[]) {
          const owner = entry.owner || 'unknown';
          const repo = entry.repo || 'unknown';
          const prNumber = typeof entry.prNumber === 'number' ? entry.prNumber : parseInt(entry.prNumber || '0', 10);
          const detail = this.loadDiskSessionDetail(owner, repo, prNumber);
          if (detail) {
            records.push(detail);
          } else {
            records.push({
              id: `${owner}/${repo}#${prNumber}`,
              owner,
              repo,
              prNumber,
              title: entry.title || `PR #${prNumber}`,
              branch: entry.branch || 'main',
              initialHeadSha: entry.initialHeadSha || entry.currentHeadSha || '',
              currentHeadSha: entry.currentHeadSha || '',
              totalTurns: entry.totalTurns || 1,
              maxTurns: entry.maxTurns || 20,
              createdAt: entry.createdAt || entry.updatedAt || new Date().toISOString(),
              updatedAt: entry.updatedAt || new Date().toISOString(),
              lastVerdict: entry.lastVerdict || entry.verdict || 'SHIP',
              costUSD: entry.costUSD || 0,
              latencyMs: entry.latencyMs || entry.durationMs || 0,
              tokens: entry.tokens || { prompt: 0, completion: 0, total: 0 },
              findings: entry.findings || [],
            });
          }
        }

        if (records.length > 0) return records;
      } catch (_) {
        // Fallthrough to directory scanning if index parsing fails
      }
    }

    // Direct directory scan under baseDir
    try {
      const owners = fs.readdirSync(this.baseDir).filter((f) => {
        const full = path.join(this.baseDir, f);
        return fs.statSync(full).isDirectory() && f !== 'node_modules';
      });

      for (const owner of owners) {
        const ownerDir = path.join(this.baseDir, owner);
        const repos = fs.readdirSync(ownerDir).filter((f) => {
          return fs.statSync(path.join(ownerDir, f)).isDirectory();
        });

        for (const repo of repos) {
          const repoDir = path.join(ownerDir, repo);
          const prDirs = fs.readdirSync(repoDir).filter((f) => f.startsWith('pr-'));

          for (const prDir of prDirs) {
            const prNumStr = prDir.replace('pr-', '');
            const prNumber = parseInt(prNumStr, 10);
            const detail = this.loadDiskSessionDetail(owner, repo, prNumber);
            if (detail) {
              records.push(detail);
            }
          }
        }
      }
    } catch (_) {}

    return records;
  }

  private loadDiskSessionDetail(owner: string, repo: string, prNumber: number | string): SessionDetail | null {
    const prStr = String(prNumber);
    const sessionDir = path.join(this.baseDir, owner.toLowerCase(), repo.toLowerCase(), `pr-${prStr}`);
    const metaFile = path.join(sessionDir, 'metadata.json');

    if (!fs.existsSync(sessionDir)) {
      return null;
    }

    let metadata: any = {};
    if (fs.existsSync(metaFile)) {
      try {
        metadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      } catch (_) {}
    }

    // Find all turn files (turn-1.json, turn-2.json, ...)
    const turnFiles = fs
      .readdirSync(sessionDir)
      .filter((f) => /^turn-\d+\.json$/.test(f))
      .sort((a, b) => {
        const numA = parseInt(a.replace('turn-', '').replace('.json', ''), 10);
        const numB = parseInt(b.replace('turn-', '').replace('.json', ''), 10);
        return numA - numB;
      });

    const turns: SessionTurnDetail[] = [];
    let totalCostUSD = 0;
    let totalDurationMs = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    for (const turnFile of turnFiles) {
      try {
        const turnData = JSON.parse(fs.readFileSync(path.join(sessionDir, turnFile), 'utf-8'));
        const turnNum = turnData.currentTurn || parseInt(turnFile.replace('turn-', '').replace('.json', ''), 10);

        const personaFindings: SessionFinding[] = [];
        if (Array.isArray(turnData.personaResults)) {
          for (const p of turnData.personaResults) {
            if (Array.isArray(p.findings)) {
              for (const f of p.findings) {
                personaFindings.push({
                  severity: f.severity || 'P1',
                  title: f.title || f.message || 'Finding',
                  path: f.path || f.file || 'unknown',
                  line: f.line,
                  turn: turnNum,
                  persona: p.displayName || p.id,
                });
              }
            }
          }
        }

        turns.push({
          turn: turnNum,
          headSha: turnData.headSha || '',
          recordedAt: turnData.recordedAt,
          arbitration: turnData.arbitration,
          personaResults: turnData.personaResults
            ? turnData.personaResults.map((p: any) => ({
                id: p.id,
                displayName: p.displayName,
                decision: p.decision,
                findings: (p.findings || []).map((f: any) => ({
                  severity: f.severity || 'P1',
                  title: f.title || 'Finding',
                  path: f.path || 'unknown',
                  line: f.line,
                  turn: turnNum,
                  persona: p.displayName || p.id,
                })),
              }))
            : [],
          costUSD: turnData.costUSD || 0,
          durationMs: turnData.durationMs || turnData.latencyMs || 0,
          tokens: turnData.tokens || { prompt: 0, completion: 0, total: 0 },
        });

        totalCostUSD += turnData.costUSD || 0;
        totalDurationMs += turnData.durationMs || turnData.latencyMs || 0;
        if (turnData.tokens) {
          promptTokens += turnData.tokens.prompt || 0;
          completionTokens += turnData.tokens.completion || 0;
          totalTokens += turnData.tokens.total || (turnData.tokens.prompt || 0) + (turnData.tokens.completion || 0);
        }
      } catch (_) {}
    }

    const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    const latestFindings = latestTurn ? latestTurn.personaResults?.flatMap((p) => p.findings) || [] : [];
    const lastVerdict = metadata.lastVerdict || (latestTurn?.arbitration?.verdict) || 'SHIP';
    const totalTurns = metadata.totalTurns || turns.length || 1;
    const maxTurns = metadata.maxTurns || 20;

    // Turn deltas computation
    const turnDeltas: TurnDelta[] = [];
    const turnFindingsList = turns.map((t) => t.personaResults?.flatMap((p) => p.findings) || []);

    for (let i = 0; i < turns.length; i++) {
      const turnObj = turns[i];
      const prevFindings = i > 0 ? turnFindingsList[i - 1] : [];
      const currFindings = turnFindingsList[i];
      const delta = computeFindingsDelta(prevFindings, currFindings);

      turnDeltas.push({
        turn: turnObj.turn,
        headSha: turnObj.headSha,
        timestamp: turnObj.recordedAt || metadata.updatedAt || new Date().toISOString(),
        verdict: turnObj.arbitration?.verdict || lastVerdict,
        findingsCount: currFindings.length,
        findings: currFindings,
        deltaFromPrevious: delta,
      });
    }

    const sessionDelta: FindingsDelta =
      turns.length > 0
        ? computeFindingsDelta(turnFindingsList[0] || [], turnFindingsList[turnFindingsList.length - 1] || [])
        : {
            initialFindings: 0,
            latestFindings: 0,
            resolvedFindings: 0,
            newFindings: 0,
            persistentFindings: 0,
            netChange: 0,
          };

    return {
      id: `${owner}/${repo}#${prNumber}`,
      owner,
      repo,
      prNumber: typeof prNumber === 'number' ? prNumber : parseInt(prNumber, 10),
      title: metadata.title || `PR Review #${prNumber}`,
      branch: metadata.branch || 'main',
      initialHeadSha: metadata.initialHeadSha || (turns[0]?.headSha) || '',
      currentHeadSha: metadata.currentHeadSha || (latestTurn?.headSha) || '',
      totalTurns,
      maxTurns,
      createdAt: metadata.createdAt || new Date().toISOString(),
      updatedAt: metadata.updatedAt || new Date().toISOString(),
      lastVerdict,
      costUSD: totalCostUSD,
      latencyMs: totalDurationMs,
      tokens: {
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
      },
      findings: latestFindings,
      findingsDelta: sessionDelta,
      history: turnDeltas,
      turns,
    };
  }

  private loadFallbackSessions(): SessionRecord[] {
    const logs = (this.store || dashboardStore).getReviewLogs();
    const records: SessionRecord[] = [];

    for (const log of logs) {
      let owner = 'default';
      let repo = log.repo || 'repo';
      if (repo.includes('/')) {
        const parts = repo.split('/');
        owner = parts[0];
        repo = parts.slice(1).join('/');
      }

      const prNumber = log.prNumber || 1;
      const verdict = log.verdict || log.arbiterVerdict || 'SHIP';
      const promptTokens = typeof log.tokens === 'object' ? log.tokens.prompt || 0 : 0;
      const completionTokens = typeof log.tokens === 'object' ? log.tokens.completion || 0 : 0;
      const totalTokens = typeof log.tokens === 'number' ? log.tokens : log.tokens?.total || promptTokens + completionTokens;

      records.push({
        id: log.id || `${owner}/${repo}#${prNumber}`,
        owner,
        repo,
        prNumber,
        title: log.title || `PR Review ${owner}/${repo} #${prNumber}`,
        branch: 'main',
        initialHeadSha: log.headSha || '',
        currentHeadSha: log.headSha || '',
        totalTurns: 1,
        maxTurns: 20,
        createdAt: log.timestamp || new Date().toISOString(),
        updatedAt: log.timestamp || new Date().toISOString(),
        lastVerdict: verdict,
        status: log.status || 'completed',
        costUSD: log.costUSD || log.cost || 0,
        latencyMs: log.latencyMs || 0,
        tokens: {
          prompt: promptTokens,
          completion: completionTokens,
          total: totalTokens,
        },
        findings: [],
      });
    }

    return records;
  }

  private matchesFilter(session: SessionRecord, filter: SessionFilterOptions): boolean {
    if (filter.owner && session.owner.toLowerCase() !== filter.owner.toLowerCase()) {
      return false;
    }

    if (filter.repo && session.repo.toLowerCase() !== filter.repo.toLowerCase()) {
      return false;
    }

    if (filter.prNumber !== undefined && filter.prNumber !== null && filter.prNumber !== '') {
      const targetPr = typeof filter.prNumber === 'number' ? filter.prNumber : parseInt(String(filter.prNumber), 10);
      if (session.prNumber !== targetPr) {
        return false;
      }
    }

    if (filter.verdict && session.lastVerdict.toUpperCase() !== filter.verdict.toUpperCase()) {
      return false;
    }

    if (filter.minTurns !== undefined && session.totalTurns < filter.minTurns) {
      return false;
    }

    if (filter.maxTurns !== undefined && session.totalTurns > filter.maxTurns) {
      return false;
    }

    if (filter.query) {
      const q = filter.query.toLowerCase();
      const matchTitle = session.title.toLowerCase().includes(q);
      const matchBranch = session.branch.toLowerCase().includes(q);
      const matchOwner = session.owner.toLowerCase().includes(q);
      const matchRepo = session.repo.toLowerCase().includes(q);
      const matchPr = String(session.prNumber).includes(q);
      if (!matchTitle && !matchBranch && !matchOwner && !matchRepo && !matchPr) {
        return false;
      }
    }

    if (filter.startDate) {
      const start = new Date(filter.startDate).getTime();
      const sTime = new Date(session.createdAt || session.updatedAt).getTime();
      if (!isNaN(start) && sTime < start) {
        return false;
      }
    }

    if (filter.endDate) {
      const end = new Date(filter.endDate).getTime();
      const sTime = new Date(session.createdAt || session.updatedAt).getTime();
      if (!isNaN(end) && sTime > end) {
        return false;
      }
    }

    return true;
  }
}
