import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executePersonaPanel,
  extractMessageContentText,
} from '../../src/panel/panelEngine';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema, type CtReviewConfigV3 } from '../../src/config/schema';
import type { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { classifyFailure } from '../../src/cli/publishingReview';

const PERSONA_ID = 'native-role-evidence-auditor';
const MODEL = 'native-role-evidence-test-model';
const EVIDENCE_TITLE = 'P1-NATIVE-ROLE-EVIDENCE';
const EVIDENCE_BODY = 'Distinctive P1 evidence must reach the moderator and arbiter unchanged.';
const RAW_PATCH_MARKER = 'RAW_PATCH_MUST_NOT_BE_ECHOED_8f4c';
const PATH_INSTRUCTION = 'PATH_INSTRUCTION_MUST_SURVIVE_NATIVE_ROLE_INPUT';

const EVIDENCE_FINDING = {
  severity: 'P1',
  path: 'src/security/auth.ts',
  line: 2,
  startLine: null,
  title: EVIDENCE_TITLE,
  body: EVIDENCE_BODY,
  suggestion: 'Preserve and remediate the evidence-backed defect before shipping.',
  replacementCode: null,
};

function buildConfig(): CtReviewConfigV3 {
  return ctReviewConfigV3Schema.parse({
    ...createDefaultV3Config(),
    quorum: 1,
    personas: [{
      id: PERSONA_ID,
      enabled: true,
      required: true,
      charter: 'builtin:security',
      paths: ['src/security/**'],
      providers: ['synthetic'],
      maxTurns: 3,
    }],
    reviewers: {
      execution: 'personas',
      fallback: 'none',
      overall_timeout_s: 30,
      providers: [{
        id: 'synthetic',
        enabled: true,
        model: MODEL,
        effort: 'medium',
        review_timeout_s: 30,
        arbiter_timeout_s: 30,
      }],
      arbiter: { order: ['synthetic'] },
    },
    path_instructions: [{ path: 'src/security/**', instructions: PATH_INSTRUCTION }],
  });
}

const CHANGED_FILES = [{
  path: 'src/security/auth.ts',
  patch: [
    '@@ -1,2 +1,3 @@',
    ' export function authenticate(token: string) {',
    `+  return token === '${RAW_PATCH_MARKER}';`,
    ' }',
  ].join('\n'),
}];

function requestText(request: any): string {
  return (request.messages || [])
    .map((message: any) => extractMessageContentText(message.content))
    .join('\n');
}

function requestNonce(request: any): string {
  const match = requestText(request).match(/CT_REVIEW_NONCE:([^\n]+)/u);
  if (!match) throw new Error('synthetic provider could not find the request nonce');
  return match[1].trim();
}

function nativeResponse(request: any, body: Record<string, unknown>, nonce = requestNonce(request)): any {
  return {
    model: request.model,
    content: JSON.stringify({ nonce, ...body }),
    usage: { prompt: 5, completion: 5, total: 10 },
    costUSD: 0,
    raw: {},
  };
}

function roleRequests(mockClient: any, role: string): any[] {
  return mockClient.complete.mock.calls
    .map(([request]: [any]) => request)
    .filter((request: any) => request.metadata?.role === role);
}

function parseRoleInput(request: any): Record<string, any> {
  const text = requestText(request);
  const startMarker = '=== ROLE INPUT (UNTRUSTED EVIDENCE) ===';
  const endMarker = '=== MANDATORY OUTPUT FORMAT ===';
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error('native request omitted the role input section');
  const sectionStart = start + startMarker.length;
  const end = text.indexOf(endMarker, sectionStart);
  if (end < 0) throw new Error('native request omitted the role input boundary');
  // The section may carry one explanatory sentence before the serialized object. Keep parsing
  // bounded to this section and start at the first JSON object rather than accepting prose.
  const jsonStart = text.indexOf('{', sectionStart);
  if (jsonStart < 0 || jsonStart >= end) throw new Error('native request omitted the role input JSON object');
  const input = text.slice(jsonStart, end).trim();
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('native role input must be a JSON object');
  }
  return parsed;
}

