import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
const { Client } = pg;
import {
  isPrepPhase,
  shallowFetchHead,
  extractDiffAndTriage,
  assemblePrepPrompt,
  persistPrepState,
  dispatchMultiplexerTrigger,
  runPrepPhase,
  MAX_PREPARED_REVIEW_BYTES,
  type PrepPayload,
  type TriageSummary,
} from '../../src/review/prepPhase';

describe('Challenger 2 Empirical Stress Suite: Prep Phase Decoupling, AST Triage, Prompt Bounding & Persistence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SUITE 1: Diff Extraction & Edge Cases
  // =========================================================================
  describe('SUITE 1: Diff Extraction & Boundary Conditions', () => {
    it('EMP-M2-DIFF-01: handles empty diff string without throwing and returns zero counts', async () => {
      const triage = await extractDiffAndTriage({ diff: '' });
      expect(triage.changedFiles).toEqual([]);
      expect(triage.triageSummary.filesCount).toBe(0);
      expect(triage.triageSummary.hunksCount).toBe(0);
      expect(triage.triageSummary.astSymbols).toEqual([]);
      expect(triage.triageSummary.truncated).toBe(false);

      const prompt = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 1,
        headSha: 'abc',
        astSymbols: triage.astSymbols,
        changedFiles: triage.changedFiles,
      });

      expect(prompt.messages.length).toBe(2);
      expect(prompt.truncated).toBe(false);
      expect(JSON.parse(JSON.stringify(prompt.messages))).toEqual(prompt.messages);
    });

    it('EMP-M2-DIFF-02: handles whitespace-only diffs without throwing', async () => {
      const whitespaceDiff = '   \n\n\t  \r\n   ';
      const triage = await extractDiffAndTriage({ diff: whitespaceDiff });
      expect(triage.changedFiles).toEqual([]);
      expect(triage.triageSummary.filesCount).toBe(0);
      expect(triage.triageSummary.hunksCount).toBe(0);
      expect(triage.triageSummary.astSymbols).toEqual([]);
    });

    it('EMP-M2-DIFF-03: handles header-only diffs without hunks (mode change or empty file)', async () => {
      const headerOnlyDiff = `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29`;

      const triage = await extractDiffAndTriage({ diff: headerOnlyDiff });
      expect(triage.changedFiles.length).toBe(1);
      expect(triage.changedFiles[0].path).toBe('empty.txt');
      expect(triage.triageSummary.filesCount).toBe(1);
      // Fallback hunk count is 1
      expect(triage.triageSummary.hunksCount).toBe(1);
      expect(triage.astSymbols).toEqual([]);
    });

    it('EMP-M2-DIFF-04: handles standard git binary diffs without unhandled exceptions', async () => {
      const binaryDiff = `diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/assets/logo.png differ`;

      const triage = await extractDiffAndTriage({ diff: binaryDiff });
      expect(triage.changedFiles.length).toBe(1);
      expect(triage.changedFiles[0].path).toBe('assets/logo.png');
      expect(triage.triageSummary.filesCount).toBe(1);
      expect(triage.astSymbols).toEqual([]);

      const prompt = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 1,
        headSha: 'abc',
        astSymbols: triage.astSymbols,
        changedFiles: triage.changedFiles,
      });
      expect(prompt.messages[1].content).toContain('assets/logo.png');
      expect(prompt.messages[1].content).toContain('Binary files /dev/null and b/assets/logo.png differ');
    });

    it('EMP-M2-DIFF-05: handles git binary patch with delta encoding without crashing', async () => {
      const gitBinaryPatch = `diff --git a/bin/app.wasm b/bin/app.wasm
index 1111111..2222222 100644
GIT binary patch
literal 32
zcmeAS@N?(olHy` + '`' + `Uvi4e4!3}kO1~8Vq92j?4^<`;

      const triage = await extractDiffAndTriage({ diff: gitBinaryPatch });
      expect(triage.changedFiles.length).toBe(1);
      expect(triage.changedFiles[0].path).toBe('bin/app.wasm');
      expect(triage.triageSummary.filesCount).toBe(1);
    });

    it('EMP-M2-DIFF-06: shallowFetchHead gracefully handles corrupt/non-existent repo without unhandled exceptions', async () => {
      // In test mode shallowFetchHead returns success: true unless RUN_GIT_FETCH=true
      // We explicitly test the catch block by pointing to invalid path with RUN_GIT_FETCH=true
      process.env.RUN_GIT_FETCH = 'true';
      try {
        const result = await shallowFetchHead({
          workspacePath: '/dev/null/impossible-path-' + Date.now(),
          repo: 'nonexistent-org/nonexistent-repo-404',
          headSha: '0000000000000000000000000000000000000000',
        });
        expect(result.success).toBe(false);
        expect(result.sha).toBe('0000000000000000000000000000000000000000');
        expect(typeof result.durationMs).toBe('number');
      } finally {
        delete process.env.RUN_GIT_FETCH;
      }
    });
  });

  // =========================================================================
  // SUITE 2: Prompt Bounding & MaxPreparedReviewBytes Invariant
  // =========================================================================
  describe('SUITE 2: Persona Prompt Bounding to 256KB Boundary', () => {
    it('EMP-M2-BND-01: truncates huge ASCII diff and appends truncation marker', () => {
      const hugePatch = '+\n'.repeat(150_000); // 300,000 characters
      const { messages, truncated } = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 42,
        headSha: 'deadbeef',
        astSymbols: ['testSymbol'],
        changedFiles: [{ path: 'huge.txt', patch: hugePatch }],
      });

      expect(truncated).toBe(true);
      expect(messages[1].content).toContain('[TRUNCATED: MaxPreparedReviewBytes exceeded]');
      // Sliced content length is maxBytes + truncation marker
      const userContent = messages[1].content as string;
      const marker = '\n[TRUNCATED: MaxPreparedReviewBytes exceeded]';
      expect(userContent.endsWith(marker)).toBe(true);
      expect(userContent.slice(0, MAX_PREPARED_REVIEW_BYTES).length).toBe(MAX_PREPARED_REVIEW_BYTES);
    });

    it('EMP-M2-BND-02: multi-byte UTF-8 diff is truncated to respect 256KB byte boundary', () => {
      // 100,000 Chinese characters: length is 100,000 (which is < 262,144)
      // but byte length is 300,000 bytes (> 256KB = 262,144 bytes)
      const multiBytePatch = '+\n' + '审'.repeat(100_000);
      const { messages, truncated } = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 42,
        headSha: 'deadbeef',
        astSymbols: ['testSymbol'],
        changedFiles: [{ path: 'unicode.txt', patch: multiBytePatch }],
        maxBytes: MAX_PREPARED_REVIEW_BYTES,
      });

      const userContent = messages[1].content as string;
      const userContentBytes = Buffer.byteLength(userContent, 'utf8');

      // Byte-level truncation correctly bounds byte size:
      expect(truncated).toBe(true);
      expect(userContentBytes).toBeLessThanOrEqual(MAX_PREPARED_REVIEW_BYTES + 100);
    });

    it('EMP-M2-BND-03: surrogate-aware truncation prevents splitting surrogate pairs and lone surrogates', () => {
      // Calculate exact prefix length to align a surrogate pair across the 262144 boundary
      const headerProbe = assemblePrepPrompt({
        repo: 'test/repo',
        prNumber: 1,
        headSha: '0000000000000000000000000000000000000000',
        astSymbols: [],
        changedFiles: [{ path: 'test.txt', patch: '' }],
        maxBytes: MAX_PREPARED_REVIEW_BYTES,
      });
      const headerLen = Buffer.byteLength(headerProbe.messages[1].content as string, 'utf8');
      const targetPrefixLen = MAX_PREPARED_REVIEW_BYTES - headerLen - 1;
      const emoji = '🚀'; // \uD83D\uDE80 (high surrogate \uD83D at index 262143, low surrogate \uDE80 at index 262144)
      const patch = 'A'.repeat(targetPrefixLen) + emoji;

      const { messages, truncated } = assemblePrepPrompt({
        repo: 'test/repo',
        prNumber: 1,
        headSha: '0000000000000000000000000000000000000000',
        astSymbols: [],
        changedFiles: [{ path: 'test.txt', patch }],
        maxBytes: MAX_PREPARED_REVIEW_BYTES,
      });

      expect(truncated).toBe(true);
      const userContent = messages[1].content as string;

      // Extract the character right before the truncation marker
      const marker = '\n[TRUNCATED: MaxPreparedReviewBytes exceeded]';
      const slicedBody = userContent.slice(0, userContent.length - marker.length);
      const lastCharCode = slicedBody.charCodeAt(slicedBody.length - 1);

      // Verify that the last character is NOT a lone high surrogate (0xD800 - 0xDBFF)
      const isHighSurrogate = lastCharCode >= 0xd800 && lastCharCode <= 0xdbff;
      expect(isHighSurrogate).toBe(false);

      // Verify JSON serialization contains valid Unicode without lone surrogate escapes
      const serialized = JSON.stringify({ content: userContent });
      expect(serialized).not.toContain('\\ud83d');
    });

    it('EMP-M2-BND-04: boundary checks for custom maxBytes values (0, 1, small bounds)', () => {
      const { messages: m0, truncated: t0 } = assemblePrepPrompt({
        repo: 'test/repo',
        prNumber: 1,
        headSha: '0000',
        astSymbols: [],
        changedFiles: [{ path: 'test.txt', patch: '+test' }],
        maxBytes: 0,
      });
      // When maxBytes is 0, options.maxBytes || MAX_PREPARED_REVIEW_BYTES defaults to MAX_PREPARED_REVIEW_BYTES
      expect(t0).toBe(false);

      const { messages: m1, truncated: t1 } = assemblePrepPrompt({
        repo: 'test/repo',
        prNumber: 1,
        headSha: '0000',
        astSymbols: [],
        changedFiles: [{ path: 'test.txt', patch: '+test' }],
        maxBytes: 50,
      });
      expect(t1).toBe(true);
      expect(m1[1].content).toContain('[TRUNCATED: MaxPreparedReviewBytes exceeded]');
    });

    it('EMP-M2-BND-05: assembled prompt messages remain JSON-parseable under extreme characters', () => {
      const adversarialPatch = [
        '+const code = `eval("/* */")`;',
        '+const json = "{\\"nested\\": true, \\"symbols\\": [1, 2, 3]}";',
        '+const tags = "<script>alert(\'xss\')</script>";',
        '+const sql = "SELECT * FROM users WHERE name = \'admin\' --";',
        '+const control = "\x01\x02\x08\x0B\x0C\x1F";',
      ].join('\n');

      const { messages, truncated } = assemblePrepPrompt({
        repo: 'test/adversarial',
        prNumber: 666,
        headSha: 'abcdef0123456789',
        astSymbols: ['eval', 'alert', 'SELECT'],
        changedFiles: [{ path: 'exploit.ts', patch: adversarialPatch }],
      });

      const serialized = JSON.stringify(messages);
      const parsed = JSON.parse(serialized);
      expect(parsed).toEqual(messages);
    });
  });

  // =========================================================================
  // SUITE 3: PostgreSQL State Persistence & Faithful Reconstruction
  // =========================================================================
  describe('SUITE 3: PostgreSQL State Persistence & Faithful Reconstruction', () => {
    it('EMP-M2-SER-01: faithfully reconstructs all triage state, symbols, and prompt messages without loss or mutation', async () => {
      const storedPayloads: Map<string, string> = new Map();
      const mockDb = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('UPDATE review_runs')) {
            storedPayloads.set(params?.[1] as string, params?.[0] as string);
          }
          if (sql.includes('INSERT INTO review_run_artifacts')) {
            storedPayloads.set(`${params?.[0]}_artifact`, params?.[2] as string);
          }
          return { rows: [] };
        },
      };

      const originalPayload: PrepPayload = {
        runId: 'run-fidelity-001',
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
        repository: 'calltelemetry/review-yeti-bot',
        prNumber: 142,
        triageSummary: {
          filesCount: 4,
          hunksCount: 12,
          astSymbols: [
            '$scope',
            'React$Component',
            '_privateHandler',
            'calculateFee',
            'executeOrder66',
            'handleIncomingCall',
          ],
          truncated: false,
        },
        promptMessages: [
          { role: 'system', content: 'You are Review Yeti.\nPersonas:\n- [sec] Security' },
          {
            role: 'user',
            content: 'Repository: calltelemetry/review-yeti-bot\nDiff:\n+const a = {"key": "val"};\n',
          },
        ],
        metadata: {
          arbitrary: 'data',
          nested: { count: 42, active: true },
        },
        createdAt: new Date().toISOString(),
      };

      await persistPrepState(mockDb, originalPayload);

      // Verify stored payload in review_runs
      const serializedRun = storedPayloads.get('run-fidelity-001');
      expect(serializedRun).toBeDefined();
      const reconstructedRun: PrepPayload = JSON.parse(serializedRun!);

      // Faithful reconstruction check
      expect(reconstructedRun.runId).toBe(originalPayload.runId);
      expect(reconstructedRun.headSha).toBe(originalPayload.headSha);
      expect(reconstructedRun.baseSha).toBe(originalPayload.baseSha);
      expect(reconstructedRun.repository).toBe(originalPayload.repository);
      expect(reconstructedRun.prNumber).toBe(originalPayload.prNumber);
      expect(reconstructedRun.createdAt).toBe(originalPayload.createdAt);
      expect(reconstructedRun.triageSummary.filesCount).toBe(originalPayload.triageSummary.filesCount);
      expect(reconstructedRun.triageSummary.hunksCount).toBe(originalPayload.triageSummary.hunksCount);
      expect(reconstructedRun.triageSummary.astSymbols).toEqual(originalPayload.triageSummary.astSymbols);
      expect(reconstructedRun.triageSummary.truncated).toBe(originalPayload.triageSummary.truncated);
      expect(reconstructedRun.promptMessages).toEqual(originalPayload.promptMessages);
      expect(reconstructedRun.metadata).toEqual(originalPayload.metadata);

      // Verify stored payload in review_run_artifacts
      const serializedArtifact = storedPayloads.get('run-fidelity-001_artifact');
      expect(serializedArtifact).toBeDefined();
      const reconstructedArtifact: PrepPayload = JSON.parse(serializedArtifact!);
      expect(reconstructedArtifact).toEqual(reconstructedRun);
    });

    it('EMP-M2-SER-02: skips review_run_artifacts insertion when byteLength exceeds 2,000,000 bytes constraint', async () => {
      const artifactInserts: unknown[] = [];
      const runUpdates: unknown[] = [];

      const mockDb = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO review_run_artifacts')) {
            artifactInserts.push(params);
          }
          if (sql.includes('UPDATE review_runs')) {
            runUpdates.push(params);
          }
          return { rows: [] };
        },
      };

      // Create a payload with >2MB serialized size (e.g. 250,000 symbols)
      const hugeSymbols = Array.from({ length: 250_000 }, (_, i) => `sym_${i.toString().padStart(6, '0')}`);
      const hugePayload: PrepPayload = {
        runId: 'run-huge-artifact',
        headSha: '0000',
        baseSha: '0000',
        repository: 'test/repo',
        prNumber: 1,
        triageSummary: {
          filesCount: 1,
          hunksCount: 1,
          astSymbols: hugeSymbols,
          truncated: true,
        },
        promptMessages: [{ role: 'user', content: 'test' }],
        createdAt: new Date().toISOString(),
      };

      const serialized = JSON.stringify(hugePayload);
      const byteLength = Buffer.byteLength(serialized, 'utf8');
      expect(byteLength).toBeGreaterThan(2_000_000);

      await persistPrepState(mockDb, hugePayload);

      // review_runs is updated
      expect(runUpdates.length).toBe(1);
      // review_run_artifacts is skipped to respect CHECK (byte_length <= 2000000)
      expect(artifactInserts.length).toBe(0);
    });

    it('EMP-M2-SER-03: SQL injection safety via parameterized queries', async () => {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const mockDb = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      };

      const maliciousPayload: PrepPayload = {
        runId: "run-001'; DROP TABLE review_runs; --",
        headSha: "' OR 1=1; --",
        baseSha: "'; DELETE FROM review_run_artifacts; --",
        repository: "malicious/repo' UNION SELECT * FROM passwords; --",
        prNumber: 999,
        triageSummary: { filesCount: 1, hunksCount: 1, astSymbols: ["'; DROP DATABASE; --"], truncated: false },
        promptMessages: [{ role: 'user', content: "'; DROP SCHEMA public CASCADE; --" }],
        createdAt: new Date().toISOString(),
      };

      await persistPrepState(mockDb, maliciousPayload);

      for (const q of queries) {
        expect(q.sql).not.toContain("'; DROP TABLE");
        expect(q.sql).not.toContain("'; DELETE FROM");
        expect(q.sql).not.toContain("'; DROP DATABASE");
        // Parameters carry the literal injection strings safely
        expect(q.params).toBeDefined();
      }
    });

    it('EMP-M2-SER-04 [EMPIRICAL REAL POSTGRES]: verifies PostgreSQL JSONB behavior with live database connection', async () => {
      let client: pg.Client | null = null;
      try {
        client = new Client({
          host: 'localhost',
          port: 5432,
          user: 'calltelemetry',
          password: 'calltelemetry_dev_password',
          database: 'postgres',
        });
        await client.connect();

        // Create temporary table for isolated testing
        await client.query(`
          CREATE TEMP TABLE test_review_runs (
            run_id VARCHAR(255) PRIMARY KEY,
            status VARCHAR(32),
            artifacts JSONB DEFAULT '{}'::jsonb,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TEMP TABLE test_review_run_artifacts (
            run_id VARCHAR(255) NOT NULL,
            stage VARCHAR(32) NOT NULL,
            content_digest VARCHAR(64) NOT NULL,
            payload JSONB NOT NULL,
            byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 2000000),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (run_id, stage)
          );
          INSERT INTO test_review_runs (run_id, status) VALUES ('run-live-test', 'queued');
        `);

        // Test normal payload round-trip in real PostgreSQL
        const testPayload: PrepPayload = {
          runId: 'run-live-test',
          headSha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
          baseSha: '0000000000000000000000000000000000000000',
          repository: 'calltelemetry/review-yeti-bot',
          prNumber: 88,
          triageSummary: {
            filesCount: 2,
            hunksCount: 5,
            astSymbols: ['handleIncomingCall', 'evaluateRoutePolicy', '$specialVar'],
            truncated: false,
          },
          promptMessages: [
            { role: 'system', content: 'You are Review Yeti.' },
            { role: 'user', content: 'Diff context: ```ts\nconst x = 1;\n```' },
          ],
          createdAt: new Date().toISOString(),
        };

        const serialized = JSON.stringify(testPayload);
        const digest = createHash('sha256').update(serialized).digest('hex');
        const byteLength = Buffer.byteLength(serialized, 'utf8');

        // Test review_runs update
        await client.query(
          `UPDATE test_review_runs
           SET status = 'awaiting_inference',
               artifacts = jsonb_set(
                 COALESCE(artifacts, '{}'::jsonb),
                 '{prep_payload}',
                 $1::jsonb
               ),
               updated_at = CURRENT_TIMESTAMP
           WHERE run_id = $2`,
          [serialized, testPayload.runId],
        );

        // Test review_run_artifacts insert
        await client.query(
          `INSERT INTO test_review_run_artifacts (run_id, stage, content_digest, payload, byte_length, created_at)
           VALUES ($1, 'prep_state', $2, $3::jsonb, $4, CURRENT_TIMESTAMP)`,
          [testPayload.runId, digest, serialized, byteLength],
        );

        // Read back from review_runs and verify deep equality
        const runResult = await client.query('SELECT artifacts->\'prep_payload\' as prep_payload FROM test_review_runs WHERE run_id = $1', [testPayload.runId]);
        expect(runResult.rows[0].prep_payload).toEqual(testPayload);

        // Read back from review_run_artifacts and verify deep equality
        const artifactResult = await client.query('SELECT payload FROM test_review_run_artifacts WHERE run_id = $1 AND stage = $2', [testPayload.runId, 'prep_state']);
        expect(artifactResult.rows[0].payload).toEqual(testPayload);

        // EMPIRICAL FAILURE TEST 1: Lone surrogate in PostgreSQL jsonb throws invalid input syntax
        let surrogateError: string | null = null;
        try {
          const loneSurrogateJson = JSON.stringify({ text: 'split surrogate: \uD83D' });
          await client.query('SELECT $1::jsonb', [loneSurrogateJson]);
        } catch (err: any) {
          surrogateError = err.message;
        }
        expect(surrogateError).toContain('invalid input syntax for type json');

        // EMPIRICAL FAILURE TEST 2: Null byte \u0000 in PostgreSQL jsonb throws unsupported Unicode escape sequence
        let nullByteError: string | null = null;
        try {
          const nullByteJson = JSON.stringify({ text: 'null \u0000 byte' });
          await client.query('SELECT $1::jsonb', [nullByteJson]);
        } catch (err: any) {
          nullByteError = err.message;
        }
        expect(nullByteError).toContain('unsupported Unicode escape sequence');

      } finally {
        if (client) {
          await client.end();
        }
      }
    });
  });

  // =========================================================================
  // SUITE 4: Full Orchestration & Multi-Cycle Lifecycle
  // =========================================================================
  describe('SUITE 4: End-to-End Orchestration & Failure Recovery', () => {
    it('EMP-M2-E2E-01: executes full runPrepPhase lifecycle with custom dispatcher and exitCode 0', async () => {
      let dispatched = false;
      const dispatcher = async (payload: PrepPayload) => {
        dispatched = payload.runId === 'run-e2e-ok';
        return true;
      };

      const result = await runPrepPhase({
        runId: 'run-e2e-ok',
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 1,
        headSha: '1111222233334444555566667777888899990000',
        baseSha: '0000999988887777666655554444333322221111',
        diff: 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,2 @@\n+const added = true;\n',
        multiplexerDispatcher: dispatcher,
        suppressExit: true,
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.multiplexerTriggered).toBe(true);
      expect(dispatched).toBe(true);
      expect(result.triageSummary.filesCount).toBe(1);
      expect(result.triageSummary.hunksCount).toBe(1);
    });

    it('EMP-M2-E2E-02: multiplexer trigger falls back gracefully when http fails and db is absent', async () => {
      const payload: PrepPayload = {
        runId: 'run-fallback',
        headSha: '0000',
        baseSha: '0000',
        repository: 'test/repo',
        prNumber: 1,
        triageSummary: { filesCount: 0, hunksCount: 0, astSymbols: [], truncated: false },
        promptMessages: [],
        createdAt: new Date().toISOString(),
      };

      // Invalid multiplexer URL
      const trigger = await dispatchMultiplexerTrigger({
        payload,
        multiplexerUrl: 'http://127.0.0.1:59999/nonexistent',
      });

      expect(trigger.triggered).toBe(true);
      expect(trigger.channel).toBe('simulated');
    });
  });
});
