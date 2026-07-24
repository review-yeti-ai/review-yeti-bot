import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  aggregateQuorumConsensus,
  deduplicateAcrossPersonas,
  formatInlineComments,
  buildPRSummaryMarkdown,
  QuorumConsensusInput,
} from '../../src/quorum/consensus';
import { PersonaFinding } from '../../src/quorum/personas/basePersona';
import { CtReviewConfig } from '../../src/config/schema';
import { createDiffStateStorage, IDiffStateStorage } from '../../src/persistence/db';
import { DiffStateManager } from '../../src/persistence/diffStateManager';
import { computeFindingHash } from '../../src/utils/diffHash';

describe('Challenger 2 — Milestone 3 Quorum Engine Empirical Stress Harness', () => {
  let testConfig: CtReviewConfig;
  let storage: IDiffStateStorage;
  let diffStateMgr: DiffStateManager;
  let tmpJsonPath: string;

  beforeEach(async () => {
    tmpJsonPath = path.join(
      os.tmpdir(),
      `test_pr_states_${Date.now()}_${Math.random().toString(36).substring(2)}.json`
    );
    storage = await createDiffStateStorage(':memory:', tmpJsonPath);
    diffStateMgr = new DiffStateManager(storage);

    testConfig = {
      version: '1.0',
      quorum: {
        minApprovals: 2,
        personas: ['security', 'architecture', 'performance', 'quality'],
        effortLevel: 'medium',
      },
      ticketEnforcement: {
        required: true,
        providers: ['linear', 'jira', 'github'],
        patterns: [],
      },
      constitution: {
        enabled: true,
        path: '.github/constitution.md',
      },
    };
  });

  afterEach(async () => {
    await storage.close();
    if (fs.existsSync(tmpJsonPath)) {
      try {
        fs.unlinkSync(tmpJsonPath);
      } catch {}
    }
  });

  // =========================================================================
  // 1. Cross-Persona Finding Deduplication & Overlap Matrix
  // =========================================================================
  describe('1. Cross-Persona Finding Deduplication & Overlap Matrix', () => {
    it('deduplicates a 4-persona overlap on identical file & line (+/- 2 lines window) with severity escalation & co-sponsorship', () => {
      const inputFindings: PersonaFinding[] = [
        {
          persona: 'quality',
          severity: 'nit',
          filePath: 'src/controllers/auth.ts',
          lineNumber: 50,
          comment: 'Minor formatting issue in query handler',
          suggestion: 'const q = query.trim();',
          ruleId: 'QUAL-FMT',
        },
        {
          persona: 'performance',
          severity: 'minor',
          filePath: 'src/controllers/auth.ts',
          lineNumber: 51,
          comment: 'Sync database call in async request handler',
          suggestion: 'await db.queryAsync(q);',
          ruleId: 'PERF-SYNC-DB',
        },
        {
          persona: 'architecture',
          severity: 'major',
          filePath: 'src/controllers/auth.ts',
          lineNumber: 49,
          comment: 'Direct database access violating repository layer boundary',
          suggestion: 'return this.authRepo.find(q);',
          ruleId: 'ARCH-LAYER-VIOLATION',
        },
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/controllers/auth.ts',
          lineNumber: 50,
          comment: 'SQL Injection vulnerability via unsanitized raw string query concatenation',
          suggestion: 'return db.query("SELECT * FROM users WHERE id = ?", [id]);',
          ruleId: 'SEC-SQLI',
          codeSnippet: 'db.query("SELECT * FROM users WHERE id = " + id);',
        },
      ];

      const result = deduplicateAcrossPersonas(inputFindings);

      expect(result).toHaveLength(1);
      const merged = result[0];
      expect(merged.persona).toBe('security');
      expect(merged.severity).toBe('critical');
      expect(merged.filePath).toBe('src/controllers/auth.ts');
      expect(merged.ruleId).toBe('SEC-SQLI');
      expect(merged.coSponsoringPersonas).toBeDefined();
      expect(merged.coSponsoringPersonas).toContain('quality');
      expect(merged.coSponsoringPersonas).toContain('performance');
      expect(merged.coSponsoringPersonas).toContain('architecture');
      expect(merged.coSponsoringPersonas).not.toContain('security');
    });

    it('applies persona precedence tie-breaking when severities are equal (security > architecture > performance > quality)', () => {
      // Quality vs Architecture with equal severity 'major'
      const findings1: PersonaFinding[] = [
        {
          persona: 'quality',
          severity: 'major',
          filePath: 'src/service.ts',
          lineNumber: 20,
          comment: 'Complex method needing refactoring',
        },
        {
          persona: 'architecture',
          severity: 'major',
          filePath: 'src/service.ts',
          lineNumber: 21,
          comment: 'Tightly coupled module design',
        },
      ];

      const res1 = deduplicateAcrossPersonas(findings1);
      expect(res1).toHaveLength(1);
      expect(res1[0].persona).toBe('architecture'); // arch (score 3) > quality (score 1)
      expect(res1[0].coSponsoringPersonas).toEqual(['quality']);

      // Architecture vs Security with equal severity 'major'
      const findings2: PersonaFinding[] = [
        {
          persona: 'architecture',
          severity: 'major',
          filePath: 'src/service.ts',
          lineNumber: 20,
          comment: 'Tightly coupled module design',
        },
        {
          persona: 'security',
          severity: 'major',
          filePath: 'src/service.ts',
          lineNumber: 20,
          comment: 'Insecure direct object reference risk',
        },
      ];

      const res2 = deduplicateAcrossPersonas(findings2);
      expect(res2).toHaveLength(1);
      expect(res2[0].persona).toBe('security'); // security (score 4) > arch (score 3)
      expect(res2[0].coSponsoringPersonas).toEqual(['architecture']);
    });

    it('enforces exact line distance threshold (+/- 2 lines)', () => {
      const findings: PersonaFinding[] = [
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/token.ts',
          lineNumber: 10,
          comment: 'Hardcoded JWT secret key',
        },
        {
          persona: 'quality',
          severity: 'minor',
          filePath: 'src/token.ts',
          lineNumber: 12, // Exactly 2 lines apart -> overlaps!
          comment: 'Hardcoded secret variable name style',
        },
        {
          persona: 'performance',
          severity: 'minor',
          filePath: 'src/token.ts',
          lineNumber: 13, // 3 lines apart -> DOES NOT overlap!
          comment: 'Slow secret hash computation',
        },
      ];

      const deduplicated = deduplicateAcrossPersonas(findings);
      expect(deduplicated).toHaveLength(2);

      // First merged item (lines 10 & 12)
      expect(deduplicated[0].persona).toBe('security');
      expect(deduplicated[0].coSponsoringPersonas).toContain('quality');

      // Second separate item (line 13)
      expect(deduplicated[1].persona).toBe('performance');
      expect(deduplicated[1].lineNumber).toBe(13);
    });

    it('deduplicates across distant lines when ruleId or codeSnippet match', () => {
      const findings: PersonaFinding[] = [
        {
          persona: 'security',
          severity: 'major',
          filePath: 'src/db/client.ts',
          lineNumber: 15,
          ruleId: 'RULE-DB-UNENCRYPTED',
          comment: 'Unencrypted DB connection string detected',
          codeSnippet: 'connect("postgres://admin:pass@localhost/db")',
        },
        {
          persona: 'architecture',
          severity: 'critical',
          filePath: 'src/db/client.ts',
          lineNumber: 185, // Distant line!
          ruleId: 'RULE-DB-UNENCRYPTED', // Same ruleId -> triggers deduplication!
          comment: 'Unencrypted database endpoint in remote config',
          codeSnippet: 'connect("postgres://admin:pass@localhost/db")',
        },
      ];

      const res = deduplicateAcrossPersonas(findings);
      expect(res).toHaveLength(1);
      expect(res[0].persona).toBe('architecture');
      expect(res[0].severity).toBe('critical');
    });

    it('keeps findings on separate files completely distinct', () => {
      const findings: PersonaFinding[] = [
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/a.ts',
          lineNumber: 10,
          comment: 'Same vulnerability text',
          ruleId: 'SAME-RULE',
        },
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/b.ts', // Different file!
          lineNumber: 10,
          comment: 'Same vulnerability text',
          ruleId: 'SAME-RULE',
        },
      ];

      const res = deduplicateAcrossPersonas(findings);
      expect(res).toHaveLength(2);
    });
  });

  // =========================================================================
  // 2. Decision Logic Voting Matrix & Governance Overrides
  // =========================================================================
  describe('2. Decision Logic Voting Matrix & Governance Overrides', () => {
    it('returns APPROVE when approving personas >= minApprovals and governance checks pass', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'api',
        prNumber: 1,
        headSha: 'head1',
        baseSha: 'base1',
        config: testConfig,
        prTitle: 'feat: add user profile endpoint [PROJ-101]',
        prBody: 'Adds profile endpoint. Testing steps: npm test',
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const res = await aggregateQuorumConsensus(input);
      expect(res.decision).toBe('APPROVE');
      expect(res.stats.approvingPersonas).toHaveLength(4);
      expect(res.stats.requestingChangesPersonas).toHaveLength(0);
    });

    it('returns COMMENT when approving personas < minApprovals without blocking findings', async () => {
      const inputConfig: CtReviewConfig = {
        ...testConfig,
        quorum: {
          ...testConfig.quorum,
          minApprovals: 3,
        },
      };

      const input: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'api',
        prNumber: 2,
        headSha: 'head1',
        baseSha: 'base1',
        config: inputConfig,
        prTitle: 'feat: quick patch [PROJ-102]',
        prBody: 'Testing steps: run test suite',
        personaFindingsMap: {
          security: [],
          quality: [],
          // Only 2 personas executed out of 4 configured -> minApprovals=3 not met!
        },
      };

      const res = await aggregateQuorumConsensus(input);
      expect(res.decision).toBe('COMMENT');
      expect(res.stats.approvingPersonas).toHaveLength(2);
    });

    it('returns REQUEST_CHANGES when any persona flags a CRITICAL or MAJOR finding', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'api',
        prNumber: 3,
        headSha: 'head1',
        baseSha: 'base1',
        config: testConfig,
        prTitle: 'feat: payment integration [PROJ-103]',
        prBody: 'Testing steps: manual check',
        personaFindingsMap: {
          security: [
            {
              persona: 'security',
              severity: 'major',
              filePath: 'src/pay.ts',
              lineNumber: 15,
              comment: 'Missing TLS certificate verification',
            },
          ],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const res = await aggregateQuorumConsensus(input);
      expect(res.decision).toBe('REQUEST_CHANGES');
      expect(res.activeFindings).toHaveLength(1);
    });

    it('returns APPROVE when only MINOR or NIT findings exist and minApprovals is met', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'api',
        prNumber: 4,
        headSha: 'head1',
        baseSha: 'base1',
        config: testConfig,
        prTitle: 'style: cleanup imports [PROJ-104]',
        prBody: 'Testing steps: build passes',
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [
            {
              persona: 'quality',
              severity: 'minor',
              filePath: 'src/utils.ts',
              lineNumber: 5,
              comment: 'Consider renaming variable x to count for clarity',
            },
            {
              persona: 'quality',
              severity: 'nit',
              filePath: 'src/utils.ts',
              lineNumber: 12,
              comment: 'Trailing whitespace on empty line',
            },
          ],
        },
      };

      const res = await aggregateQuorumConsensus(input);
      expect(res.decision).toBe('APPROVE');
      expect(res.activeFindings).toHaveLength(1); // Minor finding is active
      expect(res.filteredNits).toHaveLength(1); // Nit is filtered
    });

    it('returns REQUEST_CHANGES when strict ticket enforcement fails', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'api',
        prNumber: 5,
        headSha: 'head1',
        baseSha: 'base1',
        config: testConfig,
        prTitle: 'feat: update dependencies without ticket key',
        prBody: 'Testing steps: npm test',
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const res = await aggregateQuorumConsensus(input);
      expect(res.decision).toBe('REQUEST_CHANGES');
      expect(res.ticketValidation.valid).toBe(false);
      expect(res.ticketValidation.mode).toBe('strict');
    });

    it('returns APPROVE when ticket enforcement is advisory even if no ticket is linked', async () => {
      const advisoryConfig: CtReviewConfig = {
        ...testConfig,
        ticketEnforcement: {
          required: false,
          providers: ['github'],
        },
      };

      const input: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'api',
        prNumber: 6,
        headSha: 'head1',
        baseSha: 'base1',
        config: advisoryConfig,
        prTitle: 'docs: update README',
        prBody: 'No ticket linked',
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const res = await aggregateQuorumConsensus(input);
      expect(res.decision).toBe('APPROVE');
      expect(res.ticketValidation.valid).toBe(true);
      expect(res.ticketValidation.mode).toBe('advisory');
    });

    it('returns REQUEST_CHANGES when constitution evaluation fails and is not bypassed', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'api',
        prNumber: 7,
        headSha: 'head1',
        baseSha: 'base1',
        config: testConfig,
        prTitle: 'feat: add feature [PROJ-107]',
        prBody: 'Testing steps: test ok',
        constitutionResult: {
          compliant: false,
          bypassed: false,
          violations: ['Forbidden pattern eval() detected in src/eval.ts'],
        },
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const res = await aggregateQuorumConsensus(input);
      expect(res.decision).toBe('REQUEST_CHANGES');
      expect(res.constitutionCompliance.compliant).toBe(false);
    });

    it('returns APPROVE when constitution evaluation fails BUT is explicitly bypassed', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'acme',
        repoName: 'api',
        prNumber: 8,
        headSha: 'head1',
        baseSha: 'base1',
        config: testConfig,
        prTitle: 'feat: legacy hotfix [PROJ-108]',
        prBody: 'Testing steps: tested manually',
        constitutionResult: {
          compliant: false,
          bypassed: true,
          violations: ['Legacy eval usage exception granted'],
        },
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const res = await aggregateQuorumConsensus(input);
      expect(res.decision).toBe('APPROVE');
      expect(res.constitutionCompliance.bypassed).toBe(true);
    });
  });

  // =========================================================================
  // 3. Incremental Diff Delta Filtering & SHA-256 Fingerprint Hashing
  // =========================================================================
  describe('3. Incremental Diff Delta Filtering & SHA-256 Fingerprint Hashing', () => {
    it('computes identical line-shift resilient SHA-256 fingerprint hash when code snippet & rule/comment match across line shifts', () => {
      const findingAtLine10 = {
        filePath: 'src/auth/jwt.ts',
        persona: 'security',
        severity: 'critical' as const,
        codeSnippet: 'eval(token);',
        comment: 'Insecure eval execution',
        ruleId: 'SEC-NO-EVAL',
        startLine: 10,
      };

      const findingAtLine95 = {
        filePath: 'src/auth/jwt.ts',
        persona: 'security',
        severity: 'critical' as const,
        codeSnippet: 'eval(token);',
        comment: 'Insecure eval execution',
        ruleId: 'SEC-NO-EVAL',
        startLine: 95, // Line shifted by 85 lines!
      };

      const hash1 = computeFindingHash(findingAtLine10);
      const hash2 = computeFindingHash(findingAtLine95);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // Valid SHA-256 hex string
    });

    it('handles multi-commit lifecycle: Commit 1 (flagged) -> Commit 2 (remediated) -> Commit 3 (re-introduced non-critical) -> SUPPRESSED', async () => {
      const repoOwner = 'acme-inc';
      const repoName = 'auth-service';
      const prNumber = 701;

      // --- COMMIT 1: Flagged finding ---
      const hunk1 = [
        {
          filePath: 'src/util.ts',
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 10,
          hunkContent: '@@ -0,0 +1,10 @@\n+const x = 1;\n+console.log(x);',
        },
      ];
      const finding1: PersonaFinding = {
        persona: 'quality',
        severity: 'minor',
        filePath: 'src/util.ts',
        lineNumber: 2,
        comment: 'Avoid console.log statement in production code',
        codeSnippet: 'console.log(x);',
        ruleId: 'QUAL-NO-CONSOLE',
      };

      const res1 = await aggregateQuorumConsensus(
        {
          repoOwner,
          repoName,
          prNumber,
          headSha: 'commit1sha',
          baseSha: 'basesha',
          config: testConfig,
          prTitle: 'feat: add util [PROJ-701]',
          prBody: 'Testing steps: test ok',
          hunks: hunk1,
          personaFindingsMap: {
            security: [],
            architecture: [],
            performance: [],
            quality: [finding1],
          },
        },
        diffStateMgr
      );

      expect(res1.activeFindings).toHaveLength(1);

      // --- COMMIT 2: Remediated (console.log removed in modified hunk) ---
      const hunk2 = [
        {
          filePath: 'src/util.ts',
          oldStart: 1,
          oldLines: 10,
          newStart: 1,
          newLines: 10,
          hunkContent: '@@ -1,10 +1,10 @@\n+const x = 1;\n+// console.log removed',
        },
      ];

      const res2 = await aggregateQuorumConsensus(
        {
          repoOwner,
          repoName,
          prNumber,
          headSha: 'commit2sha',
          baseSha: 'basesha',
          config: testConfig,
          prTitle: 'feat: add util [PROJ-701]',
          prBody: 'Testing steps: test ok',
          hunks: hunk2,
          personaFindingsMap: {
            security: [],
            architecture: [],
            performance: [],
            quality: [],
          },
        },
        diffStateMgr
      );

      expect(res2.activeFindings).toHaveLength(0);
      expect(res2.resolvedFindings).toHaveLength(1);
      expect(res2.resolvedFindings[0].status).toBe('RESOLVED');

      // --- COMMIT 3: Re-introduced identical non-critical finding ---
      const res3 = await aggregateQuorumConsensus(
        {
          repoOwner,
          repoName,
          prNumber,
          headSha: 'commit3sha',
          baseSha: 'basesha',
          config: testConfig,
          prTitle: 'feat: add util [PROJ-701]',
          prBody: 'Testing steps: test ok',
          hunks: hunk2,
          personaFindingsMap: {
            security: [],
            architecture: [],
            performance: [],
            quality: [finding1], // Same minor finding re-introduced
          },
        },
        diffStateMgr
      );

      expect(res3.suppressedFindingHashes.length).toBeGreaterThanOrEqual(1);
    });

    it('handles multi-commit lifecycle: Commit 1 (flagged) -> Commit 2 (remediated) -> Commit 3 (re-introduced CRITICAL) -> Re-opened to IDENTIFIED', async () => {
      const repoOwner = 'acme-inc';
      const repoName = 'auth-service';
      const prNumber = 702;

      const hunk = [
        {
          filePath: 'src/auth.ts',
          oldStart: 1,
          oldLines: 5,
          newStart: 1,
          newLines: 5,
          hunkContent: '@@ -1,5 +1,5 @@\n+eval(input);',
        },
      ];

      const criticalFinding: PersonaFinding = {
        persona: 'security',
        severity: 'critical',
        filePath: 'src/auth.ts',
        lineNumber: 2,
        comment: 'Dangerous eval call',
        codeSnippet: 'eval(input);',
        ruleId: 'SEC-EVAL',
      };

      // Commit 1: Flagged
      await aggregateQuorumConsensus(
        {
          repoOwner,
          repoName,
          prNumber,
          headSha: 'c1',
          baseSha: 'base',
          config: testConfig,
          prTitle: 'fix: auth [PROJ-702]',
          prBody: 'Testing steps: test ok',
          hunks: hunk,
          personaFindingsMap: {
            security: [criticalFinding],
            architecture: [],
            performance: [],
            quality: [],
          },
        },
        diffStateMgr
      );

      // Commit 2: Clean (Remediated)
      await aggregateQuorumConsensus(
        {
          repoOwner,
          repoName,
          prNumber,
          headSha: 'c2',
          baseSha: 'base',
          config: testConfig,
          prTitle: 'fix: auth [PROJ-702]',
          prBody: 'Testing steps: test ok',
          hunks: hunk,
          personaFindingsMap: {
            security: [],
            architecture: [],
            performance: [],
            quality: [],
          },
        },
        diffStateMgr
      );

      // Commit 3: Re-introduced CRITICAL finding -> should re-open (IDENTIFIED)
      const res3 = await aggregateQuorumConsensus(
        {
          repoOwner,
          repoName,
          prNumber,
          headSha: 'c3',
          baseSha: 'base',
          config: testConfig,
          prTitle: 'fix: auth [PROJ-702]',
          prBody: 'Testing steps: test ok',
          hunks: hunk,
          personaFindingsMap: {
            security: [criticalFinding],
            architecture: [],
            performance: [],
            quality: [],
          },
        },
        diffStateMgr
      );

      expect(res3.activeFindings).toHaveLength(1);
      expect(res3.activeFindings[0].severity).toBe('critical');
      expect(res3.suppressedFindingHashes).toHaveLength(0); // Critical not suppressed!
    });
  });

  // =========================================================================
  // 4. Ticket Linkage & Constitution Compliance Integration in Summary Markdown
  // =========================================================================
  describe('4. Ticket Linkage & Constitution Compliance Integration in Summary Markdown', () => {
    it('formats comprehensive Markdown summary for a failing review with all details', () => {
      const markdown = buildPRSummaryMarkdown({
        decision: 'REQUEST_CHANGES',
        ticketResult: {
          valid: false,
          ticketsFound: [],
          mode: 'strict',
          error: 'No linear or jira tickets found in PR title or body',
        },
        constitutionResult: {
          compliant: false,
          bypassed: false,
          violations: [
            'Prohibited pattern detected: eval(raw) in src/auth.ts:15',
            'Missing mandatory testing steps section in PR description',
          ],
        },
        minApprovals: 2,
        configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
        executedPersonas: ['security', 'architecture', 'performance', 'quality'],
        failedPersonas: [],
        approvingPersonas: ['performance', 'quality'],
        requestingChangesPersonas: ['security', 'architecture'],
        activeFindings: [
          {
            persona: 'security',
            severity: 'critical',
            filePath: 'src/auth.ts',
            lineNumber: 15,
            comment: 'Direct eval call detected',
            suggestion: 'JSON.parse(raw)',
            ruleId: 'SEC-NO-EVAL',
            coSponsoringPersonas: ['architecture'],
          },
        ],
        filteredNits: [
          {
            persona: 'quality',
            severity: 'nit',
            filePath: 'src/auth.ts',
            lineNumber: 2,
            comment: 'Extra blank line',
          },
        ],
        resolvedFindingsCount: 1,
        tokensUsed: 4200,
      });

      expect(markdown).toContain('# 🤖 ct-review-bot Quorum Review Summary');
      expect(markdown).toContain('🔴 **CHANGES REQUESTED**');
      expect(markdown).toContain('Governance & Policy Checks');
      expect(markdown).toContain('INVALID (No linear or jira tickets found in PR title or body)');
      expect(markdown).toContain('NON-COMPLIANT');
      expect(markdown).toContain('🚨 Prohibited pattern detected: eval(raw) in src/auth.ts:15');
      expect(markdown).toContain('🚨 Missing mandatory testing steps section in PR description');
      expect(markdown).toContain('Key Active Findings (1)');
      expect(markdown).toContain('SEC-NO-EVAL');
      expect(markdown).toContain('co-sponsored by architecture');
      expect(markdown).toContain('Suppressed Nits & Minor Style Notes (1)');
      expect(markdown).toContain('Previously Resolved Items**: 1');
      expect(markdown).toContain('LLM Tokens Used**: 4,200');
    });

    it('formats inline review comments with suggestion blocks and co-sponsor tags', () => {
      const findings: PersonaFinding[] = [
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/jwt.ts',
          lineNumber: 42,
          comment: 'Hardcoded secret token string',
          suggestion: 'const token = process.env.SECRET_TOKEN;',
          ruleId: 'SEC-HARDCODED-SECRET',
          coSponsoringPersonas: ['quality', 'architecture'],
        },
      ];

      const comments = formatInlineComments(findings);

      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/jwt.ts');
      expect(comments[0].line).toBe(42);
      expect(comments[0].side).toBe('RIGHT');
      expect(comments[0].body).toContain('🛡️ Security [CRITICAL]');
      expect(comments[0].body).toContain('co-sponsored by `quality`, `architecture`');
      expect(comments[0].body).toContain('```suggestion\nconst token = process.env.SECRET_TOKEN;\n```');
      expect(comments[0].body).toContain('Flagged by ct-review-bot Quorum Engine');
    });
  });
});