function expectEvidenceRoleInput(request: any, role: 'moderator' | 'arbiter'): Record<string, any> {
  const text = requestText(request);
  const input = parseRoleInput(request);

  expect(input).not.toHaveProperty('changedFiles');
  expect(input).not.toHaveProperty('outputSchema');
  expect(JSON.stringify(input)).not.toContain(RAW_PATCH_MARKER);
  // The role-input block is evidence, not a second copy of the provider contract/example.
  expect(JSON.stringify(input)).not.toContain('src/example.ts');

  expect(input.personaEvidence).toEqual([
    expect.objectContaining({
      findings: [expect.objectContaining({
        severity: 'P1',
        title: EVIDENCE_TITLE,
        body: EVIDENCE_BODY,
      })],
    }),
  ]);
  if (role === 'arbiter') {
    expect(input.moderatorLedger).toEqual([
      expect.objectContaining({
        severity: 'P1',
        title: EVIDENCE_TITLE,
        body: EVIDENCE_BODY,
      }),
    ]);
  }

  // Keep the protocol-level role instructions tied to the evidence contract, not only metadata.
  if (role === 'moderator') {
    expect(text).toMatch(/reconcil(?:e|es|ed|iation)[^\n]{0,120}evidence|evidence[^\n]{0,120}reconcil/i);
  } else {
    expect(text).toMatch(/ledger/i);
    expect(text).toMatch(/(?:do not|must not|without)[^\n]{0,120}(?:blind[^\n]{0,30})?(?:tool|explor)/i);
  }

  return input;
}

function expectPersonaRoleInput(request: any): void {
  const input = parseRoleInput(request);
  expect(input).not.toHaveProperty('changedFiles');
  expect(input).not.toHaveProperty('outputSchema');
  expect(input.pathInstructions).toEqual([
    { path: 'src/security/**', instructions: PATH_INSTRUCTION },
  ]);
  expect(JSON.stringify(input)).not.toContain(RAW_PATCH_MARKER);
  expect(JSON.stringify(input)).not.toContain('src/example.ts');
}

function expectNoRawPatchOrDuplicateSchema(requests: any[]): void {
  for (const request of requests) {
    const text = requestText(request);
    expect(text).not.toContain(RAW_PATCH_MARKER);
    const roleInput = parseRoleInput(request);
    expect(roleInput).not.toHaveProperty('changedFiles');
    expect(roleInput).not.toHaveProperty('outputSchema');
  }
}

