import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CommunityPersonaLoader,
  CommunityPersonaValidationError,
  CommunityPersonaNotFoundError,
  CommunityPersonaFetchError,
  parsePersonaCharter,
  sanitizePersonaId,
} from '../../src/personas/communityPersonaLoader';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { NitSuppressionEngine, Finding } from '../../src/reflection/nitSuppressionEngine';

describe('Adversarial Empirical Verification — Milestone 5: Community Persona Store & Team Memory', () => {
  const scratchDir = path.resolve(__dirname, '../fixtures/adversarial_m5_scratch');
  const cacheDir = path.join(scratchDir, '.ct-memory/cache/personas');
  const localPersonasDir = path.join(scratchDir, 'local-personas');
  const bundledDir = path.join(scratchDir, 'domains/personas');

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(localPersonasDir, { recursive: true });
    fs.mkdirSync(bundledDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. PERSONA LOADER: PRECEDENCE, YAML, CHARTER, TRAVERSAL, NETWORK
  // =========================================================================
  describe('1. Persona Loader Adversarial Suite', () => {
    describe('1.1 Precedence Hierarchy (Bundled > Local > Remote)', () => {
      it('selects bundled persona over remote reference when bundled persona exists', async () => {
        fs.writeFileSync(
          path.join(bundledDir, 'django-security.md'),
          `---
name: bundled-django-security
role: Bundled Guardian
---
# Bundled Django Security Charter
This is the official bundled version.`,
          'utf-8'
        );

        const mockRemoteFetch = vi.fn().mockResolvedValue(`---
name: remote-django-security
role: Remote Imposter
---
# Remote Charter Body
This should NOT be fetched because bundled has precedence.`);

        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
          bundledDir,
          cacheDir,
          fetcher: mockRemoteFetch,
        });

        const resolved = await loader.resolvePersonaReference('review-yeti/personas/django-security@v1');
        expect(resolved.sourceType).toBe('bundled');
        expect(resolved.frontmatter.name).toBe('bundled-django-security');
        expect(resolved.charter).toContain('This is the official bundled version');
        expect(mockRemoteFetch).not.toHaveBeenCalled();
      });

      it('selects local relative persona over remote fallback when specified via ./ or ../', async () => {
        const localFile = path.join(localPersonasDir, 'custom-policy.md');
        fs.writeFileSync(
          localFile,
          `---
name: local-custom-policy
---
# Local Custom Policy Charter
Enforce local repository constraints.`,
          'utf-8'
        );

        const mockRemoteFetch = vi.fn();
        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
          bundledDir,
          cacheDir,
          fetcher: mockRemoteFetch,
        });

        const resolved = await loader.resolvePersonaReference('./local-personas/custom-policy.md');
        expect(resolved.sourceType).toBe('local');
        expect(resolved.frontmatter.name).toBe('local-custom-policy');
        expect(mockRemoteFetch).not.toHaveBeenCalled();
      });

      it('throws CommunityPersonaNotFoundError if persona is missing across all tiers', async () => {
        const mockRemoteFetch = vi.fn().mockRejectedValue(new Error('HTTP 404 Not Found'));
        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
          bundledDir,
          cacheDir,
          fetcher: mockRemoteFetch,
        });

        await expect(loader.resolvePersonaReference('nonexistent/persona/missing@v1')).rejects.toThrow(
          CommunityPersonaFetchError
        );
        await expect(loader.resolvePersonaReference('./local-personas/ghost.md')).rejects.toThrow(
          CommunityPersonaNotFoundError
        );
        await expect(loader.resolvePersonaReference('ghost-unqualified')).rejects.toThrow(
          CommunityPersonaNotFoundError
        );
      });
    });

    describe('1.2 Invalid YAML Frontmatter Robustness', () => {
      it('rejects frontmatter that is a YAML array instead of a mapping object', () => {
        const invalid = `---
- item1
- item2
- item3
---
# Charter Body
Some valid body text here that is long enough.`;

        expect(() => parsePersonaCharter(invalid)).toThrow(CommunityPersonaValidationError);
        expect(() => parsePersonaCharter(invalid)).toThrow(/YAML mapping\/object/i);
      });

      it('rejects frontmatter that is a YAML scalar (string/number/null)', () => {
        const scalarString = `---
"just a plain scalar string"
---
# Charter Body
Valid body text here that is long enough.`;

        expect(() => parsePersonaCharter(scalarString)).toThrow(CommunityPersonaValidationError);

        const scalarNull = `---
---
# Charter Body
Valid body text here that is long enough.`;

        expect(() => parsePersonaCharter(scalarNull)).toThrow(CommunityPersonaValidationError);
      });

      it('rejects YAML with syntax errors (unclosed brackets, invalid indentation)', () => {
        const malformed = `---
name: [unclosed list
invalid: :::: syntax
---
# Charter Body
Valid body text here that is long enough.`;

        expect(() => parsePersonaCharter(malformed)).toThrow(CommunityPersonaValidationError);
        expect(() => parsePersonaCharter(malformed)).toThrow(/Failed to parse YAML frontmatter/i);
      });

      it('rejects content without opening or closing delimiter', () => {
        const noOpen = `name: missing-open
---
# Charter Body
Valid body text here that is long enough.`;
        expect(() => parsePersonaCharter(noOpen)).toThrow(CommunityPersonaValidationError);

        const noClose = `---
name: missing-close
# Charter Body
Valid body text here that is long enough.`;
        expect(() => parsePersonaCharter(noClose)).toThrow(CommunityPersonaValidationError);
      });

      it('safely handles frontmatter with unicode and special characters without crash', () => {
        const unicodeYaml = `---
name: "special-persona-🔥"
role: "Security & Observability (監査)"
description: "Handles \\"escaped\\" quotes and special chars: <>[]{}|!@#"
tags: ["c++", "c#", "node.js"]
---
# Special Persona Charter
Valid body text that tests unicode resilience.`;

        const { frontmatter, charter } = parsePersonaCharter(unicodeYaml);
        expect(frontmatter.name).toBe('special-persona-🔥');
        expect(frontmatter.role).toBe('Security & Observability (監査)');
        expect(frontmatter.tags).toContain('c++');
        expect(charter).toContain('# Special Persona Charter');
      });
    });

    describe('1.3 Empty & Boundary Charter Bodies', () => {
      it('rejects empty charter body', () => {
        const empty = `---
name: valid-name
---
`;
        expect(() => parsePersonaCharter(empty)).toThrow(CommunityPersonaValidationError);
        expect(() => parsePersonaCharter(empty)).toThrow(/cannot be empty/i);
      });

      it('rejects whitespace-only charter body', () => {
        const whitespace = `---
name: valid-name
---
   \n\t  \r\n   `;
        expect(() => parsePersonaCharter(whitespace)).toThrow(CommunityPersonaValidationError);
        expect(() => parsePersonaCharter(whitespace)).toThrow(/cannot be empty/i);
      });

      it('rejects charter bodies strictly shorter than 10 characters', () => {
        const nineChars = `---
name: valid-name
---
123456789`;
        expect(() => parsePersonaCharter(nineChars)).toThrow(CommunityPersonaValidationError);
        expect(() => parsePersonaCharter(nineChars)).toThrow(/minimum 10 characters required/i);
      });

      it('accepts charter bodies of 10 or more characters', () => {
        const tenChars = `---
name: valid-name
---
0123456789`;
        const { charter } = parsePersonaCharter(tenChars);
        expect(charter).toBe('0123456789');
      });

      it('handles massive charter bodies (100KB+) efficiently without memory issues', () => {
        const largeText = 'A'.repeat(100 * 1024);
        const massiveContent = `---
name: massive-persona
---
# Massive Charter Body
${largeText}`;

        const start = Date.now();
        const { frontmatter, charter } = parsePersonaCharter(massiveContent);
        const duration = Date.now() - start;

        expect(frontmatter.name).toBe('massive-persona');
        expect(charter.length).toBeGreaterThan(100 * 1024);
        expect(duration).toBeLessThan(500);
      });
    });

    describe('1.4 Path Traversal Attempts (../../)', () => {
      it('safely handles ../../ path traversal attempts in local file references', async () => {
        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
        });

        // Attempt to escape scratchDir to read /etc/passwd or non-existent files
        await expect(loader.resolvePersonaReference('../../../../etc/passwd')).rejects.toThrow();
        await expect(loader.resolvePersonaReference('../../nonexistent-traversal-target.md')).rejects.toThrow(
          CommunityPersonaNotFoundError
        );
      });

      it('sanitizes remote reference path traversal so cache keys cannot escape cache directory', async () => {
        const mockFetch = vi.fn().mockResolvedValue(`---
name: trapped-remote
---
# Trapped Remote Charter
Charter that attempted path traversal in ref.`);

        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
          cacheDir,
          fetcher: mockFetch,
        });

        const result = await loader.resolvePersonaReference('attacker/repo/../../etc/shadow@main');
        expect(result.sourceType).toBe('remote');

        const cachedFiles = fs.readdirSync(cacheDir);
        expect(cachedFiles.length).toBe(1);
        for (const f of cachedFiles) {
          expect(f).not.toContain('/');
          expect(f).not.toContain('\\');
        }
      });
    });

    describe('1.5 Network Failure Handling in Remote Fetches', () => {
      it('handles HTTP 404 Not Found error gracefully', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('HTTP 404 Not Found'));
        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
          cacheDir,
          fetcher: mockFetch,
        });

        await expect(loader.resolvePersonaReference('github-org/repo/missing.md@v1.0')).rejects.toThrow(
          CommunityPersonaFetchError
        );
      });

      it('handles HTTP 500 Internal Server Error gracefully', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('HTTP 500 Internal Server Error'));
        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
          cacheDir,
          fetcher: mockFetch,
        });

        await expect(loader.resolvePersonaReference('github-org/repo/crashed.md@v1.0')).rejects.toThrow(
          CommunityPersonaFetchError
        );
      });

      it('handles network timeouts or socket hangup exceptions', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT: Connection timed out'));
        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
          cacheDir,
          fetcher: mockFetch,
        });

        await expect(loader.resolvePersonaReference('github-org/repo/timeout.md@v1.0')).rejects.toThrow(
          CommunityPersonaFetchError
        );
      });

      it('rejects remote responses that return HTML error pages (e.g. GitHub 404 HTML)', async () => {
        const mockFetch = vi.fn().mockResolvedValue(`<!DOCTYPE html>
<html>
<head><title>404 Not Found</title></head>
<body><h1>404 Not Found</h1></body>
</html>`);

        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
          cacheDir,
          fetcher: mockFetch,
        });

        await expect(loader.resolvePersonaReference('github-org/repo/html-error.md@v1.0')).rejects.toThrow(
          CommunityPersonaValidationError
        );
      });

      it('re-fetches automatically when a cached file has been corrupted', async () => {
        const mockFetch = vi.fn().mockResolvedValue(`---
name: repaired-persona
---
# Repaired Charter
Freshly downloaded persona after cache corruption.`);

        const loader = new CommunityPersonaLoader({
          baseDir: scratchDir,
          cacheDir,
          fetcher: mockFetch,
        });

        const safeKey = 'owner__repo__v1__corrupted.md';
        fs.writeFileSync(path.join(cacheDir, safeKey), 'CORRUPTED NON-FRONTMATTER GARBAGE', 'utf-8');

        const resolved = await loader.resolvePersonaReference('owner/repo/corrupted.md@v1');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(resolved.frontmatter.name).toBe('repaired-persona');
      });
    });

    describe('1.6 Empirical Bug Identification in sanitizePersonaId', () => {
      it('documents behavior for whitespace-only strings: returns p- rather than p-persona', () => {
        // Empirically observes that '   ' is truthy in JavaScript, so (name || 'persona') is '   '
        // which strips to '' and prepends 'p-', producing 'p-'.
        const result = sanitizePersonaId('   ');
        expect(result).toBe('p-');
      });
    });
  });

  // =========================================================================
  // 2. PERSISTENT TEAM MEMORY: CONCURRENCY, SPECIAL CHARS, REGEX
  // =========================================================================
  describe('2. Persistent Team Memory Adversarial Suite', () => {
    const dbPath = path.join(scratchDir, '.ct-memory/concurrent_test.db');
    let store: PRMemoryStore;

    beforeEach(() => {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      store = new PRMemoryStore(dbPath);
    });

    afterEach(() => {
      store.close();
    });

    describe('2.1 SQLite Concurrency Stress Tests', () => {
      it('handles 100 concurrent asynchronous inserts without SQLITE_BUSY or data loss', async () => {
        const repo = 'review-yeti-ai/concurrency-test';
        const count = 100;

        const insertPromises = Array.from({ length: count }, (_, i) =>
          store.recordResolvedNit(repo, i + 1, {
            ruleId: `concurrent-rule-${i}`,
            pattern: `pattern-match-${i}`,
            filePath: `src/file_${i}.ts`,
            reason: `Concurrency stress reason #${i}`,
          })
        );

        const results = await Promise.all(insertPromises);
        expect(results.length).toBe(count);

        const counts = store.getCounts();
        expect(counts.suppressedNitsCount).toBe(count);

        const memory = await store.queryLearnings(repo);
        expect(memory.resolvedNits.length).toBe(count);
      });

      it('supports concurrent multi-instance read/write access to the same SQLite database file', async () => {
        const repo = 'review-yeti-ai/multi-instance';
        const store2 = new PRMemoryStore(dbPath);
        const store3 = new PRMemoryStore(dbPath);

        try {
          await Promise.all([
            store.recordTeamRule(repo, { ruleId: 'rule-inst-1', pattern: 'inst 1 pattern' }),
            store2.recordTeamRule(repo, { ruleId: 'rule-inst-2', pattern: 'inst 2 pattern' }),
            store3.recordTeamRule(repo, { ruleId: 'rule-inst-3', pattern: 'inst 3 pattern' }),
            store.recordLearning(repo, 1, {
              category: 'architecture',
              title: 'Instance 1 Learning',
              description: 'Learned by worker 1',
            }),
            store2.recordLearning(repo, 2, {
              category: 'security',
              title: 'Instance 2 Learning',
              description: 'Learned by worker 2',
            }),
          ]);

          const mem1 = await store.queryLearnings(repo);
          const mem2 = await store2.queryLearnings(repo);
          const mem3 = await store3.queryLearnings(repo);

          expect(mem1.resolvedNits.length).toBe(3);
          expect(mem2.resolvedNits.length).toBe(3);
          expect(mem3.resolvedNits.length).toBe(3);
          expect(mem1.learnings.length).toBe(2);
        } finally {
          store2.close();
          store3.close();
        }
      });

      it('handles concurrent batch nit suppression increments atomically', async () => {
        const repo = 'review-yeti-ai/batch-test';
        const nit1 = await store.recordResolvedNit(repo, 1, { pattern: 'batch-pattern-1', filePath: 'src/**' });
        const nit2 = await store.recordResolvedNit(repo, 2, { pattern: 'batch-pattern-2', filePath: 'src/**' });

        await Promise.all([
          store.incrementNitSuppressionBatch([nit1.id!, nit2.id!]),
          store.incrementNitSuppressionBatch([nit1.id!]),
          store.incrementNitSuppression(nit2.id!),
        ]);

        const nits = await store.queryResolvedNits(repo);
        const updated1 = nits.find((n) => n.id === nit1.id);
        const updated2 = nits.find((n) => n.id === nit2.id);

        expect(updated1?.suppressionCount).toBe(2);
        expect(updated2?.suppressionCount).toBe(2);
      });
    });

    describe('2.2 Special Characters and Injection Stress', () => {
      it('prevents SQL injection attacks in rule IDs, patterns, and reasons', async () => {
        const repo = 'review-yeti-ai/sql-injection-test';
        const evilRuleId = "'; DROP TABLE resolved_nits; --";
        const evilPattern = "' OR '1'='1";
        const evilReason = '"); DELETE FROM team_rules; --';

        await store.recordResolvedNit(repo, 999, {
          ruleId: evilRuleId,
          pattern: evilPattern,
          filePath: 'src/auth.ts',
          reason: evilReason,
        });

        const counts = store.getCounts();
        expect(counts.suppressedNitsCount).toBe(1);

        const queryResult = await store.queryResolvedNits(repo, { ruleId: evilRuleId });
        expect(queryResult.length).toBe(1);
        expect(queryResult[0].ruleId).toBe(evilRuleId);
        expect(queryResult[0].pattern).toBe(evilPattern);
      });

      it('handles regex metacharacters in rule IDs without crashing or failing to match', async () => {
        const repo = 'review-yeti-ai/special-chars';
        const specialRuleIds = [
          'eslint:no-unused-vars(2)',
          'react/prop-types[warning]',
          'schema.$ref.*',
          'rule.[*+?^${}()|[\\]\\]',
          'rule-with-emoji-🚀-and-audit',
          '日本語_規約_ID',
          '<script>alert(1)</script>',
        ];

        for (let i = 0; i < specialRuleIds.length; i++) {
          await store.recordResolvedNit(repo, i, {
            ruleId: specialRuleIds[i],
            pattern: `pattern for ${specialRuleIds[i]}`,
            filePath: 'src/**',
            reason: 'Testing metacharacters in rule IDs',
          });
        }

        for (const rid of specialRuleIds) {
          const result = await store.queryResolvedNits(repo, { ruleId: rid });
          expect(result.length).toBe(1);
          expect(result[0].ruleId).toBe(rid);
        }

        const engine = new NitSuppressionEngine(store);
        for (const rid of specialRuleIds) {
          const testFinding: Finding = {
            ruleId: rid,
            path: 'src/component.tsx',
            title: `Violation of ${rid}`,
            severity: 'P2',
          };
          const res = await engine.suppressNits(repo, [testFinding]);
          expect(res.suppressedFindings.length).toBe(1);
          expect(res.activeFindings.length).toBe(0);
        }
      });
    });

    describe('2.3 Regex Patterns in Nit Suppression', () => {
      it('correctly suppresses findings matching unanchored regex patterns', async () => {
        const repo = 'review-yeti-ai/regex-test';

        await store.recordResolvedNit(repo, 1, {
          pattern: 'console\\.(log|debug|info)\\s*\\(',
          filePath: 'src/debug/**',
          reason: 'Allow logging in debug module',
        });

        const engine = new NitSuppressionEngine(store);

        const findings: Finding[] = [
          {
            path: 'src/debug/logger.ts',
            title: 'Forbidden logging detected',
            body: 'console.debug( "starting service" ) called in handler',
            severity: 'P2',
          },
          {
            path: 'src/debug/logger.ts',
            title: 'Forbidden logging detected',
            body: 'console.error( "fatal fault" ) called in handler',
            severity: 'P2',
          },
        ];

        const result = await engine.suppressNits(repo, findings);
        expect(result.suppressedFindings.length).toBe(1);
        expect(result.suppressedFindings[0].finding.body).toContain('console.debug');

        expect(result.activeFindings.length).toBe(1);
        expect(result.activeFindings[0].body).toContain('console.error');
      });

      it('correctly suppresses findings matching title-anchored regex patterns', async () => {
        const repo = 'review-yeti-ai/regex-anchor-test';

        await store.recordResolvedNit(repo, 1, {
          pattern: '^Style Violation:\\s+prefer\\s+(const|let)',
          filePath: 'src/**',
          reason: 'Style guideline exception',
        });

        const engine = new NitSuppressionEngine(store);

        const findings: Finding[] = [
          {
            path: 'src/service.ts',
            title: 'Style Violation: prefer const over var in declarations',
            severity: 'P2',
          },
          {
            path: 'src/service.ts',
            title: 'Unrelated Notice: Style Violation: prefer const over var',
            severity: 'P2',
          },
        ];

        const result = await engine.suppressNits(repo, findings);
        expect(result.suppressedFindings.length).toBe(1);
        expect(result.suppressedFindings[0].finding.title).toContain('Style Violation: prefer const');

        expect(result.activeFindings.length).toBe(1);
        expect(result.activeFindings[0].title).toContain('Unrelated Notice');
      });

      it('gracefully handles invalid regex patterns without throwing or breaking review flow', async () => {
        const repo = 'review-yeti-ai/invalid-regex';

        await store.recordResolvedNit(repo, 1, {
          pattern: '[unclosed-character-class',
          filePath: 'src/**',
          reason: 'Invalid regex stored by user',
        });
        await store.recordResolvedNit(repo, 2, {
          pattern: '*leading-quantifier',
          filePath: 'src/**',
          reason: 'Invalid quantifier',
        });

        const engine = new NitSuppressionEngine(store);

        const findings: Finding[] = [
          {
            path: 'src/app.ts',
            title: 'Unclosed character class issue [unclosed-character-class in file',
            severity: 'P2',
          },
          {
            path: 'src/app.ts',
            title: 'Clean finding without any matching words',
            severity: 'P2',
          },
        ];

        let evalResult: any;
        expect(async () => {
          evalResult = await engine.suppressNits(repo, findings);
        }).not.toThrow();

        evalResult = await engine.suppressNits(repo, findings);
        expect(evalResult.activeFindings.length).toBe(1);
        expect(evalResult.suppressedFindings.length).toBe(1);
      });

      it('evaluates file path glob patterns strictly', async () => {
        const repo = 'review-yeti-ai/glob-test';

        await store.recordResolvedNit(repo, 1, {
          pattern: 'todo comments',
          filePath: 'src/legacy/**/*.js',
          reason: 'Ignore todos in legacy JS only',
        });

        const engine = new NitSuppressionEngine(store);

        const findings: Finding[] = [
          {
            path: 'src/legacy/sub/old.js',
            title: 'Avoid todo comments in code',
            severity: 'P2',
          },
          {
            path: 'src/modern/new.ts',
            title: 'Avoid todo comments in code',
            severity: 'P2',
          },
        ];

        const res = await engine.suppressNits(repo, findings);
        expect(res.suppressedFindings.length).toBe(1);
        expect(res.suppressedFindings[0].finding.path).toBe('src/legacy/sub/old.js');

        expect(res.activeFindings.length).toBe(1);
        expect(res.activeFindings[0].path).toBe('src/modern/new.ts');
      });
    });
  });

  // =========================================================================
  // 3. SAFETY ENFORCEMENT: P0, P1, CRITICAL, BLOCKER IMMUNITY
  // =========================================================================
  describe('3. Safety Enforcement Suite (P0/P1/CRITICAL/BLOCKER Immunity)', () => {
    let store: PRMemoryStore;
    let engine: NitSuppressionEngine;
    const repo = 'review-yeti-ai/safety-critical-repo';

    beforeEach(async () => {
      store = new PRMemoryStore(':memory:');
      engine = new NitSuppressionEngine(store);

      await store.recordResolvedNit(repo, 1, {
        ruleId: 'blanket-override-rule',
        pattern: 'vulnerability',
        filePath: '**',
        reason: 'Attempted blanket suppression',
      });
    });

    afterEach(() => {
      store.close();
    });

    it('NEVER suppresses P0 findings, even under exact rule and path match', async () => {
      const p0Finding: Finding = {
        ruleId: 'blanket-override-rule',
        path: 'src/security/crypto.ts',
        title: 'Critical vulnerability: Hardcoded RSA private key found',
        body: 'vulnerability in crypto configuration',
        severity: 'P0',
      };

      const result = await engine.suppressNits(repo, [p0Finding]);

      expect(result.activeFindings.length).toBe(1);
      expect(result.suppressedFindings.length).toBe(0);
      expect(result.activeFindings[0].severity).toBe('P0');
    });

    it('NEVER suppresses P1 findings, even under exact rule and path match', async () => {
      const p1Finding: Finding = {
        ruleId: 'blanket-override-rule',
        path: 'src/security/auth.ts',
        title: 'High vulnerability: Missing authorization check on tenant deletion',
        body: 'vulnerability in tenant deletion handler',
        severity: 'P1',
      };

      const result = await engine.suppressNits(repo, [p1Finding]);

      expect(result.activeFindings.length).toBe(1);
      expect(result.suppressedFindings.length).toBe(0);
      expect(result.activeFindings[0].severity).toBe('P1');
    });

    it('NEVER suppresses CRITICAL, BLOCKER, HIGH, or ERROR findings regardless of casing', async () => {
      const blockingSeverities = [
        'CRITICAL',
        'critical',
        'BLOCKER',
        'blocker',
        'HIGH',
        'high',
        'ERROR',
        'error',
        'p0',
        'p1',
      ];

      const findings: Finding[] = blockingSeverities.map((sev, idx) => ({
        id: `finding-${idx}`,
        ruleId: 'blanket-override-rule',
        path: `src/core/module_${idx}.ts`,
        title: `vulnerability found with severity ${sev}`,
        severity: sev,
      }));

      const result = await engine.suppressNits(repo, findings);

      expect(result.activeFindings.length).toBe(blockingSeverities.length);
      expect(result.suppressedFindings.length).toBe(0);
    });

    it('selectively suppresses P2 and minor nits while preserving blocking findings in the same batch', async () => {
      const mixedBatch: Finding[] = [
        {
          id: 'f1-p0',
          ruleId: 'blanket-override-rule',
          path: 'src/app.ts',
          title: 'Remote code execution vulnerability',
          severity: 'P0',
        },
        {
          id: 'f2-p1',
          ruleId: 'blanket-override-rule',
          path: 'src/app.ts',
          title: 'Authentication bypass vulnerability',
          severity: 'P1',
        },
        {
          id: 'f3-p2',
          ruleId: 'blanket-override-rule',
          path: 'src/app.ts',
          title: 'Minor formatting vulnerability docstring nit',
          severity: 'P2',
        },
        {
          id: 'f4-minor',
          ruleId: 'blanket-override-rule',
          path: 'src/app.ts',
          title: 'Minor style vulnerability note',
          severity: 'minor',
        },
      ];

      const result = await engine.suppressNits(repo, mixedBatch);

      expect(result.activeFindings.length).toBe(2);
      expect(result.activeFindings.map((f) => f.id)).toEqual(['f1-p0', 'f2-p1']);

      expect(result.suppressedFindings.length).toBe(2);
      expect(result.suppressedFindings.map((sf) => sf.finding.id)).toEqual(['f3-p2', 'f4-minor']);

      const stored = await store.queryResolvedNits(repo, { ruleId: 'blanket-override-rule' });
      expect(stored[0].suppressionCount).toBe(2);
    });
  });
});
