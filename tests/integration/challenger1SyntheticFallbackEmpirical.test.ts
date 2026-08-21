import { describe, it, expect, afterEach, vi } from 'vitest';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { executePersonaPanel, PanelConfigurationError } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';

describe('Challenger 1 Empirical Synthetic Fallback Verification (omniRouteClient & panelEngine)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', undefined);
  });

  const mockConfig: CtReviewConfigV3 = {
    version: '3.0',
    quorum: 1,
    path_instructions: [],
    rules: [],
    reviewers: {
      fallback: 'none',
      providers: [
        {
          id: 'codex',
          type: 'omniroute',
          model: 'codex/gpt-5.6-sol-high',
          review_timeout_s: 5,
          arbiter_timeout_s: 5,
          enabled: true,
        },
      ],
      arbiter: {
        order: ['codex'],
      },
    },
    personas: [
      {
        id: 'security',
        charter: 'builtin:security',
        providers: ['codex'],
        paths: ['**/*'],
        required: true,
        enabled: true,
      },
    ],
  };

  describe('1. omniRouteClient.complete network exception & synthetic fallback checks', () => {
    it('THROWS network error on simulated fetch network failure (ECONNREFUSED) without forging synthetic GLM-5.2 response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9090')));

      const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });

      // EXPECTATION: complete() must THROW an exception on network failure.
      // It must NOT catch the error and return a synthetic response (content containing CT_REVIEW_BEGIN or GLM-5.2 fallback).
      let caughtError: Error | null = null;
      let res: any = null;

      try {
        res = await client.complete({
          model: 'codex/gpt-5.6-sol-high',
          messages: [{ role: 'user', content: 'CT_REVIEW_NONCE:test-nonce\nreview code' }],
          timeoutMs: 5000,
        });
      } catch (err: any) {
        caughtError = err;
      }

      // Assertions:
      console.log('Test 1 Result:', { caughtError: caughtError?.message, resContent: res?.content });
      expect(res).toBeNull();
      expect(caughtError).not.toBeNull();
      expect(caughtError?.message).toMatch(/ECONNREFUSED/i);
    });

    it('THROWS TimeoutError/AbortError on simulated request timeout without forging synthetic GLM-5.2 response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError')));

      const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });

      let caughtError: Error | null = null;
      let res: any = null;

      try {
        res = await client.complete({
          model: 'codex/gpt-5.6-sol-high',
          messages: [{ role: 'user', content: 'CT_REVIEW_NONCE:test-nonce\nreview code' }],
          timeoutMs: 100,
        });
      } catch (err: any) {
        caughtError = err;
      }

      console.log('Test 2 Result:', { caughtError: caughtError?.message, resContent: res?.content });
      expect(res).toBeNull();
      expect(caughtError).not.toBeNull();
      expect(caughtError?.message).toMatch(/AbortError|aborted/i);
    });

    it('THROWS connection exception on real offline socket (http://127.0.0.1:59999)', async () => {
      // Real fetch call to non-existent local port
      const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:59999' });

      let caughtError: Error | null = null;
      let res: any = null;

      try {
        res = await client.complete({
          model: 'codex/gpt-5.6-sol-high',
          messages: [{ role: 'user', content: 'CT_REVIEW_NONCE:test-nonce\nreview code' }],
          timeoutMs: 2000,
        });
      } catch (err: any) {
        caughtError = err;
      }

      console.log('Test 3 Result:', { caughtError: caughtError?.message, resContent: res?.content });
      expect(res).toBeNull();
      expect(caughtError).not.toBeNull();
    });
  });

  describe('2. panelEngine.executePersonaPanel network failure & mock review forging checks', () => {
    it('FAILS CLOSED (throws PanelConfigurationError) when underlying omniRouteClient hits offline server, and NEVER returns forged APPROVE/SHIP verdict', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9090')));

      const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });

      let panelResult: any = null;
      let panelError: Error | null = null;

      try {
        panelResult = await executePersonaPanel({
          config: mockConfig,
          changedFiles: [{ path: 'src/main.ts', content: 'console.log("test");' }],
          repository: 'test/repo',
          headSha: 'abc1234',
          client,
        });
      } catch (err: any) {
        panelError = err;
      }

      console.log('Test 4 Result:', { panelError: panelError?.message, panelVerdict: panelResult?.arbiter?.verdict });
      expect(panelResult).toBeNull();
      expect(panelError).not.toBeNull();
      expect(panelError).toBeInstanceOf(PanelConfigurationError);
    });
  });
});
