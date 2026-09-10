import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { executePersonaPanel, extractMessageContentText, filePatchChars } from '../../src/panel/panelEngine';
import type { OpenRouterRequest } from '../../src/gateway/openRouterClient';

afterEach(() => vi.unstubAllEnvs());

describe('panel original diff-size boundary', () => {
  it('never lets a truncated or invalid size marker understate retained content', () => {
    expect(filePatchChars({ patch: 'abc', originalPatchLength: 600_000 })).toBe(600_000);
    for (const originalPatchLength of [0, -1, 1, NaN, Infinity]) {
      expect(filePatchChars({ patch: 'abc', originalPatchLength })).toBe(3);
    }
  });

  it('preserves SKIPPED and refuses get_diff after the smart hunk filter truncates a large patch', async () => {
    vi.stubEnv('MAX_FILE_DIFF_CHARS', '524288');
    const config = createDefaultV3Config();
    config.default_max_turns = 3;
    config.quorum = 1;
    config.personas = [{
      id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security',
      paths: ['src/security/**'], providers: ['bifrost'],
    }];
    config.reviewers.providers = [{
      id: 'bifrost', enabled: true, model: 'fixture-model',
      review_timeout_s: 180, arbiter_timeout_s: 180,
    }];
    config.reviewers.arbiter.order = ['bifrost'];
    const prompts: string[] = [];
    let personaCalls = 0;
    const complete = vi.fn(async (request: OpenRouterRequest) => {
      const prompt = request.messages.map((message) => extractMessageContentText(message.content)).join('\n');
      prompts.push(prompt);
      const nonce = prompt.match(/CT_REVIEW_NONCE:\s*([^\n]+)/)?.[1]?.trim();
      expect(nonce).toBeTruthy();
      if (request.persona === 'sec-lane' && personaCalls++ === 0) {
        return { model: request.model, content: '```json\n{"tool":"get_diff","args":{"path":"src/security/large.ts"}}\n```', usage: null, costUSD: null };
      }
      const result = request.persona === 'arbiter'
        ? { verdict: 'SHIP', rationale: 'Synthetic protocol fixture only.' }
        : request.persona === 'moderator'
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: 'APPROVE', findings: [] };
      return {
        model: request.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(result)}\nCT_REVIEW_END:${nonce}`,
        usage: null, costUSD: null,
      };
    });

    await executePersonaPanel({
      config, repository: 'example/fixture', headSha: 'oversized-patch-fixture', client: { complete },
      changedFiles: [{ path: 'src/security/large.ts', patch: '+ const fixture = true;\n'.repeat(30_000) }],
    });

    expect(prompts[0]).toContain('src/security/large.ts (SKIPPED:');
    expect(prompts.some((prompt) => prompt.includes("SKIPPED 'src/security/large.ts': patch is"))).toBe(true);
    expect(prompts.every((prompt) => !prompt.includes('+ const fixture = true;'))).toBe(true);
  });
});
