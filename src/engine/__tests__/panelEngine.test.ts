import { describe, it, expect, vi, afterEach } from 'vitest';
import { executePersonaPanel, PanelConfigurationError } from '../../panel/panelEngine';
import { OmniRouteClient, GatewayConnectionError } from '../../gateway/omniRouteClient';
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

const mockOptionalYaml = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: sec-req
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
  - id: opt-lane
    charter: builtin:correctness
    providers: [codex]
    paths: ["**/*"]
    required: false
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

describe('PanelEngine — Error Propagation & Non-fallback Verification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fails closed (throws PanelConfigurationError) when omniRouteClient throws GatewayConnectionError, never returning synthetic approvals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9090')));

    const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });
    const config = parseAndValidateConfig(mockYaml) as unknown as CtReviewConfigV3;

    let panelResult: any = null;
    let panelError: any = null;

    try {
      panelResult = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/main.ts', content: 'console.log("test");' }],
        repository: 'test/repo',
        headSha: 'abc1234',
        client,
      });
    } catch (err) {
      panelError = err;
    }

    expect(panelResult).toBeNull();
    expect(panelError).toBeInstanceOf(PanelConfigurationError);
    expect(panelError?.message).toContain('required persona failure');
    expect(panelError?.message).toContain('OmniRoute connection failure');
  });

  it('propagates gateway errors for optional personas and records them in optionalFailures', async () => {
    const optionalConfig = parseAndValidateConfig(mockOptionalYaml) as unknown as CtReviewConfigV3;

    const mockComplete = vi.fn().mockImplementation(async (req: any) => {
      const allMsg = JSON.stringify(req.messages);
      if (allMsg.includes('"persona":"opt-lane"') || allMsg.includes('opt-lane')) {
        throw new GatewayConnectionError('Connection refused for optional lane');
      }
      const prompt = req.messages[req.messages.length - 1].content;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
      const nonce = nonceMatch ? nonceMatch[1] : 'nonce';
      if (allMsg.includes('arbiter')) {
        return { model: req.model, content: `CT_REVIEW_BEGIN:${nonce}\n{"verdict":"SHIP","rationale":"Clean"}\nCT_REVIEW_END:${nonce}`, usage: null, costUSD: null, raw: {} };
      }
      if (allMsg.includes('moderator')) {
        return { model: req.model, content: `CT_REVIEW_BEGIN:${nonce}\n{"decision":"RECONCILED","findings":[]}\nCT_REVIEW_END:${nonce}`, usage: null, costUSD: null, raw: {} };
      }
      return { model: req.model, content: `CT_REVIEW_BEGIN:${nonce}\n{"decision":"APPROVE","findings":[]}\nCT_REVIEW_END:${nonce}`, usage: null, costUSD: null, raw: {} };
    });

    const client = { complete: mockComplete } as unknown as OmniRouteClient;

    const result = await executePersonaPanel({
      config: optionalConfig,
      changedFiles: [{ path: 'src/main.ts', content: 'code' }],
      repository: 'test/repo',
      headSha: 'abc1234',
      client,
    });

    expect(result.optionalFailures).toHaveLength(1);
    expect(result.optionalFailures[0].id).toBe('opt-lane');
    expect(result.optionalFailures[0].error).toContain('Connection refused for optional lane');
  });
});