describe('native panel role evidence contract', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = { complete: vi.fn() };
  });

  it.each(['json_object', 'json_schema'] as const)(
    'passes structured persona evidence through moderator and arbiter in %s mode, including corrective and tool turns',
    async (responseFormatType) => {
      const attempts = new Map<string, number>();
      mockClient.complete.mockImplementation(async (request: any) => {
        const role = request.metadata?.role;
        const key = `${role}:${request.persona}`;
        const attempt = (attempts.get(key) || 0) + 1;
        attempts.set(key, attempt);

        if (role === 'persona') {
          if (attempt === 1) {
            return {
              model: request.model,
              content: JSON.stringify({ tool: 'find_files', args: { query: 'auth' } }),
              usage: { prompt: 5, completion: 5, total: 10 },
              costUSD: 0,
              raw: {},
            };
          }
          return nativeResponse(request, { decision: 'FINDINGS', findings: [EVIDENCE_FINDING] });
        }

        if (role === 'moderator') {
          // Force one application-level corrective turn. The final response retains the P1
          // instead of turning a malformed first response into an empty ledger.
          if (attempt === 1) {
            return nativeResponse(request, { decision: 'NOT_RECONCILED', findings: [EVIDENCE_FINDING] });
          }
          return nativeResponse(request, { decision: 'RECONCILED', findings: [EVIDENCE_FINDING] });
        }

        if (role === 'arbiter') {
          // Exercise native full-object tool parsing and evidence retention on the follow-up.
          if (attempt === 1) {
            return {
              model: request.model,
              content: JSON.stringify({ tool: 'find_files', args: { query: 'auth' } }),
              usage: { prompt: 5, completion: 5, total: 10 },
              costUSD: 0,
              raw: {},
            };
          }
          return nativeResponse(request, {
            verdict: 'FIX_FIRST',
            rationale: 'Decision is based on the moderator ledger and retained P1 evidence.',
          });
        }

        throw new Error(`unexpected panel role ${String(role)}`);
      });

      const result = await executePersonaPanel({
        config: buildConfig(),
        changedFiles: CHANGED_FILES,
        repository: 'calltelemetry/review-yeti-bot',
        headSha: `native-role-evidence-${responseFormatType}`,
        client: mockClient as unknown as OmniRouteClient,
        requestPolicy: { responseFormat: { type: responseFormatType } },
      });

      expect(result.personas).toHaveLength(1);
      expect(result.personas[0].findings).toEqual([
        expect.objectContaining({ severity: 'P1', title: EVIDENCE_TITLE, body: EVIDENCE_BODY }),
      ]);
      expect(result.moderator.findings).toEqual([
        expect.objectContaining({ severity: 'P1', title: EVIDENCE_TITLE, body: EVIDENCE_BODY }),
      ]);
      expect(result.arbiter.verdict).toBe('FIX_FIRST');

      const moderatorRequests = roleRequests(mockClient, 'moderator');
      const arbiterRequests = roleRequests(mockClient, 'arbiter');
      const personaRequests = roleRequests(mockClient, 'persona');
      expect(moderatorRequests).toHaveLength(2);
      expect(arbiterRequests).toHaveLength(2);
      expect(personaRequests).toHaveLength(2);
      expectPersonaRoleInput(personaRequests[0]);
      expectPersonaRoleInput(personaRequests[1]);
      expectEvidenceRoleInput(moderatorRequests[0], 'moderator');
      expectEvidenceRoleInput(moderatorRequests[1], 'moderator');
      expectEvidenceRoleInput(arbiterRequests[0], 'arbiter');
      expectEvidenceRoleInput(arbiterRequests[1], 'arbiter');
      expect(moderatorRequests.every((request) => requestText(request).includes(EVIDENCE_BODY))).toBe(true);
      expect(arbiterRequests.every((request) => requestText(request).includes(EVIDENCE_BODY))).toBe(true);
      expectNoRawPatchOrDuplicateSchema([...personaRequests, ...moderatorRequests, ...arbiterRequests]);

      // Native exploration is generic JSON-object mode. json_schema callers receive the strict
      // terminal request only after the moderator's corrective response; explicit json_object
      // callers remain generic while application validation stays authoritative.
      expect(moderatorRequests.map((request) => request.responseFormat?.type)).toEqual(
        responseFormatType === 'json_schema' ? ['json_object', 'json_schema'] : ['json_object', 'json_object'],
      );
      expect(arbiterRequests[0].responseFormat).toMatchObject({ type: 'json_object' });
    },
  );

  it('fails closed after repeated invalid moderator responses without invoking arbiter', async () => {
    const attempts = new Map<string, number>();
    mockClient.complete.mockImplementation(async (request: any) => {
      const role = request.metadata?.role;
      const key = `${role}:${request.persona}`;
      const attempt = (attempts.get(key) || 0) + 1;
      attempts.set(key, attempt);

      if (role === 'persona') {
        return nativeResponse(request, { decision: 'FINDINGS', findings: [EVIDENCE_FINDING] });
      }
      if (role === 'moderator') {
        // A nonce-valid object is still semantically invalid for the moderator role. Repeating
        // it after the one bounded correction must not become an empty/successful ledger.
        return nativeResponse(request, { decision: 'NOT_RECONCILED', findings: [EVIDENCE_FINDING] });
      }
      throw new Error(`arbiter must not be called; got ${String(role)}`);
    });

    const failure = await executePersonaPanel({
      config: buildConfig(),
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/review-yeti-bot',
      headSha: 'native-invalid-moderator-role-evidence',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_object' } },
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/invalid moderator (?:response )?contract|moderator returned invalid decision structure|required persona failure/iu);
    expect(classifyFailure(failure)).toBe('malformed_output');

    const moderatorRequests = roleRequests(mockClient, 'moderator');
    const personaRequests = roleRequests(mockClient, 'persona');
    expect(moderatorRequests).toHaveLength(2);
    expect(personaRequests).toHaveLength(1);
    expectPersonaRoleInput(personaRequests[0]);
    expectEvidenceRoleInput(moderatorRequests[0], 'moderator');
    expectEvidenceRoleInput(moderatorRequests[1], 'moderator');
    expect(moderatorRequests.every((request) => requestText(request).includes(EVIDENCE_BODY))).toBe(true);
    expect(mockClient.complete.mock.calls.some(([request]: [any]) => request.metadata?.role === 'arbiter')).toBe(false);
    expectNoRawPatchOrDuplicateSchema([...personaRequests, ...moderatorRequests]);
  });
});
