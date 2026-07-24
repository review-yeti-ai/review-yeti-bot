import { describe, it, expect, beforeEach } from 'vitest';
import {
  aggregateQuorumConsensus,
  deduplicateAcrossPersonas,
  formatInlineComments,
  buildPRSummaryMarkdown,
  QuorumConsensusInput,
} from '../../src/quorum/consensus';
import { PersonaFinding } from '../../src/quorum/personas/basePersona';
import { CtReviewConfig } from '../../src/config/schema';

describe('Quorum Review Panel Engine — consensus Unit Tests', () => {
  let testConfig: CtReviewConfig;

  beforeEach(() => {
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

  describe('deduplicateAcrossPersonas', () => {
    it('deduplicates overlapping findings on same file and line with severity escalation and co-sponsors', () => {
      const inputFindings: PersonaFinding[] = [
        {
          persona: 'quality',
          severity: 'minor',
          filePath: 'src/auth.ts',
          lineNumber: 42,
          comment: 'Hardcoded credentials key found',
          suggestion: 'const key = process.env.KEY;',
          ruleId: 'SEC-KEY',
        },
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/auth.ts',
          lineNumber: 43, // Within 2 lines tolerance
          comment: 'Critical hardcoded credentials key detected',
          suggestion: 'const key = process.env.KEY;',
          ruleId: 'SEC-KEY',
        },
      ];

      const deduplicated = deduplicateAcrossPersonas(inputFindings);

      expect(deduplicated).toHaveLength(1);
      expect(deduplicated[0].persona).toBe('security'); // Primary persona (higher severity & precedence)
      expect(deduplicated[0].severity).toBe('critical');
      expect(deduplicated[0].coSponsoringPersonas).toContain('quality');
    });

    it('retains distinct findings on separate files or distant lines', () => {
      const inputFindings: PersonaFinding[] = [
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/auth.ts',
          lineNumber: 10,
          comment: 'Eval risk',
        },
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/auth.ts',
          lineNumber: 100, // Distant line
          comment: 'SQL Injection risk',
        },
        {
          persona: 'perf',
          severity: 'major',
          filePath: 'src/db.ts', // Different file
          lineNumber: 10,
          comment: 'N+1 query loop',
        } as any,
      ];

      const deduplicated = deduplicateAcrossPersonas(inputFindings);
      expect(deduplicated).toHaveLength(3);
    });
  });

  describe('formatInlineComments', () => {
    it('formats GitHub inline comments with suggestion code blocks', () => {
      const findings: PersonaFinding[] = [
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/auth.ts',
          lineNumber: 15,
          comment: 'Avoid direct eval execution',
          suggestion: 'JSON.parse(input)',
          ruleId: 'SEC-NO-EVAL',
          coSponsoringPersonas: ['quality'],
        },
      ];

      const comments = formatInlineComments(findings);

      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/auth.ts');
      expect(comments[0].line).toBe(15);
      expect(comments[0].side).toBe('RIGHT');
      expect(comments[0].body).toContain('🛡️ Security');
      expect(comments[0].body).toContain('co-sponsored by `quality`');
      expect(comments[0].body).toContain('```suggestion\nJSON.parse(input)\n```');
    });
  });

  describe('buildPRSummaryMarkdown', () => {
    it('generates multi-section Markdown report with verdict badges and governance section', () => {
      const markdown = buildPRSummaryMarkdown({
        decision: 'REQUEST_CHANGES',
        ticketResult: { valid: true, ticketsFound: ['PROJ-123'], mode: 'strict' },
        constitutionResult: { compliant: true, violations: [] },
        minApprovals: 2,
        configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
        executedPersonas: ['security', 'architecture', 'performance', 'quality'],
        failedPersonas: [],
        approvingPersonas: ['architecture', 'performance', 'quality'],
        requestingChangesPersonas: ['security'],
        activeFindings: [
          {
            persona: 'security',
            severity: 'critical',
            filePath: 'src/auth.ts',
            lineNumber: 15,
            comment: 'Avoid direct eval execution',
            suggestion: 'JSON.parse(input)',
            ruleId: 'SEC-NO-EVAL',
          },
        ],
        filteredNits: [],
        resolvedFindingsCount: 0,
        tokensUsed: 1250,
      });

      expect(markdown).toContain('# 🤖 ct-review-bot Quorum Review Summary');
      expect(markdown).toContain('🔴 **CHANGES REQUESTED**');
      expect(markdown).toContain('PROJ-123');
      expect(markdown).toContain('COMPLIANT');
      expect(markdown).toContain('SEC-NO-EVAL');
      expect(markdown).toContain('1,250');
    });
  });

  describe('aggregateQuorumConsensus Entry Point', () => {
    it('returns APPROVE when all personas pass and governance checks pass', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'acme-inc',
        repoName: 'web-app',
        prNumber: 10,
        headSha: 'headsha123',
        baseSha: 'basesha123',
        config: testConfig,
        prTitle: 'feat: add login page [PROJ-999]',
        prBody: 'Implements login page. Testing steps: 1. npm test.',
        personaFindingsMap: {
          security: [],
          architecture: [],
          performance: [],
          quality: [],
        },
      };

      const result = await aggregateQuorumConsensus(input);

      expect(result.decision).toBe('APPROVE');
      expect(result.ticketValidation.valid).toBe(true);
      expect(result.constitutionCompliance.compliant).toBe(true);
      expect(result.activeFindings).toHaveLength(0);
    });

    it('returns REQUEST_CHANGES when a critical finding exists', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'acme-inc',
        repoName: 'web-app',
        prNumber: 11,
        headSha: 'headsha123',
        baseSha: 'basesha123',
        config: testConfig,
        prTitle: 'feat: update auth logic [PROJ-888]',
        prBody: 'Updates auth logic. Testing steps: run tests.',
        personaFindingsMap: {
          security: [
            {
              persona: 'security',
              severity: 'critical',
              filePath: 'src/auth.ts',
              lineNumber: 20,
              comment: 'OWASP Top 10 Injection Risk',
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
    });

    it('returns REQUEST_CHANGES when strict ticket enforcement fails', async () => {
      const input: QuorumConsensusInput = {
        repoOwner: 'acme-inc',
        repoName: 'web-app',
        prNumber: 12,
        headSha: 'headsha123',
        baseSha: 'basesha123',
        config: testConfig,
        prTitle: 'feat: missing ticket linkage in title',
        prBody: 'No ticket mentioned.',
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
      expect(result.ticketValidation.mode).toBe('strict');
    });

    it('returns COMMENT when approving personas fall below minApprovals requirement without blocking findings', async () => {
      testConfig.quorum.minApprovals = 3;
      const input: QuorumConsensusInput = {
        repoOwner: 'acme-inc',
        repoName: 'web-app',
        prNumber: 13,
        headSha: 'headsha123',
        baseSha: 'basesha123',
        config: testConfig,
        prTitle: 'feat: partial review run [PROJ-777]',
        prBody: 'Testing steps: run tests.',
        personaFindingsMap: {
          security: [],
          quality: [],
        },
      };

      const result = await aggregateQuorumConsensus(input);

      expect(result.decision).toBe('COMMENT');
      expect(result.stats.personasExecuted).toHaveLength(2);
    });
  });
});
