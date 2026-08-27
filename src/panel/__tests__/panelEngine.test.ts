import { describe, it, expect, vi, afterEach } from 'vitest';
import { executePersonaPanel, isRetryablePanelError, PanelConfigurationError, validateFindings } from '../panelEngine';
import { OpenRouterResponseError, OpenRouterTimeoutError } from '../../gateway/openRouterClient';
import { OmniRouteClient } from '../../gateway/omniRouteClient';
import { parseAndValidateConfig } from '../../config/configLoader';
import { CtReviewConfigV3 } from '../../config/schema';

const mockYaml = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 5
      arbiter_timeout_s: 5
  arbiter:
    order: [codex]
`;

describe('PanelEngine (src/panel) — Exception Propagation & Fail-Closed Verification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects malformed findings instead of defaulting severity, path, line, or body', () => {
    expect(() => validateFindings([{
      severity: 'CRITICAL',
      path: '',
      line: 'not-a-line',
      title: '',
      body: '',
    }])).toThrow(/invalid findings contract.*severity/);
  });

  it('normalizes only valid finding values at the shared contract boundary', () => {
    expect(validateFindings([{
      severity: 'P2',
      path: './src/main.ts',
      line: 3,
      title: '  Title  ',
      body: '  Body  ',
      suggestion: null,
    }])).toEqual([{
      severity: 'P2',
      path: 'src/main.ts',
      line: 3,
      title: 'Title',
      body: 'Body',
    }]);
  });

  it('fails closed (throws PanelConfigurationError) when gateway connection fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9090')));

    const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });
    const config = parseAndValidateConfig(mockYaml) as unknown as CtReviewConfigV3;

    await expect(
      executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/main.ts', content: 'console.log("test");' }],
        repository: 'test/repo',
        headSha: 'abc1234',
        client,
      })
    ).rejects.toThrow(PanelConfigurationError);
    });
  });

  it('retries only typed transient OpenRouter failures', () => {
    expect(isRetryablePanelError(new OpenRouterResponseError('unauthorized', 401))).toBe(false);
    expect(isRetryablePanelError(new OpenRouterResponseError('rate limited', 429))).toBe(true);
    expect(isRetryablePanelError(new OpenRouterResponseError('unavailable', 503))).toBe(true);
    expect(isRetryablePanelError(new OpenRouterTimeoutError('deadline', 'total'))).toBe(true);
  });
