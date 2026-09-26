import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import type { CtReviewConfigV3 } from '../../src/config/schema';
import { OpenRouterResponseError, type OpenRouterResponse, type ReviewModelClient } from '../../src/gateway/openRouterClient';
import { EMPTY_MODERATION_SKIPPED_MODEL } from '../../src/review/emptyModeration';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { logger } from '../../src/utils/logger';

/**
 * REL-1139 (ct-meta ADR 0687), through the real panel engine: `skipEmptyModeration` skips ONLY
 * the moderator call, and only on an eligible run. The arbiter always runs. Eligibility is logged
 * on every run (`moderator_shadow_skip_eligible`) whatever the flag says.
 */

const FINDING = {
  severity: 'P2', path: 'src/service.ts', line: 1, startLine: null, replacementCode: null,
  title: 'Concrete defect', body: 'A concrete defect in the changed line.', suggestion: null,
};

const yamlConfig = `
version: 3
quorum: 1
reviewer_effort: medium
reviewers:
  execution: personas
  overall_timeout_s: 60
  fallback: ordered
  arbiter:
    order: [test-prov]
  providers:
    - id: test-prov
      model: google/gemini-3.7-flash:medium
      effort: medium
      enabled: true
      review_timeout_s: 30
      arbiter_timeout_s: 30
personas:
  - id: security
    enabled: true
    required: true
    paths: ["**/*"]
    providers: [test-prov]
    charter: Security checks
  - id: architecture
    enabled: true
    required: false
    paths: ["**/*"]
    providers: [test-prov]
    charter: Architecture checks
`;
const config = parseAndValidateConfig(yamlConfig) as unknown as CtReviewConfigV3;

interface Script {
  /** Lane ids that answer with one P2 finding instead of an empty APPROVE. */
  findingLanes?: string[];
  /** Lane ids whose every call fails. */
  failingLanes?: string[];
}

function roleOf(request: any): string {
  const text = `${request.messages?.[0]?.content ?? ''}\n${extractMessageContentText(request.messages?.[1]?.content)}`;
  if (request.persona === 'moderator' || text.includes('Role: MODERATOR')) return 'moderator';
  if (request.persona === 'arbiter' || text.includes('Role: ARBITER')) return 'arbiter';
  return String(request.persona || 'unknown');
}

function scriptedClient(script: Script) {
  const calls: string[] = [];
  const client: ReviewModelClient = {
    complete: vi.fn(async (request): Promise<OpenRouterResponse> => {
      const role = roleOf(request);
      calls.push(role);
      // A non-retryable provider error, so the lane fails closed at once.
      if (script.failingLanes?.includes(role)) throw new OpenRouterResponseError('unauthorized', 401);
      const match = String(request.messages[0].content).match(/CT_REVIEW_BEGIN:([^\s\n]+)/);
      const nonce = match ? match[1] : 'nonce123';
      const body = role === 'arbiter'
        ? { verdict: 'SHIP', rationale: 'clean' }
        : role === 'moderator'
          ? { decision: 'RECONCILED', findings: [] }
          : script.findingLanes?.includes(role)
            ? { decision: 'FINDINGS', findings: [FINDING] }
            : { decision: 'APPROVE', findings: [] };
      return {
        model: request.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`,
        usage: { prompt: 100, completion: 50, total: 150 },
        costUSD: 0.0001,
        raw: null,
      };
    }),
  };
  return { client, calls };
}

async function run(options: { skip?: boolean; script?: Script; patch?: string; path?: string; unreadable?: number }) {
  const { client, calls } = scriptedClient(options.script ?? {});
  const result = await executePersonaPanel({
    config,
    changedFiles: [{ path: options.path ?? 'src/service.ts', patch: options.patch ?? '@@ -1 +1 @@\n-const x = 0;\n+const x = 1;' }],
    repository: 'acme/app',
    headSha: 'a'.repeat(40),
    client,
    ...(options.skip === undefined ? {} : { skipEmptyModeration: options.skip }),
    ...(options.unreadable === undefined ? {} : { unreadableDiffHeaders: options.unreadable }),
  });
  return { result, calls };
}

const roles = (calls: string[], role: string) => calls.filter((call) => call === role).length;

function timingLine(info: ReturnType<typeof vi.spyOn>): Record<string, unknown> | undefined {
  return info.mock.calls.find(([message]: unknown[]) => message === 'Panel phase timing')?.[1] as Record<string, unknown> | undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executePersonaPanel empty-moderation skip (REL-1139)', () => {
  it('flag off: calls the moderator and the arbiter, and still logs the run as eligible', async () => {
    for (const skip of [undefined, false]) {
      const info = vi.spyOn(logger, 'info');
      const { result, calls } = await run({ skip });
      expect(roles(calls, 'moderator')).toBe(1);
      expect(roles(calls, 'arbiter')).toBe(1);
      expect(result.moderation).toBeUndefined();
      expect(result.moderator.model).not.toBe(EMPTY_MODERATION_SKIPPED_MODEL);
      expect(timingLine(info)).toMatchObject({ moderator_shadow_skip_eligible: true, moderation: 'called' });
      expect(timingLine(info)).not.toHaveProperty('moderator_shadow_skip_reason');
      info.mockRestore();
    }
  });

  it('flag on and eligible: skips only the moderator; the arbiter still runs on the empty ledger', async () => {
    const info = vi.spyOn(logger, 'info');
    const { result, calls } = await run({ skip: true });
    expect(roles(calls, 'moderator')).toBe(0);
    expect(roles(calls, 'arbiter')).toBe(1);
    // Lanes are never skipped.
    expect(result.personas.map((persona) => persona.id).sort()).toEqual(['architecture', 'security']);
    expect(result.moderation).toBe('skipped-empty');
    expect(result.moderator).toMatchObject({ decision: 'RECONCILED', findings: [], model: EMPTY_MODERATION_SKIPPED_MODEL, costUSD: 0, durationMs: 0 });
    expect(result.arbiter.model).not.toBe(EMPTY_MODERATION_SKIPPED_MODEL);
    expect(result.arbiter.verdict).toBe('SHIP');
    expect(timingLine(info)).toMatchObject({ moderator_shadow_skip_eligible: true, moderation: 'skipped-empty' });
  });

  const disqualified: Array<[string, Parameters<typeof run>[0], string]> = [
    ['a lane finding', { script: { findingLanes: ['architecture'] } }, 'lane-not-approve'],
    ['a failed optional lane', { script: { failingLanes: ['architecture'] } }, 'lane-failed'],
    ['a security-sensitive file', { path: 'src/auth/session.ts' }, 'security-sensitive-file'],
    ['an unreadable diff header', { unreadable: 1 }, 'coverage-incomplete'],
    ['a truncated patch', {
      patch: `@@ -1 +1,4000 @@\n${Array.from({ length: 4000 }, (_, i) => `+const value${i} = ${i}; // padding padding`).join('\n')}`,
    }, 'truncated'],
  ];
  it.each(disqualified)('flag on: %s keeps the moderator and logs the reason', async (_label, options, reason) => {
    const info = vi.spyOn(logger, 'info');
    const { result, calls } = await run({ ...options, skip: true });
    expect(roles(calls, 'moderator')).toBe(1);
    expect(roles(calls, 'arbiter')).toBe(1);
    expect(result.moderation).toBeUndefined();
    expect(timingLine(info)).toMatchObject({ moderator_shadow_skip_eligible: false, moderator_shadow_skip_reason: reason, moderation: 'called' });
  });
});
