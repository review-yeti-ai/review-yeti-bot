import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
const { Client } = pg;
import {
  assemblePrepPrompt,
  persistPrepState,
  MAX_PREPARED_REVIEW_BYTES,
  type PrepPayload,
} from '../../src/review/prepPhase';

/**
 * Validates whether a JavaScript string contains any lone UTF-16 surrogates.
 * Returns true if the string is well-formed (no lone surrogates), false otherwise.
 */
function isWellFormedUnicode(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: must be followed by a low surrogate
      if (i + 1 >= str.length) return false;
      const next = str.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++; // Skip low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Unpaired low surrogate
      return false;
    }
  }
  return true;
}

describe('Challenger M2 Iteration 2 Gate: Adversarial UTF-8 Surrogates & PostgreSQL JSONB Stress Suite', () => {
  let client: pg.Client | null = null;
  let hasRealPostgres = false;

  beforeEach(async () => {
    if (!client) {
      try {
        client = new Client({
          host: 'localhost',
          port: 5432,
          user: 'calltelemetry',
          password: 'calltelemetry_dev_password',
          database: 'postgres',
        });
        await client.connect();
        hasRealPostgres = true;

        await client.query(`
          CREATE TEMP TABLE IF NOT EXISTS review_runs (
            run_id VARCHAR(255) PRIMARY KEY,
            status VARCHAR(32),
            artifacts JSONB DEFAULT '{}'::jsonb,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TEMP TABLE IF NOT EXISTS review_run_artifacts (
            run_id VARCHAR(255) NOT NULL,
            stage VARCHAR(32) NOT NULL,
            content_digest VARCHAR(64) NOT NULL,
            payload JSONB NOT NULL,
            byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 2000000),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (run_id, stage)
          );
        `);
      } catch (err) {
        console.warn('PostgreSQL connection not available for stress suite:', err);
        hasRealPostgres = false;
      }
    }
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  // =========================================================================
  // SECTION 1: 4-Byte Emojis Positioned Directly at the 256KB Truncation Boundary
  // =========================================================================
  describe('1. 4-Byte Emojis Across Boundary Offsets', () => {
    const testEmojis = [
      { name: 'Fox Face (🦊, U+1F98A)', emoji: '🦊', utf8Bytes: 4 },
      { name: 'Rocket (🚀, U+1F680)', emoji: '🚀', utf8Bytes: 4 },
      { name: 'CJK Ext-B (𠀀, U+20000)', emoji: '𠀀', utf8Bytes: 4 },
      { name: 'Family ZWJ Sequence (👨‍👩‍👧‍👦)', emoji: '👨‍👩‍👧‍👦', utf8Bytes: 25 },
      { name: 'US Flag (🇺🇸)', emoji: '🇺🇸', utf8Bytes: 8 },
    ];

    for (const { name, emoji } of testEmojis) {
      it(`ADV-EMOJI-01: Boundary offset sweep for ${name}`, async () => {
        // Measure baseline overhead of assemblePrepPrompt header
        const probe = assemblePrepPrompt({
          repo: 'calltelemetry/review-yeti-bot',
          prNumber: 1,
          headSha: '0'.repeat(40),
          astSymbols: [],
          changedFiles: [{ path: 'test.txt', patch: '' }],
          maxBytes: MAX_PREPARED_REVIEW_BYTES,
        });
        const baseLen = Buffer.byteLength(probe.messages[1].content as string, 'utf8');

        // Test boundary offsets from -8 to +8 bytes around 256KB
        for (let offset = -8; offset <= 8; offset++) {
          const targetPrefixBytes = MAX_PREPARED_REVIEW_BYTES - baseLen + offset;
          if (targetPrefixBytes < 0) continue;

          // Fill prefix with ASCII 'A'
          const prefix = 'A'.repeat(targetPrefixBytes);
          const patch = prefix + emoji + 'TRAIL_DATA_EXCEEDING_LIMIT'.repeat(100);

          const { messages, truncated } = assemblePrepPrompt({
            repo: 'calltelemetry/review-yeti-bot',
            prNumber: 1,
            headSha: '0'.repeat(40),
            astSymbols: ['sym1'],
            changedFiles: [{ path: 'test.txt', patch }],
            maxBytes: MAX_PREPARED_REVIEW_BYTES,
          });

          expect(truncated).toBe(true);
          const userContent = messages[1].content as string;

          // 1. Invariant: MUST be well-formed Unicode (zero lone surrogates)
          const wellFormed = isWellFormedUnicode(userContent);
          expect(wellFormed).toBe(true);

          // 2. Invariant: MUST NOT end with replacement character \uFFFD
          const marker = '\n[TRUNCATED: MaxPreparedReviewBytes exceeded]';
          expect(userContent.endsWith(marker)).toBe(true);
          const slicedContent = userContent.slice(0, userContent.length - marker.length);
          expect(slicedContent.endsWith('\uFFFD')).toBe(false);

          // 3. Invariant: Pre-marker byte length MUST NOT exceed MAX_PREPARED_REVIEW_BYTES
          const preMarkerBytes = Buffer.byteLength(slicedContent, 'utf8');
          expect(preMarkerBytes).toBeLessThanOrEqual(MAX_PREPARED_REVIEW_BYTES);

          // 4. Invariant: JSON serialization round-trip
          const serialized = JSON.stringify(messages);
          expect(serialized).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F])/); // No lone high surrogates
          expect(JSON.parse(serialized)).toEqual(messages);

          // 5. Invariant: Real PostgreSQL $1::jsonb acceptance
          if (hasRealPostgres && client) {
            const runId = `run-adv-emoji-${name.slice(0, 3)}-${offset}`;
            const payload: PrepPayload = {
              runId,
              headSha: '0'.repeat(40),
              baseSha: '0'.repeat(40),
              repository: 'calltelemetry/review-yeti-bot',
              prNumber: 1,
              triageSummary: { filesCount: 1, hunksCount: 1, astSymbols: ['sym1'], truncated: true },
              promptMessages: messages,
              createdAt: new Date().toISOString(),
            };

            await client.query('INSERT INTO review_runs (run_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING', [payload.runId, 'queued']);
            await persistPrepState(client, payload);

            const res = await client.query('SELECT artifacts->\'prep_payload\' as p FROM review_runs WHERE run_id = $1', [payload.runId]);
            expect(res.rows[0].p.promptMessages[1].content).toBe(userContent);
          }
        }
      });
    }
  });

  // =========================================================================
  // SECTION 2: Large Multi-Byte CJK Diffs Exceeding 256KB
  // =========================================================================
  describe('2. Multi-Byte CJK Diffs Exceeding 256KB', () => {
    it('ADV-CJK-01: 100,000 Chinese characters (300,000 bytes) truncated cleanly without split code points', async () => {
      // 3 bytes per character: 審 (U+5BE9 = E5 AF A9)
      const cjkPatch = '審'.repeat(100_000);
      const { messages, truncated } = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 88,
        headSha: 'cjk123',
        astSymbols: ['triageFunction'],
        changedFiles: [{ path: 'chinese.txt', patch: cjkPatch }],
        maxBytes: MAX_PREPARED_REVIEW_BYTES,
      });

      expect(truncated).toBe(true);
      const userContent = messages[1].content as string;

      expect(isWellFormedUnicode(userContent)).toBe(true);
      const marker = '\n[TRUNCATED: MaxPreparedReviewBytes exceeded]';
      const slicedContent = userContent.slice(0, userContent.length - marker.length);
      expect(slicedContent.endsWith('\uFFFD')).toBe(false);
      expect(Buffer.byteLength(slicedContent, 'utf8')).toBeLessThanOrEqual(MAX_PREPARED_REVIEW_BYTES);

      // Verify PostgreSQL insertion
      if (hasRealPostgres && client) {
        const payload: PrepPayload = {
          runId: 'run-cjk-100k',
          headSha: 'cjk123',
          baseSha: '0'.repeat(40),
          repository: 'calltelemetry/review-yeti-bot',
          prNumber: 88,
          triageSummary: { filesCount: 1, hunksCount: 1, astSymbols: ['triageFunction'], truncated: true },
          promptMessages: messages,
          createdAt: new Date().toISOString(),
        };
        await client.query('INSERT INTO review_runs (run_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING', [payload.runId, 'queued']);
        await persistPrepState(client, payload);

        const res = await client.query('SELECT artifacts->\'prep_payload\' as p FROM review_runs WHERE run_id = $1', [payload.runId]);
        expect(res.rows[0].p.promptMessages[1].content).toBe(userContent);
      }
    });

    it('ADV-CJK-02: 3-byte CJK boundary alignment offsets (256KB - 3, -2, -1, 0, +1, +2, +3)', async () => {
      const probe = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 1,
        headSha: '0'.repeat(40),
        astSymbols: [],
        changedFiles: [{ path: 'test.txt', patch: '' }],
        maxBytes: MAX_PREPARED_REVIEW_BYTES,
      });
      const baseLen = Buffer.byteLength(probe.messages[1].content as string, 'utf8');

      for (let offset = -6; offset <= 6; offset++) {
        const prefixLen = MAX_PREPARED_REVIEW_BYTES - baseLen + offset;
        if (prefixLen < 0) continue;

        const patch = 'X'.repeat(prefixLen) + '漢字測試'.repeat(2000);
        const { messages, truncated } = assemblePrepPrompt({
          repo: 'calltelemetry/review-yeti-bot',
          prNumber: 1,
          headSha: '0'.repeat(40),
          astSymbols: [],
          changedFiles: [{ path: 'test.txt', patch }],
          maxBytes: MAX_PREPARED_REVIEW_BYTES,
        });

        expect(truncated).toBe(true);
        const userContent = messages[1].content as string;
        expect(isWellFormedUnicode(userContent)).toBe(true);
        const marker = '\n[TRUNCATED: MaxPreparedReviewBytes exceeded]';
        const slicedContent = userContent.slice(0, userContent.length - marker.length);
        expect(slicedContent.endsWith('\uFFFD')).toBe(false);
        expect(Buffer.byteLength(slicedContent, 'utf8')).toBeLessThanOrEqual(MAX_PREPARED_REVIEW_BYTES);
      }
    });
  });

  // =========================================================================
  // SECTION 3: Null Bytes in Binary Diffs & PostgreSQL Sanitization
  // =========================================================================
  describe('3. Null Bytes Sanitization & PostgreSQL Insertion', () => {
    it('ADV-NULL-01: strips null bytes \\0 from binary diffs and preserves JSONB validity', async () => {
      const binaryWithNulls = 'diff --git a/bin.dat b/bin.dat\n' +
        '+header\x00data\x00\x00\x00trailer\x00' +
        'more bytes\x00\x01\x02\x00';

      const { messages } = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 1,
        headSha: '0'.repeat(40),
        astSymbols: ['binParser\x00Invalid', 'cleanSymbol'],
        changedFiles: [{ path: 'bin\x00ary.dat', patch: binaryWithNulls }],
      });

      const userContent = messages[1].content as string;
      // All \0 should be stripped from userContent
      expect(userContent).not.toContain('\x00');
      expect(userContent).toContain('headerdatatrailer');

      if (hasRealPostgres && client) {
        const payload: PrepPayload = {
          runId: 'run-null-bytes-01',
          headSha: '0'.repeat(40),
          baseSha: '0'.repeat(40),
          repository: 'calltelemetry/review-yeti-bot',
          prNumber: 1,
          triageSummary: { filesCount: 1, hunksCount: 1, astSymbols: ['cleanSymbol'], truncated: false },
          promptMessages: messages,
          createdAt: new Date().toISOString(),
        };

        await client.query('INSERT INTO review_runs (run_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING', [payload.runId, 'queued']);
        await persistPrepState(client, payload);

        // Verify read back succeeds without 22P05 error
        const res = await client.query('SELECT artifacts->\'prep_payload\' as p FROM review_runs WHERE run_id = $1', [payload.runId]);
        expect(res.rows[0].p.runId).toBe('run-null-bytes-01');
      }
    });

    it('ADV-NULL-02: handles null bytes positioned directly at the 256KB boundary', () => {
      const probe = assemblePrepPrompt({
        repo: 'test/repo',
        prNumber: 1,
        headSha: '0'.repeat(40),
        astSymbols: [],
        changedFiles: [{ path: 'test.txt', patch: '' }],
        maxBytes: MAX_PREPARED_REVIEW_BYTES,
      });
      const baseLen = Buffer.byteLength(probe.messages[1].content as string, 'utf8');
      const targetPrefix = MAX_PREPARED_REVIEW_BYTES - baseLen;

      // Place multiple null bytes at and around the boundary
      const patch = 'B'.repeat(targetPrefix - 2) + '\x00\x00\x00\x00' + 'C'.repeat(500);
      const { messages, truncated } = assemblePrepPrompt({
        repo: 'test/repo',
        prNumber: 1,
        headSha: '0'.repeat(40),
        astSymbols: [],
        changedFiles: [{ path: 'test.txt', patch }],
        maxBytes: MAX_PREPARED_REVIEW_BYTES,
      });

      const userContent = messages[1].content as string;
      expect(userContent).not.toContain('\x00');
      expect(isWellFormedUnicode(userContent)).toBe(true);
      expect(truncated).toBe(true);
    });
  });

  // =========================================================================
  // SECTION 4: PostgreSQL JSONB Payload Syntax & Round-Trip Fidelity
  // =========================================================================
  describe('4. PostgreSQL JSONB Syntax & Round-Trip Integrity', () => {
    it('ADV-JSONB-01: verifies round-trip fidelity with extreme JSON special characters', async () => {
      if (!hasRealPostgres || !client) return;

      const extremeDiff = [
        '+const jsonStr = "{\\"quotes\\": \\"escaped\\", \\"slash\\\\path\\": true}";',
        '+const backticks = `multi\nline\r\ntab\tstring`;',
        '+const html = "<script>alert(\'test & encode\')</script>";',
        '+const emojiDiff = "+added 🚀 🦊 👨‍👩‍👧‍👦 𠀀 🇺🇸";',
      ].join('\n');

      const { messages } = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 99,
        headSha: 'extreme-sha-123',
        astSymbols: ['alert', 'jsonStr', 'slash$path'],
        changedFiles: [{ path: 'src/extreme.ts', patch: extremeDiff }],
      });

      const payload: PrepPayload = {
        runId: 'run-extreme-jsonb',
        headSha: 'extreme-sha-123',
        baseSha: 'base-sha-456',
        repository: 'calltelemetry/review-yeti-bot',
        prNumber: 99,
        triageSummary: {
          filesCount: 1,
          hunksCount: 1,
          astSymbols: ['alert', 'jsonStr', 'slash$path'],
          truncated: false,
        },
        promptMessages: messages,
        metadata: {
          specialChars: '"\'\\/\b\f\n\r\t',
          nested: { validJson: true, numbers: [1, 2.5, -42, 1e10] },
        },
        createdAt: new Date().toISOString(),
      };

      await client.query('INSERT INTO review_runs (run_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING', [payload.runId, 'queued']);
      await persistPrepState(client, payload);

      // Verify review_runs payload
      const runRes = await client.query('SELECT artifacts->\'prep_payload\' as p FROM review_runs WHERE run_id = $1', [payload.runId]);
      expect(runRes.rows[0].p).toEqual(payload);

      // Verify review_run_artifacts payload
      const artRes = await client.query('SELECT payload FROM review_run_artifacts WHERE run_id = $1 AND stage = $2', [payload.runId, 'prep_state']);
      expect(artRes.rows[0].payload).toEqual(payload);
    });
  });
});
