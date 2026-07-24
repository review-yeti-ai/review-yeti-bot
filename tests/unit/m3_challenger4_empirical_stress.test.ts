import { describe, it, expect, beforeEach } from 'vitest';
import {
  deduplicateAcrossPersonas,
  formatInlineComments,
  buildPRSummaryMarkdown,
  aggregateQuorumConsensus,
  QuorumConsensusInput,
} from '../../src/quorum/consensus';
import { PersonaFinding } from '../../src/quorum/mefEngine';
import { CtReviewConfig } from '../../src/config/schema';
import { DiffStateManager } from '../../src/persistence/diffStateManager';
import { IDiffStateStorage, PRDiffState, TrackedFinding, FindingStatus, createDiffStateStorage } from '../../src/persistence/db';

class MockMemoryStorage implements IDiffStateStorage {
  private states = new Map<string, PRDiffState>();

  async init(): Promise<void> {}
  private getKey(owner: string, repo: string, prNumber: number): string {
    return `${owner}/${repo}#${prNumber}`;
  }
  async getPRState(owner: string, repo: string, prNumber: number): Promise<PRDiffState | null> {
    const key = this.getKey(owner, repo, prNumber);
    const s = this.states.get(key);
    return s ? JSON.parse(JSON.stringify(s)) : null;
  }
  async savePRState(state: PRDiffState): Promise<void> {
    const key = this.getKey(state.repoOwner, state.repoName, state.prNumber);
    this.states.set(key, JSON.parse(JSON.stringify(state)));
  }
  async getFindings(owner: string, repo: string, prNumber: number): Promise<TrackedFinding[]> {
    const s = await this.getPRState(owner, repo, prNumber);
    return s ? s.findings : [];
  }
  async updateFindingStatus(
    owner: string,
    repo: string,
    prNumber: number,
    fingerprintHash: string,
    status: FindingStatus,
    commitSha: string
  ): Promise<void> {
    const s = await this.getPRState(owner, repo, prNumber);
    if (!s) return;
    const f = s.findings.find((x) => x.fingerprintHash === fingerprintHash);
    if (f) {
      f.status = status;
      f.lastSeenCommit = commitSha;
      f.resolvedAtCommit = status === 'RESOLVED' ? commitSha : null;
      await this.savePRState(s);
    }
  }
  async close(): Promise<void> {}
}

