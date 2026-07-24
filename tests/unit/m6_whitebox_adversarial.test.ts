import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderPool, ProviderPoolExhaustedError, ProviderNode } from '../../src/router/providerPool';
import { TokenManager, SecureSecretStore, TokenRefreshManager } from '../../src/router/tokenManager';
import { OmniRouteAdapter, OpenAIAdapter } from '../../src/router/omniRouteAdapter';
import { deduplicateAcrossPersonas, aggregateQuorumConsensus, buildPRSummaryMarkdown } from '../../src/quorum/consensus';
import { evaluateQuorum } from '../../src/quorum/quorumEngine';
import { verifyGitHubSignatureDetailed, computeGitHubSignature } from '../../src/github/signature';
import { createWebhookServer, createWebhookRouter } from '../../src/github/webhookServer';
import { CommentPublisher } from '../../src/github/commentPublisher';
import { GitHubEventHandler } from '../../src/github/eventHandler';
import request from 'supertest';

describe('Tier 5 White-Box Adversarial Hardening Verification Suite', () => {
  describe('1. Total LLM Provider Pool Exhaustion & HTTP Status Failure Modes', () => {
    it('throws ProviderPoolExhaustedError when all providers trip circuit breaker or are excluded', async () => {
      const pool = new ProviderPool('priority_fallback');
      pool.registerProvider({ id: 'openai', name: 'OpenAI', priority: 1 });
      pool.registerProvider({ id: 'anthropic', name: 'Anthropic', priority: 2 });

      // Trip OpenAI circuit with 429
      const openai = pool.getProvider('openai')!;
      openai.recordFailure(429, 'Rate limit exceeded');

      // Trip Anthropic circuit with 3 consecutive 500s
      const anthropic = pool.getProvider('anthropic')!;
      anthropic.recordFailure(500, 'Internal server error 1');
      anthropic.recordFailure(500, 'Internal server error 2');
      anthropic.recordFailure(500, 'Internal server error 3');

      expect(openai.circuitState).toBe('OPEN');
      expect(anthropic.circuitState).toBe('OPEN');

      expect(() => pool.selectProvider()).toThrow(ProviderPoolExhaustedError);

      await expect(
        pool.executeWithFailover(async (p) => {
          throw new Error('Should not reach here');
        })
      ).rejects.toThrow(ProviderPoolExhaustedError);
    });

    it('verifies fix: HTTP 401 client errors trip circuit breaker and mark provider cooling down', () => {
      const pool = new ProviderPool();
      pool.registerProvider({ id: 'openai', name: 'OpenAI', priority: 1 });
      const openai = pool.getProvider('openai')!;

      // Simulate 401 Unauthorized error (e.g. expired/invalid API key)
      openai.recordFailure(401, 'Unauthorized');

      expect(openai.metrics.consecutiveFailures).toBe(1);
      expect(openai.circuitState).toBe('OPEN');
      expect(openai.healthState).toBe('cooling_down');
      expect(openai.isAvailable()).toBe(false);
    });
  });

  describe('2. OAuth Token Refresh Single-Flight Mutex & Expiry Window', () => {
    it('deduplicates concurrent refresh requests via single-flight mutex promise', async () => {
      const store = new SecureSecretStore('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
      const manager = new TokenRefreshManager(store);

      let refreshCount = 0;
      manager.registerRefreshConfig({
        providerId: 'google',
        customRefreshHandler: async () => {
          refreshCount++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            accessToken: `new-access-token-${refreshCount}`,
            expiresAt: Date.now() + 3600000,
          };
        },
      });

      // Fire 5 concurrent token refresh calls
      const results = await Promise.all([
        manager.refreshAccessToken('google'),
        manager.refreshAccessToken('google'),
        manager.refreshAccessToken('google'),
        manager.refreshAccessToken('google'),
        manager.refreshAccessToken('google'),
      ]);

      expect(refreshCount).toBe(1); // Single-flight mutex executed handler exactly ONCE
      results.forEach((token) => expect(token).toBe('new-access-token-1'));
    });

    it('cleans up inFlightRefreshes map when refresh handler throws an error', async () => {
      const store = new SecureSecretStore();
      const manager = new TokenRefreshManager(store);

      manager.registerRefreshConfig({
        providerId: 'failing_provider',
        customRefreshHandler: async () => {
          throw new Error('Network timeout during token endpoint call');
        },
      });

      await expect(manager.refreshAccessToken('failing_provider')).rejects.toThrow('Network timeout');

      // Second attempt should re-try rather than hanging on a stale rejected promise
      await expect(manager.refreshAccessToken('failing_provider')).rejects.toThrow('Network timeout');
    });
  });

  describe('3. Persona Consensus Tie-Breaking & Verdict Precedence', () => {
    it('uses PERSONA_PRECEDENCE to break ties when deduplicating identical severity findings', () => {
      const rawFindings = [
        {
          persona: 'architecture' as const,
          severity: 'major' as const,
          filePath: 'src/core.ts',
          lineNumber: 42,
          comment: 'Architectural coupling concern',
        },
        {
          persona: 'security' as const,
          severity: 'major' as const,
          filePath: 'src/core.ts',
          lineNumber: 43,
          comment: 'Security authorization check missing',
        },
      ];

      const deduplicated = deduplicateAcrossPersonas(rawFindings);
      expect(deduplicated).toHaveLength(1);
      expect(deduplicated[0].persona).toBe('security'); // Security precedence (4) > Architecture (3)
      expect(deduplicated[0].coSponsoringPersonas).toContain('architecture');
    });

    it('overrides APPROVE verdict to REQUEST_CHANGES on strict ticket failure or constitution violation', async () => {
      const result = await aggregateQuorumConsensus({
        repoOwner: 'calltelemetry',
        repoName: 'ai-workspace',
        prNumber: 100,
        headSha: 'head123',
        baseSha: 'base123',
        config: {
          quorum: { minApprovals: 1, personas: ['quality'] },
          ticketEnforcement: { mode: 'strict' },
          constitution: { enabled: false },
        } as any,
        ticketResult: { valid: false, mode: 'strict', ticketsFound: [], error: 'No ticket referenced' },
        personaFindingsMap: {
          quality: [], // Quality persona votes APPROVE
        } as any,
      });

      expect(result.decision).toBe('REQUEST_CHANGES'); // Ticket failure overrides approval!
    });
  });

  describe('4. Webhook Malformed Payloads & Signature Verification Order', () => {
    it('returns 400 Bad Request on malformed JSON payload before signature check in current middleware order', async () => {
      const app = createWebhookServer({ secret: 'test-secret' });

      // Send malformed JSON string with invalid syntax
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .send('{"invalid_json": '); // Syntax error

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Bad Request');
      // DEMONSTRATED BEHAVIOR: Express json parser runs BEFORE HMAC signature check, returning 400 for unauthenticated malformed JSON.
    });

    it('verifies valid HMAC signature and rejects invalid signatures', () => {
      const payload = { zen: 'Responsive is better than fast.' };
      const secret = 'super-secret-key';
      const validSig = computeGitHubSignature(payload, secret);

      const validResult = verifyGitHubSignatureDetailed({
        signatureHeader: validSig,
        rawBody: JSON.stringify(payload),
        secret,
      });
      expect(validResult.isValid).toBe(true);

      const invalidResult = verifyGitHubSignatureDetailed({
        signatureHeader: 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        rawBody: JSON.stringify(payload),
        secret,
      });
      expect(invalidResult.isValid).toBe(false);
      expect(invalidResult.reason).toBe('mismatch');
    });
  });

  describe('5. CommentPublisher GitHub API Integration & Retry Logic', () => {
    it('executes publishQuorumReview and creates top-level review with inline comments', async () => {
      const publisher = new CommentPublisher({
        baseUrl: 'http://localhost:9999',
        githubToken: 'ghp_mock_token',
      });

      // Mock fetchWithRetry internal call or fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url).endsWith('/comments')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (String(url).endsWith('/reviews')) {
          return new Response(JSON.stringify({ id: 12345 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const res = await publisher.publishQuorumReview({
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        prNumber: 42,
        commitSha: 'commit123',
        quorumResult: {
          decision: 'REQUEST_CHANGES',
          approvingPersonas: ['quality'],
          requestingChangesPersonas: ['security'],
          activeFindings: [
            {
              persona: 'security',
              severity: 'critical',
              filePath: 'src/auth.ts',
              lineNumber: 15,
              comment: 'Hardcoded password vulnerability',
            },
          ],
          filteredNits: [],
        },
      });

      expect(res.success).toBe(true);
      expect(res.reviewId).toBe(12345);
      fetchSpy.mockRestore();
    });
  });

  describe('6. GitHubEventHandler & Queue Draining', () => {
    it('evicts oldest jobs when jobStore exceeds maxStoreSize (500)', async () => {
      const handler = new GitHubEventHandler();

      for (let i = 0; i < 505; i++) {
        await handler.handleWebhook('pull_request', {
          action: 'opened',
          number: i,
          pull_request: { state: 'open', head: { sha: 'sha' }, base: { sha: 'sha' } },
          repository: { owner: { login: 'calltelemetry' }, name: 'ai-workspace' },
          sender: { login: 'user' },
        });
      }

      const metrics = handler.getQueueMetrics();
      expect(metrics.totalTracked).toBe(500); // Evicted 5 oldest jobs!
    });
  });
});
