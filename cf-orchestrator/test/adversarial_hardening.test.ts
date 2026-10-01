/**
 * adversarial_hardening.test.ts
 *
 * Dedicated verification suite for Milestone 5 Phase 2 Adversarial Coverage Hardening:
 * 1. R2 Workspace Caching: pipefail hardening in benchmarkUnpackSpeed.
 * 2. Parity Comparison & CI Ledger: computeFingerprint null/line guards,
 *    sanitizeMarkdownCell integrity, defensive token telemetry formatting,
 *    and strict validateReceipt token schema validation.
 * 3. Repository Concurrency Gate (RepoGateDO): synchronous queuePosition capture
 *    and closed PR tombstone rejection for unseen runs.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  benchmarkUnpackSpeed,
} from '../src/runners/r2WorkspaceCache.js';
import {
  computeFingerprint,
  sanitizeMarkdownCell,
  formatMarkdownLedger,
  validateReceipt,
  compareRuns,
  type ReviewRunReceipt,
  type Finding,
} from '../src/compareOrchestratorRuns.js';
import { RepoGateDO } from '../src/repoGateDO.js';
import { MockDurableObjectState } from './mockDurableObject.js';

const execFileAsync = promisify(execFile);

describe('Adversarial Hardening: Tier 5 Fixes Verification', () => {
  let tempBaseDir: string;

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-hardening-test-'));
  });

  after(async () => {
    await fs.rm(tempBaseDir, { recursive: true, force: true });
  });

  // =========================================================================
  // 1. R2 Workspace Caching: pipefail in benchmarkUnpackSpeed
  // =========================================================================
  describe('1. R2 Workspace Caching: pipefail hardening', () => {
    it('benchmarkUnpackSpeed rejects on zero-byte archive due to set -o pipefail', async () => {
      const emptyArchive = path.join(tempBaseDir, 'empty.tar.zst');
      const unpackDest = path.join(tempBaseDir, 'empty_dest');
      await fs.writeFile(emptyArchive, Buffer.alloc(0));

      await assert.rejects(
        async () => benchmarkUnpackSpeed(emptyArchive, unpackDest),
        (err: any) => {
          // Should fail because zstd exits with non-zero on empty input and pipefail catches it
          return err !== undefined;
        },
        'Expected benchmarkUnpackSpeed to reject on 0-byte archive'
      );
    });

    it('benchmarkUnpackSpeed rejects on corrupted/garbage archive data due to set -o pipefail', async () => {
      const corruptArchive = path.join(tempBaseDir, 'corrupt.tar.zst');
      const unpackDest = path.join(tempBaseDir, 'corrupt_dest');
      await fs.writeFile(corruptArchive, Buffer.from('NOT_VALID_ZSTD_HEADER_OR_CONTENT'));

      await assert.rejects(
        async () => benchmarkUnpackSpeed(corruptArchive, unpackDest),
        (err: any) => {
          return err !== undefined;
        },
        'Expected benchmarkUnpackSpeed to reject on corrupted archive'
      );
    });

    it('benchmarkUnpackSpeed successfully unpacks a valid .tar.zst archive and returns throughput metrics', async () => {
      const validArchive = path.join(tempBaseDir, 'valid.tar.zst');
      const unpackDest = path.join(tempBaseDir, 'valid_dest');
      const payloadDir = path.join(tempBaseDir, 'payload');
      await fs.mkdir(payloadDir, { recursive: true });
      await fs.writeFile(path.join(payloadDir, 'hello.txt'), 'Hello Review Yeti');

      // Create a genuine tar.zst
      await execFileAsync('sh', [
        '-c',
        `tar -cf - -C "${payloadDir}" . | zstd -o "${validArchive}"`,
      ]);

      const result = await benchmarkUnpackSpeed(validArchive, unpackDest);
      assert.equal(typeof result.durationMs, 'number');
      assert.ok(result.durationMs >= 0);
      assert.ok(result.archiveSizeBytes > 0);
      assert.equal(typeof result.isSub1500Ms, 'boolean');
      assert.ok(result.throughputMBs > 0);

      const unpackedFile = await fs.readFile(path.join(unpackDest, 'hello.txt'), 'utf8');
      assert.equal(unpackedFile, 'Hello Review Yeti');
    });
  });

  // =========================================================================
  // 2. Parity Comparison & CI Ledger Hardening
  // =========================================================================
  describe('2. Parity Comparison & CI Ledger Hardening', () => {
    describe('2.1 computeFingerprint guards and sanitization', () => {
      it('returns empty string for nullish inputs without throwing TypeError', () => {
        assert.equal(computeFingerprint(null as any), '');
        assert.equal(computeFingerprint(undefined as any), '');
        assert.equal(computeFingerprint('' as any), '');
      });

      it('sanitizes negative, zero, and float line numbers to positive integers', () => {
        assert.equal(
          computeFingerprint({ file: 'src/app.ts', line: -10, ruleId: 'R1' }),
          'src/app.ts:1:R1:warning'
        );
        assert.equal(
          computeFingerprint({ file: 'src/app.ts', line: 0, ruleId: 'R1' }),
          'src/app.ts:1:R1:warning'
        );
        assert.equal(
          computeFingerprint({ file: 'src/app.ts', line: 42.75, ruleId: 'R1' }),
          'src/app.ts:42:R1:warning'
        );
        assert.equal(
          computeFingerprint({ file: 'src/app.ts', line: NaN as any, ruleId: 'R1' }),
          'src/app.ts:1:R1:warning'
        );
      });

      it('preserves valid positive integer lines and trims strings', () => {
        assert.equal(
          computeFingerprint({ file: 'src/app.ts', line: 15, ruleId: 'R1', severity: 'error' }),
          'src/app.ts:15:R1:error'
        );
        assert.equal(computeFingerprint('  fp:10:rule  '), 'fp:10:rule');
      });

      it('defensively coerces non-string severity values to string before lowercasing', () => {
        assert.equal(
          computeFingerprint({ file: 'src/app.ts', line: 10, ruleId: 'R1', severity: 2 as any }),
          'src/app.ts:10:R1:2'
        );
        assert.equal(
          computeFingerprint({ file: 'src/app.ts', line: 10, ruleId: 'R1', severity: true as any }),
          'src/app.ts:10:R1:true'
        );
        assert.equal(
          computeFingerprint({ file: 'src/app.ts', line: 10, ruleId: 'R1', severity: false as any }),
          'src/app.ts:10:R1:false'
        );
      });
    });

    describe('2.2 sanitizeMarkdownCell table formatting integrity', () => {
      it('replaces all combinations of newlines with spaces', () => {
        assert.equal(sanitizeMarkdownCell('line1\nline2'), 'line1 line2');
        assert.equal(sanitizeMarkdownCell('line1\r\nline2'), 'line1 line2');
        assert.equal(sanitizeMarkdownCell('line1\rline2\n\nline3'), 'line1 line2 line3');
      });

      it('escapes pipe characters and backticks', () => {
        assert.equal(sanitizeMarkdownCell('foo|bar|baz'), 'foo\\|bar\\|baz');
        assert.equal(sanitizeMarkdownCell('foo`bar`baz'), 'foo\\`bar\\`baz');
      });

      it('handles empty or falsy strings gracefully', () => {
        assert.equal(sanitizeMarkdownCell(''), '');
        assert.equal(sanitizeMarkdownCell(null as any), '');
      });
    });

    describe('2.3 formatMarkdownLedger defensive token checks and cell escaping', () => {
      const baseReceipt: ReviewRunReceipt = {
        orchestrator: 'doks',
        runId: 'doks_run_1',
        repo: 'review-yeti-ai/review-yeti-bot',
        prNumber: 55,
        headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        verdict: 'success',
        findingFingerprints: ['src/api.ts:10:sec|pipe:warning', 'src/path\nnewline:20:r:warning'],
        durationMs: 30000,
        completedAt: new Date().toISOString(),
      };

      it('does not throw TypeError when tokensUsed is empty object or missing fields', () => {
        const doks: ReviewRunReceipt = {
          ...baseReceipt,
          tokensUsed: {} as any, // partial/empty tokensUsed
        };
        const cf: ReviewRunReceipt = {
          ...baseReceipt,
          orchestrator: 'cloudflare',
          tokensUsed: { promptTokens: 500, completionTokens: 100 } as any, // missing totalTokens
        };

        const result = compareRuns(doks, cf);
        assert.doesNotThrow(() => {
          const md = formatMarkdownLedger(result, doks, cf);
          assert.ok(md.includes('N/A'));
        });
      });

      it('escapes pipes and replaces newlines in table discrepancy rows', () => {
        const doks: ReviewRunReceipt = {
          ...baseReceipt,
          findingFingerprints: [
            'src/db.ts:10:rule|with|pipes:error',
            'src/ui\ncomponent.ts:5:rule:warning',
          ],
        };
        const cf: ReviewRunReceipt = {
          ...baseReceipt,
          orchestrator: 'cloudflare',
          findingFingerprints: [],
        };

        const result = compareRuns(doks, cf);
        const md = formatMarkdownLedger(result, doks, cf);

        // Verify escaped pipes
        assert.ok(md.includes('rule\\|with\\|pipes'));
        // Verify newlines sanitized to space
        assert.ok(!md.includes('src/ui\ncomponent.ts'));
        assert.ok(md.includes('src/ui component.ts'));

        // Check table row delimiter integrity: standard 3-column table has 4 unescaped pipes
        const rows = md.split('\n').filter((l) => l.includes('DOKS Only'));
        for (const row of rows) {
          const unescapedPipes = (row.match(/(?<!\\)\|/g) || []).length;
          assert.equal(unescapedPipes, 4, `Row must have exactly 4 table delimiters: ${row}`);
        }
      });
    });

    describe('2.4 validateReceipt token schema validation', () => {
      const validReceipt = {
        orchestrator: 'doks',
        runId: 'doks_1',
        repo: 'exampleorg/core',
        prNumber: 1,
        headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        verdict: 'success',
        findingFingerprints: ['f1'],
        durationMs: 1000,
      };

      it('accepts valid tokensUsed with non-negative numbers', () => {
        const receipt = {
          ...validReceipt,
          tokensUsed: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
          },
        };
        const validated = validateReceipt(receipt, 'Test');
        assert.deepEqual(validated.tokensUsed, {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        });
      });

      it('rejects tokensUsed when not an object (primitive, array, null)', () => {
        assert.throws(
          () => validateReceipt({ ...validReceipt, tokensUsed: 'invalid' }, 'Test'),
          /tokensUsed must be an object/
        );
        assert.throws(
          () => validateReceipt({ ...validReceipt, tokensUsed: null }, 'Test'),
          /tokensUsed must be an object/
        );
        assert.throws(
          () => validateReceipt({ ...validReceipt, tokensUsed: [100, 200] }, 'Test'),
          /tokensUsed must be an object/
        );
      });

      it('rejects tokensUsed when fields are missing or non-numeric', () => {
        assert.throws(
          () => validateReceipt({ ...validReceipt, tokensUsed: {} }, 'Test'),
          /tokensUsed\.promptTokens must be a non-negative number/
        );
        assert.throws(
          () => validateReceipt({ ...validReceipt, tokensUsed: { promptTokens: '100' } }, 'Test'),
          /tokensUsed\.promptTokens must be a non-negative number/
        );
        assert.throws(
          () =>
            validateReceipt(
              {
                ...validReceipt,
                tokensUsed: { promptTokens: 100, completionTokens: NaN, totalTokens: 100 },
              },
              'Test'
            ),
          /tokensUsed\.completionTokens must be a non-negative number/
        );
      });

      it('rejects tokensUsed when any field is negative', () => {
        assert.throws(
          () =>
            validateReceipt(
              {
                ...validReceipt,
                tokensUsed: { promptTokens: -1, completionTokens: 10, totalTokens: 9 },
              },
              'Test'
            ),
          /tokensUsed\.promptTokens must be a non-negative number/
        );
        assert.throws(
          () =>
            validateReceipt(
              {
                ...validReceipt,
                tokensUsed: { promptTokens: 10, completionTokens: -5, totalTokens: 5 },
              },
              'Test'
            ),
          /tokensUsed\.completionTokens must be a non-negative number/
        );
        assert.throws(
          () =>
            validateReceipt(
              {
                ...validReceipt,
                tokensUsed: { promptTokens: 10, completionTokens: 10, totalTokens: -20 },
              },
              'Test'
            ),
          /tokensUsed\.totalTokens must be a non-negative number/
        );
      });

      it('rejects tokensUsed when any field is Infinity or -Infinity', () => {
        assert.throws(
          () =>
            validateReceipt(
              {
                ...validReceipt,
                tokensUsed: { promptTokens: Infinity, completionTokens: 10, totalTokens: 100 },
              },
              'Test'
            ),
          /tokensUsed\.promptTokens must be a non-negative number/
        );
        assert.throws(
          () =>
            validateReceipt(
              {
                ...validReceipt,
                tokensUsed: { promptTokens: 10, completionTokens: -Infinity, totalTokens: 100 },
              },
              'Test'
            ),
          /tokensUsed\.completionTokens must be a non-negative number/
        );
        assert.throws(
          () =>
            validateReceipt(
              {
                ...validReceipt,
                tokensUsed: { promptTokens: 10, completionTokens: 10, totalTokens: Infinity },
              },
              'Test'
            ),
          /tokensUsed\.totalTokens must be a non-negative number/
        );
      });

      it('rejects durationMs when Infinity or -Infinity', () => {
        assert.throws(
          () => validateReceipt({ ...validReceipt, durationMs: Infinity }, 'Test'),
          /durationMs must be a non-negative number/
        );
        assert.throws(
          () => validateReceipt({ ...validReceipt, durationMs: -Infinity }, 'Test'),
          /durationMs must be a non-negative number/
        );
      });
    });
  });

  // =========================================================================
  // 3. Repository Concurrency Gate (RepoGateDO) Hardening
  // =========================================================================
  describe('3. Repository Concurrency Gate (RepoGateDO) Hardening', () => {
    it('captures synchronous queuePosition for concurrent callers', async () => {
      const state = new MockDurableObjectState();
      const gate = new RepoGateDO(state as any, {} as any);

      // Active run occupies concurrency slot
      const r0 = await gate.acquireSlot('run_active', 'sha_0', 1);
      assert.equal(r0.granted, true);

      // 5 concurrent requests arrive simultaneously
      const promises = [
        gate.acquireSlot('run_q1', 'sha_1', 2),
        gate.acquireSlot('run_q2', 'sha_2', 3),
        gate.acquireSlot('run_q3', 'sha_3', 4),
        gate.acquireSlot('run_q4', 'sha_4', 5),
        gate.acquireSlot('run_q5', 'sha_5', 6),
      ];

      const results = await Promise.all(promises);
      const positions = results.map((r) => r.queuePosition);
      // Because queuePosition was captured synchronously before await persistState(),
      // each concurrent arrival captures its distinct 1-indexed queue length at push time!
      assert.deepEqual(positions, [1, 2, 3, 4, 5]);
    });

    it('rejects an unseen run arriving for a tombstoned closed PR with evicted: true', async () => {
      const state = new MockDurableObjectState();
      const gate = new RepoGateDO(state as any, {} as any);

      // Slot is completely free
      const statusBefore = await gate.getStatus();
      assert.equal(statusBefore.activeCount, 0);

      // PR 99 is closed and tombstoned
      await gate.evictQueue({ prNumber: 99, tombstone: true });

      // An out-of-order webhook arrives with a completely new runId never seen before
      const res = await gate.acquireSlot('unseen_rogue_run', 'sha_late', 99);
      assert.equal(res.granted, false, 'Unseen run for tombstoned PR must NOT be granted');
      assert.equal(res.evicted, true, 'Unseen run for tombstoned PR must have evicted: true');

      // Concurrency slot must remain completely free
      const statusAfter = await gate.getStatus();
      assert.equal(statusAfter.activeCount, 0);
      assert.equal(statusAfter.queueLength, 0);
    });

    it('rejects a seen run arriving for a tombstoned closed PR with evicted: true', async () => {
      const state = new MockDurableObjectState();
      const gate = new RepoGateDO(state as any, {} as any);

      // Register run before closure
      await gate.registerRun('seen_run_before_close', 77);

      // Close PR 77
      await gate.evictQueue({ prNumber: 77, tombstone: true });

      const res = await gate.acquireSlot('seen_run_before_close', 'sha_close', 77);
      assert.equal(res.granted, false);
      assert.equal(res.evicted, true);
    });

    it('allows new runs to acquire slot after PR is reopened via clearEviction', async () => {
      const state = new MockDurableObjectState();
      const gate = new RepoGateDO(state as any, {} as any);

      // Tombstone PR 88
      await gate.evictQueue({ prNumber: 88, tombstone: true });
      const res1 = await gate.acquireSlot('run_fail', 'sha_1', 88);
      assert.equal(res1.granted, false);
      assert.equal(res1.evicted, true);

      // Reopen PR 88: clears eviction tombstone
      await gate.clearEviction(88);

      // New run can now acquire slot
      const res2 = await gate.acquireSlot('run_reopened', 'sha_2', 88);
      assert.equal(res2.granted, true);
      assert.equal(gate.getActiveRun(88), 'run_reopened');
    });
  });
});
