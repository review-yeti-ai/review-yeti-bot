import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import express, { Request, Response } from 'express';
import {
  computeGitHubSignature,
  verifyGitHubSignatureDetailed,
  verifyGitHubSignature,
  VerifySignatureOptions,
} from '../../src/github/signature';
import {
  createWebhookServer,
  createWebhookRouter,
  resolveWebhookSecret,
  RequestWithRawBody,
} from '../../src/github/webhookServer';
import {
  CommentPublisher,
  formatInlineCommentBody,
  PublishInlineCommentRequest,
  PublishReviewRequest,
} from '../../src/github/commentPublisher';
import { PersonaFinding } from '../../src/quorum/quorumEngine';

describe('Milestone 4 Challenger 1: Empirical Verification & Stress Test Suite', () => {
  const defaultSecret = 'empirical-test-secret-key-999';

  function createSig(body: string | Buffer | object, secret: string = defaultSecret): string {
    return computeGitHubSignature(body, secret);
  }

  // =========================================================================
  // 1. signature.ts & webhookServer.ts HMAC SHA-256 Validation & Stress Tests
  // =========================================================================
  describe('1. HMAC SHA-256 Signature Validation & Boundary Conditions', () => {
    it('1.1 Computes & verifies signatures over UTF-8 string, Buffer, and Object payloads', () => {
      const stringPayload = JSON.stringify({ action: 'opened', pr: 42 });
      const bufferPayload = Buffer.from(stringPayload, 'utf-8');
      const objectPayload = { action: 'opened', pr: 42 };

      const sigStr = createSig(stringPayload);
      const sigBuf = createSig(bufferPayload);
      const sigObj = createSig(objectPayload);

      expect(sigStr).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(sigStr).toBe(sigBuf);
      expect(sigStr).toBe(sigObj);

      expect(verifyGitHubSignature(sigStr, stringPayload, defaultSecret)).toBe(true);
      expect(verifyGitHubSignature(sigBuf, bufferPayload, defaultSecret)).toBe(true);
      expect(verifyGitHubSignature(sigObj, objectPayload, defaultSecret)).toBe(true);
    });

    it('1.2 Handles boundary payloads: empty string, empty buffer, empty object, null/undefined', () => {
      const emptyStrSig = createSig('');
      const emptyBufSig = createSig(Buffer.from(''));
      const emptyObjSig = createSig({});

      expect(emptyStrSig).toBe(emptyBufSig);
      expect(verifyGitHubSignature(emptyStrSig, '', defaultSecret)).toBe(true);
      expect(verifyGitHubSignature(emptyBufSig, Buffer.from(''), defaultSecret)).toBe(true);
      expect(verifyGitHubSignature(emptyObjSig, {}, defaultSecret)).toBe(true);

      // Undefined or null rawBody should fail with internal_error
      const nullRes = verifyGitHubSignatureDetailed({
        signatureHeader: emptyStrSig,
        rawBody: null as any,
        secret: defaultSecret,
      });
      expect(nullRes.isValid).toBe(false);
      expect(nullRes.reason).toBe('internal_error');
      expect(nullRes.error).toContain('Raw request body is missing');

      const undefRes = verifyGitHubSignatureDetailed({
        signatureHeader: emptyStrSig,
        rawBody: undefined as any,
        secret: defaultSecret,
      });
      expect(undefRes.isValid).toBe(false);
      expect(undefRes.reason).toBe('internal_error');
    });

    it('1.3 Detects payload alteration (byte manipulation / tampering)', () => {
      const rawPayload = JSON.stringify({ event: 'push', ref: 'refs/heads/main', commit: 'abcdef123456' });
      const sig = createSig(rawPayload);

      // 1. Single character change in JSON string
      const tamperedStr = JSON.stringify({ event: 'push', ref: 'refs/heads/main', commit: 'abcdef123457' });
      const res1 = verifyGitHubSignatureDetailed({
        signatureHeader: sig,
        rawBody: tamperedStr,
        secret: defaultSecret,
      });
      expect(res1.isValid).toBe(false);
      expect(res1.reason).toBe('mismatch');
      expect(res1.error).toBe('Signature hash does not match');

      // 2. Single byte modification in Buffer
      const rawBuf = Buffer.from(rawPayload, 'utf-8');
      const tamperedBuf = Buffer.from(rawBuf);
      tamperedBuf[tamperedBuf.length - 1] ^= 0xff; // Flip bits of last byte

      const res2 = verifyGitHubSignatureDetailed({
        signatureHeader: sig,
        rawBody: tamperedBuf,
        secret: defaultSecret,
      });
      expect(res2.isValid).toBe(false);
      expect(res2.reason).toBe('mismatch');
    });

    it('1.4 Handles non-UTF8 binary byte buffers and large payloads (1MB)', () => {
      // Binary non-UTF8 buffer containing raw bytes 0x00..0xFF
      const binaryBytes = Buffer.from([0x00, 0x80, 0xff, 0xfe, 0xfa, 0x01, 0x12, 0x42, 0x37]);
      const binarySig = createSig(binaryBytes);
      expect(verifyGitHubSignature(binarySig, binaryBytes, defaultSecret)).toBe(true);

      // Large 1MB buffer payload stress check
      const largeBuf = Buffer.alloc(1024 * 1024, 0x41); // 1MB of 'A'
      const largeSig = createSig(largeBuf);
      expect(verifyGitHubSignature(largeSig, largeBuf, defaultSecret)).toBe(true);
      
      // Tampering 1 byte in 1MB buffer
      const tamperedLargeBuf = Buffer.from(largeBuf);
      tamperedLargeBuf[500000] = 0x42;
      expect(verifyGitHubSignature(largeSig, tamperedLargeBuf, defaultSecret)).toBe(false);
    });

    it('1.5 Missing, array, empty, and malformed signature headers', () => {
      const payload = 'test-payload';
      const validSig = createSig(payload);

      // Missing header (undefined, empty string, whitespace)
      expect(verifyGitHubSignatureDetailed({ secret: defaultSecret, rawBody: payload }).reason).toBe('missing_header');
      expect(verifyGitHubSignatureDetailed({ signatureHeader: '', secret: defaultSecret, rawBody: payload }).reason).toBe('missing_header');
      expect(verifyGitHubSignatureDetailed({ signatureHeader: '   ', secret: defaultSecret, rawBody: payload }).reason).toBe('missing_header');

      // Array header format (e.g. ['sha256=...', 'sha256=...'])
      const arrayHeaderRes = verifyGitHubSignatureDetailed({
        signatureHeader: [validSig, 'sha256=invalid'],
        rawBody: payload,
        secret: defaultSecret,
      });
      expect(arrayHeaderRes.isValid).toBe(true);
      expect(arrayHeaderRes.reason).toBe('valid');

      // Malformed headers
      // Missing sha256= prefix
      expect(
        verifyGitHubSignatureDetailed({
          signatureHeader: validSig.replace('sha256=', ''),
          rawBody: payload,
          secret: defaultSecret,
        }).reason
      ).toBe('malformed_header');

      // Wrong prefix (sha1=, md5=)
      expect(
        verifyGitHubSignatureDetailed({
          signatureHeader: 'sha1=0123456789abcdef0123456789abcdef01234567',
          rawBody: payload,
          secret: defaultSecret,
        }).reason
      ).toBe('malformed_header');

      // Length mismatch (too short or too long hash)
      expect(
        verifyGitHubSignatureDetailed({
          signatureHeader: 'sha256=short',
          rawBody: payload,
          secret: defaultSecret,
        }).reason
      ).toBe('mismatch');

      expect(
        verifyGitHubSignatureDetailed({
          signatureHeader: 'sha256=' + 'a'.repeat(128),
          rawBody: payload,
          secret: defaultSecret,
        }).reason
      ).toBe('mismatch');
    });

    it('1.6 Webhook secret boundary checks & secret resolution priority', () => {
      // Empty / missing secret
      expect(() => computeGitHubSignature('payload', '')).toThrow('Webhook secret is required to compute signature');
      expect(() => computeGitHubSignature('payload', '   ')).toThrow('Webhook secret is required to compute signature');

      expect(verifyGitHubSignatureDetailed({ signatureHeader: 'sha256=123', rawBody: 'p', secret: '' }).reason).toBe('missing_secret');
      expect(verifyGitHubSignatureDetailed({ signatureHeader: 'sha256=123', rawBody: 'p', secret: '   ' }).reason).toBe('missing_secret');

      // resolveWebhookSecret priority: override > WEBHOOK_SECRET > GITHUB_WEBHOOK_SECRET > fallback
      const oldEnv1 = process.env.WEBHOOK_SECRET;
      const oldEnv2 = process.env.GITHUB_WEBHOOK_SECRET;

      try {
        process.env.WEBHOOK_SECRET = 'env-secret-1';
        process.env.GITHUB_WEBHOOK_SECRET = 'env-secret-2';

        expect(resolveWebhookSecret('override-secret')).toBe('override-secret');
        expect(resolveWebhookSecret('')).toBe('env-secret-1');

        delete process.env.WEBHOOK_SECRET;
        expect(resolveWebhookSecret('')).toBe('env-secret-2');

        delete process.env.GITHUB_WEBHOOK_SECRET;
        expect(resolveWebhookSecret('')).toBe('development-webhook-secret-key-12345');
      } finally {
        process.env.WEBHOOK_SECRET = oldEnv1;
        process.env.GITHUB_WEBHOOK_SECRET = oldEnv2;
      }
    });

    it('1.7 Constant-time comparison & timing safe execution over byte buffers', () => {
      const payload = 'constant-time-test-payload';
      const validSig = createSig(payload);
      
      // Construct a fake signature of exact same length (71 chars), matching 'sha256=' prefix,
      // but with invalid hex bytes at different positions (first byte vs last byte)
      const validHash = validSig.substring(7); // 64 hex chars
      
      // Flip first character of hex hash
      const earlyDiffChar = validHash[0] === 'a' ? 'b' : 'a';
      const earlyMismatchSig = 'sha256=' + earlyDiffChar + validHash.substring(1);

      // Flip last character of hex hash
      const lateDiffChar = validHash[63] === 'a' ? 'b' : 'a';
      const lateMismatchSig = 'sha256=' + validHash.substring(0, 63) + lateDiffChar;

      expect(earlyMismatchSig.length).toBe(validSig.length);
      expect(lateMismatchSig.length).toBe(validSig.length);

      // Run 1000 verification cycles to verify crypto.timingSafeEqual executes deterministically
      for (let i = 0; i < 1000; i++) {
        expect(verifyGitHubSignature(earlyMismatchSig, payload, defaultSecret)).toBe(false);
        expect(verifyGitHubSignature(lateMismatchSig, payload, defaultSecret)).toBe(false);
        expect(verifyGitHubSignature(validSig, payload, defaultSecret)).toBe(true);
      }
    });
  });

  // =========================================================================
  // 2. webhookServer.ts Express Integration & JSON Parsing Stress
  // =========================================================================
  describe('2. Express Webhook Server Integration & Error Handling', () => {
    let app: express.Express;

    beforeEach(() => {
      app = createWebhookServer({ secret: defaultSecret });
    });

    it('2.1 Rejects malformed JSON body with HTTP 400 Bad Request', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .send('{ "action": "opened", "malformed": ');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Bad Request',
        message: 'Invalid JSON body or malformed payload',
      });
    });

    it('2.2 Rejects POST /webhook with missing signature (HTTP 401)', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .send({ action: 'opened' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid or missing signature' });
    });

    it('2.3 Rejects POST /webhook with invalid signature hash (HTTP 401)', async () => {
      const payload = { action: 'opened' };
      const res = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', 'sha256=0000000000000000000000000000000000000000000000000000000000000000')
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid or missing signature' });
    });

    it('2.4 Responds HTTP 200 OK pong to GitHub ping event', async () => {
      const payload = { zen: 'Responsive to webhooks' };
      const sig = createSig(payload);

      const res = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'ping')
        .set('X-Hub-Signature-256', sig)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'pong' });
    });

    it('2.5 Delegates to custom onEvent callback and returns handler response', async () => {
      const customApp = createWebhookServer({
        secret: defaultSecret,
        onEvent: async (req: RequestWithRawBody) => {
          expect(req.rawBody).toBeDefined();
          return { status: 'handled_custom', pr: req.body.number };
        },
      });

      const payload = { action: 'opened', number: 888 };
      const sig = createSig(payload);

      const res = await request(customApp)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sig)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'handled_custom', pr: 888 });
    });

    it('2.6 Returns HTTP 500 Internal Server Error when onEvent throws an exception', async () => {
      const errorApp = createWebhookServer({
        secret: defaultSecret,
        onEvent: async () => {
          throw new Error('Empirical handler crash test');
        },
      });

      const payload = { action: 'opened' };
      const sig = createSig(payload);

      const res = await request(errorApp)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sig)
        .send(payload);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: 'Internal Server Error',
        message: 'Empirical handler crash test',
      });
    });
  });

  // =========================================================================
  // 3. commentPublisher.ts Rate Limiting, Backoff, Deduplication & Formatting
  // =========================================================================
  describe('3. CommentPublisher — Rate Limits, Retry Backoff, Deduplication & Suggestions', () => {
    let mockFetch: any;

    beforeEach(() => {
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('3.1 formatInlineCommentBody emoji mapping for security, architecture, performance, quality, and unknown', () => {
      const personas = [
        { name: 'security', emoji: '🛡️' },
        { name: 'architecture', emoji: '📐' },
        { name: 'performance', emoji: '⚡' },
        { name: 'quality', emoji: '🔍' },
        { name: 'UNKNOWN_PERSONA', emoji: '🤖' },
      ];

      for (const p of personas) {
        const finding: PersonaFinding = {
          persona: p.name,
          severity: 'major',
          filePath: 'src/main.ts',
          lineNumber: 10,
          comment: `Finding comment for ${p.name}`,
        };

        const formatted = formatInlineCommentBody(finding);
        expect(formatted).toContain(`### ${p.emoji} [${p.name.toUpperCase()}] Severity: MAJOR`);
        expect(formatted).toContain(`Finding comment for ${p.name}`);
      }
    });

    it('3.2 formatInlineCommentBody code block formatting with suggestion vs codeSnippet vs neither', () => {
      // 1. suggestion provided
      const f1: PersonaFinding = {
        persona: 'quality',
        severity: 'minor',
        filePath: 'src/a.ts',
        lineNumber: 5,
        comment: 'Fix typo',
        suggestion: 'const name = "fixed";',
      };
      const fmt1 = formatInlineCommentBody(f1);
      expect(fmt1).toContain('```suggestion\nconst name = "fixed";\n```');

      // 2. codeSnippet provided (fallback)
      const f2: PersonaFinding = {
        persona: 'quality',
        severity: 'minor',
        filePath: 'src/a.ts',
        lineNumber: 5,
        comment: 'Refactor snippet',
        codeSnippet: 'const name = "snippet";',
      };
      const fmt2 = formatInlineCommentBody(f2);
      expect(fmt2).toContain('```suggestion\nconst name = "snippet";\n```');

      // 3. both suggestion and codeSnippet provided -> suggestion takes precedence
      const f3: PersonaFinding = {
        persona: 'quality',
        severity: 'minor',
        filePath: 'src/a.ts',
        lineNumber: 5,
        comment: 'Precedence test',
        suggestion: 'const name = "suggestion_wins";',
        codeSnippet: 'const name = "snippet_loses";',
      };
      const fmt3 = formatInlineCommentBody(f3);
      expect(fmt3).toContain('```suggestion\nconst name = "suggestion_wins";\n```');
      expect(fmt3).not.toContain('snippet_loses');

      // 4. neither provided -> no ```suggestion block
      const f4: PersonaFinding = {
        persona: 'quality',
        severity: 'minor',
        filePath: 'src/a.ts',
        lineNumber: 5,
        comment: 'No suggestion test',
      };
      const fmt4 = formatInlineCommentBody(f4);
      expect(fmt4).not.toContain('```suggestion');
    });

    it('3.3 Retries on HTTP 429 using Retry-After header and succeeds on retry attempt', async () => {
      // 1st attempt: HTTP 429 with Retry-After: 1
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '1' }),
        text: async () => 'Rate limit exceeded',
      });

      // 2nd attempt: HTTP 200 OK
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-ratelimit-remaining': '4500' }),
        json: async () => ({ id: 701 }),
      });

      const publisher = new CommentPublisher({
        baseUrl: 'http://api.github.test',
        initialRetryDelayMs: 10,
        maxRetries: 2,
        maxDelayMs: 100,
      });

      const startTime = Date.now();
      const res = await publisher.publishReview({
        owner: 'owner',
        repo: 'repo',
        prNumber: 10,
        commitSha: 'sha1',
        event: 'APPROVE',
        body: 'Approved',
      });

      const elapsed = Date.now() - startTime;
      expect(res.success).toBe(true);
      expect(res.reviewId).toBe(701);
      expect(res.rateLimitRemaining).toBe(4500);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(elapsed).toBeGreaterThanOrEqual(10); // Verified backoff delay executed
    });

    it('3.4 Retries on HTTP 403 using X-RateLimit-Reset timestamp header', async () => {
      const resetUnixSeconds = Math.floor((Date.now() + 50) / 1000);

      // 1st attempt: HTTP 403 with x-ratelimit-reset
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'x-ratelimit-reset': resetUnixSeconds.toString() }),
        text: async () => 'Secondary rate limit',
      });

      // 2nd attempt: HTTP 200 OK
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-ratelimit-remaining': '4900' }),
        json: async () => ({ id: 702 }),
      });

      const publisher = new CommentPublisher({
        baseUrl: 'http://api.github.test',
        initialRetryDelayMs: 10,
        maxRetries: 2,
        maxDelayMs: 100,
      });

      const res = await publisher.publishReview({
        owner: 'owner',
        repo: 'repo',
        prNumber: 10,
        commitSha: 'sha1',
        event: 'COMMENT',
        body: 'Comment',
      });

      expect(res.success).toBe(true);
      expect(res.reviewId).toBe(702);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('3.5 Fails after maxRetries attempts on persistent HTTP 429', async () => {
      // Return HTTP 429 for all calls
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '0' }),
        text: async () => 'Rate limit exhausted',
      });

      const publisher = new CommentPublisher({
        baseUrl: 'http://api.github.test',
        initialRetryDelayMs: 1,
        maxRetries: 2,
        maxDelayMs: 10,
      });

      const res = await publisher.publishReview({
        owner: 'owner',
        repo: 'repo',
        prNumber: 10,
        commitSha: 'sha1',
        event: 'REQUEST_CHANGES',
        body: 'Denied',
      });

      expect(res.success).toBe(false);
      expect(res.errors).toBeDefined();
      expect(res.errors?.[0]).toContain('HTTP 429: Rate limit exhausted');
      // Initial call + 2 retries = 3 calls total
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('3.6 Non-retryable HTTP errors (e.g. 400, 401, 404, 422) return immediately without retrying', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        headers: new Headers(),
        text: async () => 'Validation Failed: line is outside diff',
      });

      const publisher = new CommentPublisher({
        baseUrl: 'http://api.github.test',
        initialRetryDelayMs: 10,
        maxRetries: 3,
      });

      const res = await publisher.publishReview({
        owner: 'owner',
        repo: 'repo',
        prNumber: 10,
        commitSha: 'sha1',
        event: 'APPROVE',
        body: 'Approved',
      });

      expect(res.success).toBe(false);
      expect(res.errors?.[0]).toContain('HTTP 422: Validation Failed');
      expect(mockFetch).toHaveBeenCalledTimes(1); // No retries performed!
    });

    it('3.7 Edge Case: Non-integer Retry-After header (e.g., HTTP Date string)', async () => {
      // HTTP Date string in Retry-After header
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
        text: async () => 'Rate limit exceeded',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ id: 703 }),
      });

      const publisher = new CommentPublisher({
        baseUrl: 'http://api.github.test',
        initialRetryDelayMs: 5,
        maxRetries: 1,
        maxDelayMs: 50,
      });

      // Should not throw or crash when parseInt returns NaN
      const res = await publisher.publishReview({
        owner: 'owner',
        repo: 'repo',
        prNumber: 10,
        commitSha: 'sha1',
        event: 'APPROVE',
        body: 'Approved',
      });

      expect(res.success).toBe(true);
      expect(res.reviewId).toBe(703);
    });

    it('3.8 Deduplicates inline comments when matching comment already exists on PR', async () => {
      // 1. Mock GET existing comments -> returns 1 comment on src/index.ts line 15 with persona [SECURITY]
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            path: 'src/index.ts',
            line: 15,
            body: '### 🛡️ [SECURITY] Severity: CRITICAL\nPotential SQL Injection',
          },
        ],
        headers: new Headers(),
      });

      const publisher = new CommentPublisher({ baseUrl: 'http://api.github.test' });

      const req: PublishInlineCommentRequest = {
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        prNumber: 50,
        commitSha: 'sha-sec',
        path: 'src/index.ts',
        line: 15,
        finding: {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/index.ts',
          lineNumber: 15,
          comment: 'Potential SQL Injection',
        },
      };

      const res = await publisher.publishInlineComment(req);

      expect(res.success).toBe(true);
      expect(res.commentsCreated).toBe(0); // Duplicate skipped!
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only GET called, POST skipped!
    });

    it('3.9 Supports c.position fallback matching for existing comments during deduplication', async () => {
      // GitHub API legacy response with position instead of line
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            path: 'src/utils.ts',
            position: 30, // position instead of line
            body: '### 📐 [ARCHITECTURE] Severity: MAJOR\nLayer violation',
          },
        ],
        headers: new Headers(),
      });

      const publisher = new CommentPublisher({ baseUrl: 'http://api.github.test' });

      const req: PublishInlineCommentRequest = {
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        prNumber: 51,
        commitSha: 'sha-arch',
        path: 'src/utils.ts',
        line: 30,
        finding: {
          persona: 'architecture',
          severity: 'major',
          filePath: 'src/utils.ts',
          lineNumber: 30,
          comment: 'Layer violation',
        },
      };

      const res = await publisher.publishInlineComment(req);

      expect(res.success).toBe(true);
      expect(res.commentsCreated).toBe(0); // Position match deduplicated!
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('3.10 Gracefully falls back and attempts POST when getExistingComments fails', async () => {
      // 1. Mock GET existing comments -> HTTP 500 error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
        headers: new Headers(),
      });

      // 2. Mock POST inline comment -> HTTP 201 Created
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 9999 }),
        headers: new Headers({ 'x-ratelimit-remaining': '4999' }),
      });

      const publisher = new CommentPublisher({ baseUrl: 'http://api.github.test' });

      const req: PublishInlineCommentRequest = {
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        prNumber: 52,
        commitSha: 'sha-fallback',
        path: 'src/fallback.ts',
        line: 1,
        finding: {
          persona: 'quality',
          severity: 'minor',
          filePath: 'src/fallback.ts',
          lineNumber: 1,
          comment: 'Fallback test',
        },
      };

      const res = await publisher.publishInlineComment(req);

      expect(res.success).toBe(true);
      expect(res.commentsCreated).toBe(1); // Proceeded with POST despite GET failure
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