describe('Challenger 4 — Quorum Consensus & Incremental Diff Delta Stress Suite', () => {
  let memoryStorage: IDiffStateStorage;
  let diffStateManager: DiffStateManager;

  const mockConfig: CtReviewConfig = {
    version: '1.0.0',
    quorum: {
      minApprovals: 2,
      personas: ['security', 'architecture', 'performance', 'quality'],
      effortLevel: 'medium',
    },
    ticketEnforcement: {
      required: true,
      providers: ['linear', 'jira', 'github'],
      patterns: ['[A-Z]+-\\d+'],
    },
    constitution: {
      enabled: true,
    },
  };

  beforeEach(() => {
    memoryStorage = new MockMemoryStorage();
    diffStateManager = new DiffStateManager(memoryStorage);
  });

  describe('1. Cross-Persona Finding Deduplication Engine', () => {
    it('returns empty array when given empty findings input', () => {
      expect(deduplicateAcrossPersonas([])).toEqual([]);
    });

    it('preserves single unique finding without modification', () => {
      const finding: PersonaFinding = {
        persona: 'security',
        severity: 'critical',
        filePath: 'src/auth.ts',
        lineNumber: 42,
        comment: 'Hardcoded secret detected',
        ruleId: 'SEC001',
      };
      const result = deduplicateAcrossPersonas([finding]);
      expect(result).toHaveLength(1);
      expect(result[0].persona).toBe('security');
      expect(result[0].severity).toBe('critical');
    });

    it('merges identical findings from different personas and sets coSponsoringPersonas', () => {
      const securityFinding: PersonaFinding = {
        persona: 'security',
        severity: 'critical',
        filePath: 'src/db.ts',
        lineNumber: 10,
        comment: 'SQL Injection vulnerability',
        ruleId: 'DB_SEC',
      };

      const archFinding: PersonaFinding = {
        persona: 'architecture',
        severity: 'major',
        filePath: 'src/db.ts',
        lineNumber: 10,
        comment: 'SQL Injection vulnerability in query construction',
        ruleId: 'DB_SEC',
      };

      const result = deduplicateAcrossPersonas([securityFinding, archFinding]);
      expect(result).toHaveLength(1);
      expect(result[0].persona).toBe('security');
      expect(result[0].severity).toBe('critical');
      expect(result[0].coSponsoringPersonas).toEqual(['architecture']);
    });

    it('prioritizes higher persona precedence when severities are equal', () => {
      const perfFinding: PersonaFinding = {
        persona: 'performance',
        severity: 'major',
        filePath: 'src/data.ts',
        lineNumber: 50,
        comment: 'Inefficient sync operation',
        ruleId: 'SYNC_OP',
      };

      const archFinding: PersonaFinding = {
        persona: 'architecture',
        severity: 'major',
        filePath: 'src/data.ts',
        lineNumber: 50,
        comment: 'Inefficient sync operation blocks event loop',
        ruleId: 'SYNC_OP',
      };

      // Architecture precedence (3) > Performance precedence (2)
      const result = deduplicateAcrossPersonas([perfFinding, archFinding]);
      expect(result).toHaveLength(1);
      expect(result[0].persona).toBe('architecture');
      expect(result[0].coSponsoringPersonas).toEqual(['performance']);
    });

    it('deduplicates findings within 2-line tolerance window', () => {
      const f1: PersonaFinding = {
        persona: 'quality',
        severity: 'minor',
        filePath: 'src/utils.ts',
        lineNumber: 15,
        comment: 'Unused variable `x`',
      };

      const f2: PersonaFinding = {
        persona: 'quality',
        severity: 'minor',
        filePath: 'src/utils.ts',
        lineNumber: 17,
        comment: 'Unused variable `x` in utility function',
      };

      const result = deduplicateAcrossPersonas([f1, f2]);
      expect(result).toHaveLength(1);
      expect(result[0].lineNumber).toBe(15);
    });

    it('collects all co-sponsors when 4 personas flag the same issue', () => {
      const fSec: PersonaFinding = {
        persona: 'security',
        severity: 'critical',
        filePath: 'src/api.ts',
        lineNumber: 100,
        comment: 'Unvalidated input in endpoint',
        ruleId: 'INPUT_VAL',
      };
      const fArch: PersonaFinding = {
        persona: 'architecture',
        severity: 'major',
        filePath: 'src/api.ts',
        lineNumber: 100,
        comment: 'Unvalidated input bypasses controller layer',
        ruleId: 'INPUT_VAL',
      };
      const fPerf: PersonaFinding = {
        persona: 'performance',
        severity: 'minor',
        filePath: 'src/api.ts',
        lineNumber: 101,
        comment: 'Unvalidated input leads to excessive buffer allocations',
        ruleId: 'INPUT_VAL',
      };
      const fQual: PersonaFinding = {
        persona: 'quality',
        severity: 'nit',
        filePath: 'src/api.ts',
        lineNumber: 100,
        comment: 'Missing validation helper',
        ruleId: 'INPUT_VAL',
      };

      const result = deduplicateAcrossPersonas([fSec, fArch, fPerf, fQual]);
      expect(result).toHaveLength(1);
      expect(result[0].persona).toBe('security');
      expect(result[0].coSponsoringPersonas).toEqual(
        expect.arrayContaining(['architecture', 'performance', 'quality'])
      );
      expect(result[0].coSponsoringPersonas).toHaveLength(3);
    });

    it('demonstrates order independence / permutation stability', () => {
      const f1: PersonaFinding = {
        persona: 'security',
        severity: 'major',
        filePath: 'src/core.ts',
        lineNumber: 25,
        comment: 'Potential resource leak',
        ruleId: 'LEAK',
      };
      const f2: PersonaFinding = {
        persona: 'quality',
        severity: 'minor',
        filePath: 'src/core.ts',
        lineNumber: 25,
        comment: 'Resource leak in exception handler',
        ruleId: 'LEAK',
      };

      const res1 = deduplicateAcrossPersonas([f1, f2]);
      const res2 = deduplicateAcrossPersonas([f2, f1]);

      expect(res1[0].persona).toBe(res2[0].persona);
      expect(res1[0].severity).toBe(res2[0].severity);
      expect(res1[0].filePath).toBe(res2[0].filePath);
      expect(res1[0].coSponsoringPersonas).toEqual(res2[0].coSponsoringPersonas);
    });
  });

  describe('2. Consensus Aggregator & Verdict Overrides', () => {
    it('approves when minApprovals met and no findings present', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'org',
        repoName: 'repo',
        prNumber: 10,
        headSha: 'sha1',
        baseSha: 'sha0',
        config: mockConfig,
        prTitle: 'feat: add widget PROJ-123',
        prBody: 'Implements widget feature',
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const result = await aggregateQuorumConsensus(input);
      expect(result.decision).toBe('APPROVE');
      expect(result.stats.activeFindingsCount).toBe(0);
      expect(result.stats.approvingPersonas).toHaveLength(4);
    });

    it('requests changes when a CRITICAL finding is detected regardless of approvals', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'org',
        repoName: 'repo',
        prNumber: 11,
        headSha: 'sha1',
        baseSha: 'sha0',
        config: mockConfig,
        prTitle: 'feat: add endpoint PROJ-124',
        prBody: 'Adds API endpoint',
        personaFindingsMap: {
          security: [
            {
              persona: 'security',
              severity: 'critical',
              filePath: 'src/server.ts',
              lineNumber: 30,
              comment: 'RCE vulnerability in query parser',
            },
          ],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const result = await aggregateQuorumConsensus(input);
      expect(result.decision).toBe('REQUEST_CHANGES');
      expect(result.activeFindings).toHaveLength(1);
      expect(result.activeFindings[0].severity).toBe('critical');
    });

    it('requests changes when a MAJOR finding is detected', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'org',
        repoName: 'repo',
        prNumber: 12,
        headSha: 'sha1',
        baseSha: 'sha0',
        config: mockConfig,
        prTitle: 'feat: update logic PROJ-125',
        prBody: 'Updates business logic',
        personaFindingsMap: {
          architecture: [
            {
              persona: 'architecture',
              severity: 'major',
              filePath: 'src/biz.ts',
              lineNumber: 100,
              comment: 'Violates layered architecture domain boundary',
            },
          ],
          security: [],
          performance: [],
          quality: [],
        },
      };

      const result = await aggregateQuorumConsensus(input);
      expect(result.decision).toBe('REQUEST_CHANGES');
    });

    it('filters nits and does not block approval if no critical/major findings exist', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'org',
        repoName: 'repo',
        prNumber: 13,
        headSha: 'sha1',
        baseSha: 'sha0',
        config: mockConfig,
        prTitle: 'style: format code PROJ-126',
        prBody: 'Code formatting updates',
        personaFindingsMap: {
          quality: [
            {
              persona: 'quality',
              severity: 'nit',
              filePath: 'src/index.ts',
              lineNumber: 5,
              comment: 'Extra trailing whitespace',
            },
          ],
          security: [],
          architecture: [],
          performance: [],
        },
      };

      const result = await aggregateQuorumConsensus(input);
      expect(result.decision).toBe('APPROVE');
      expect(result.activeFindings).toHaveLength(0);
      expect(result.filteredNits).toHaveLength(1);
      expect(result.stats.filteredNitsCount).toBe(1);
    });

    it('requests changes on ticket validation failure in strict mode', async () => {
      const strictConfig: CtReviewConfig = {
        ...mockConfig,
        ticketEnforcement: {
          required: true,
          providers: ['linear'],
          patterns: ['[A-Z]+-\\d+'],
        },
      };

      const input: QuorumConsensusInput = {
        repoOwner: 'org',
        repoName: 'repo',
        prNumber: 14,
        headSha: 'sha1',
        baseSha: 'sha0',
        config: strictConfig,
        prTitle: 'fix something without ticket',
        prBody: 'No ticket mentioned',
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const result = await aggregateQuorumConsensus(input);
      expect(result.decision).toBe('REQUEST_CHANGES');
      expect(result.ticketValidation.valid).toBe(false);
    });

    it('returns COMMENT decision when approving personas fall below minApprovals', async () => {
      const highQuorumConfig: CtReviewConfig = {
        ...mockConfig,
        quorum: {
          minApprovals: 4,
          personas: ['security', 'architecture', 'performance', 'quality'],
          effortLevel: 'high',
        },
      };

      const input: QuorumConsensusInput = {
        repoOwner: 'org',
        repoName: 'repo',
        prNumber: 15,
        headSha: 'sha1',
        baseSha: 'sha0',
        config: highQuorumConfig,
        prTitle: 'refactor: update module PROJ-127',
        prBody: 'Refactoring update',
        personaFindingsMap: {
          security: [],
          architecture: [],
        },
      };

      const result = await aggregateQuorumConsensus(input);
      expect(result.decision).toBe('COMMENT');
      expect(result.stats.approvingPersonas).toHaveLength(2);
    });
  });

  describe('3. Incremental Diff Delta Filtering & Commit Lifecycle Integration', () => {
    it('tracks finding lifecycle across multiple commit updates in diffStateManager', async () => {
      // Commit 1: Initial finding
      const inputCommit1: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'webapp',
        prNumber: 50,
        headSha: 'commit_sha_1',
        baseSha: 'base_sha_0',
        config: mockConfig,
        prTitle: 'feat: new feature PROJ-200',
        prBody: 'Initial PR submission',
        hunks: [
          {
            filePath: 'src/handler.ts',
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 30,
            hunkContent: '@@ -0,0 +1,30 @@\n+function handle(req) { eval(req.body); }',
          },
        ],
        personaFindingsMap: {
          security: [
            {
              persona: 'security',
              severity: 'major',
              filePath: 'src/handler.ts',
              lineNumber: 15,
              comment: 'Use of eval is dangerous',
              ruleId: 'NO_EVAL',
            },
          ],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const res1 = await aggregateQuorumConsensus(inputCommit1, diffStateManager);
      expect(res1.activeFindings).toHaveLength(1);
      expect(res1.resolvedFindings).toHaveLength(0);

      // Commit 2: Developer remediates the issue
      const inputCommit2: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'webapp',
        prNumber: 50,
        headSha: 'commit_sha_2',
        baseSha: 'base_sha_0',
        config: mockConfig,
        prTitle: 'feat: new feature PROJ-200',
        prBody: 'Remediates eval issue',
        hunks: [
          {
            filePath: 'src/handler.ts',
            oldStart: 1,
            oldLines: 30,
            newStart: 1,
            newLines: 30,
            hunkContent: '@@ -1,30 +1,30 @@\n-function handle(req) { eval(req.body); }\n+function handle(req) { JSON.parse(req.body); }',
          },
        ],
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const res2 = await aggregateQuorumConsensus(inputCommit2, diffStateManager);
      expect(res2.activeFindings).toHaveLength(0);
      expect(res2.resolvedFindings).toHaveLength(1);
      expect(res2.resolvedFindings[0].status).toBe('RESOLVED');

      // Commit 3: Non-critical finding re-introduced -> Suppressed
      const inputCommit3: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'webapp',
        prNumber: 50,
        headSha: 'commit_sha_3',
        baseSha: 'base_sha_0',
        config: mockConfig,
        prTitle: 'feat: new feature PROJ-200',
        prBody: 'Re-introduces same non-critical finding',
        hunks: [
          {
            filePath: 'src/handler.ts',
            oldStart: 1,
            oldLines: 30,
            newStart: 1,
            newLines: 30,
            hunkContent: '@@ -1,30 +1,30 @@\n+function handle(req) { eval(req.body); }',
          },
        ],
        personaFindingsMap: {
          security: [
            {
              persona: 'security',
              severity: 'major',
              filePath: 'src/handler.ts',
              lineNumber: 15,
              comment: 'Use of eval is dangerous',
              ruleId: 'NO_EVAL',
            },
          ],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const res3 = await aggregateQuorumConsensus(inputCommit3, diffStateManager);
      expect(res3.suppressedFindingHashes).toHaveLength(1);
    });
  });

  describe('4. Formatting & Inline Comment Recommendations', () => {
    it('formats right-side inline review comments with persona badges and suggestions', () => {
      const findings: PersonaFinding[] = [
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/auth.ts',
          lineNumber: 45,
          comment: 'Hardcoded JWT secret key detected',
          ruleId: 'SEC_JWT',
          suggestion: 'const secret = process.env.JWT_SECRET;',
          coSponsoringPersonas: ['architecture'],
        },
      ];

      const comments = formatInlineComments(findings);
      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/auth.ts');
      expect(comments[0].line).toBe(45);
      expect(comments[0].side).toBe('RIGHT');
      expect(comments[0].body).toContain('🛡️ Security [CRITICAL]');
      expect(comments[0].body).toContain('co-sponsored by `architecture`');
      expect(comments[0].body).toContain('```suggestion\nconst secret = process.env.JWT_SECRET;\n```');
    });

    it('builds summary markdown with governance checks and status table', () => {
      const md = buildPRSummaryMarkdown({
        decision: 'APPROVE',
        ticketResult: { valid: true, ticketsFound: ['PROJ-100'], mode: 'advisory' },
        constitutionResult: { compliant: true, violations: [] },
        minApprovals: 2,
        configuredPersonas: ['security', 'architecture'],
        executedPersonas: ['security', 'architecture'],
        failedPersonas: [],
        approvingPersonas: ['security', 'architecture'],
        requestingChangesPersonas: [],
        activeFindings: [],
        filteredNits: [],
        resolvedFindingsCount: 2,
        tokensUsed: 1500,
      });

      expect(md).toContain('# 🤖 ct-review-bot Quorum Review Summary');
      expect(md).toContain('🟢 **APPROVED**');
      expect(md).toContain('VALID (Found: PROJ-100)');
      expect(md).toContain('COMPLIANT');
      expect(md).toContain('Previously Resolved Items**: 2');
      expect(md).toContain('LLM Tokens Used**: 1,500');
    });
  });

  describe('5. High Volume Empirical Stress Harness', () => {
    it('handles deduplication of 500 findings across multiple personas efficiently', () => {
      const rawFindings: PersonaFinding[] = [];
      const personas: PersonaFinding['persona'][] = ['security', 'architecture', 'performance', 'quality'];
      const severities: PersonaFinding['severity'][] = ['critical', 'major', 'minor', 'nit'];

      // Generate 500 findings with many duplicates across files
      for (let i = 0; i < 500; i++) {
        const fileIdx = i % 20;
        const line = (i % 30) + 1;
        const pIdx = i % 4;
        const sIdx = i % 4;

        rawFindings.push({
          persona: personas[pIdx],
          severity: severities[sIdx],
          filePath: `src/module_${fileIdx}.ts`,
          lineNumber: line,
          comment: `Finding issue ${fileIdx}_${line}_${pIdx}`,
          ruleId: `RULE_${fileIdx}_${line}`,
        });
      }

      const startMs = Date.now();
      const deduplicated = deduplicateAcrossPersonas(rawFindings);
      const elapsedMs = Date.now() - startMs;

      expect(deduplicated.length).toBeLessThan(500);
      expect(elapsedMs).toBeLessThan(100); // Must complete within 100ms
    });
  });
});
