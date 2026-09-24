import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import type { PanelResult } from '../../src/panel/types';
import {
  renderReviewDepthDisclosure, runPublishingReviewWorker, type PublishingCheckClient, type PublishingReviewDeps,
} from '../../src/cli/publishingReview';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { loadSameHeadReviewSource } from '../../src/github/qualificationReader';
import { filterDiffHunks, MAX_FILE_PATCH_CHARS } from '../../src/pipeline/hunkFilter';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { classifyUnavailablePatch } from '../../src/review/patchAvailability';
import { resolveReviewApplicability } from '../../src/review/personaApplicability';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { deriveCanonicalWorkerReviewEvidence, parseWorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import type { WorkerReviewCompletionAdapter } from '../../src/review/workerReviewCompletionHttp';
import { logger } from '../../src/utils/logger';

/**
 * REL-1092 (plan docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md,
 * section 3.5: nothing dropped silently).
 *
 * 1. `hunkFilter` cut any patch over 20,000 characters and nothing said so (W1: 174 runs, 698
 *    file instances in 7 days). The cut is now recorded on the shared decision, carried on both
 *    engines' results and listed in both check-summary variants.
 * 2. On the worker's 406 pull-files fallback a file with no `patch` (binary, or omitted by GitHub)
 *    rendered as '' and vanished: no lane saw it, no summary named it, the worker derived lanes
 *    from fewer paths than the trusted side, and an omitted source file counted as reviewed. It now
 *    keeps its place, is disclosed, and omitted source makes the review coverage-incomplete.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas: string) => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const JSON_OUTPUT = { responseFormat: { type: 'json_object' as const } };
const smallPatch = '@@ -1 +1 @@\n-a\n+b\n';

function bigPatch(lines = 3000): string {
  return `@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, index) => `+const value${index} = ${index}; // padding`).join('\n')}\n`;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('REL-1092: per-file patch truncation is recorded and disclosed', () => {
  it('hunkFilter records path, original size and kept size for a truncated patch', () => {
    const patch = bigPatch();
    const result = filterDiffHunks([{ path: 'src/big.ts', patch }, { path: 'src/small.ts', patch: smallPatch }]);
    const [big, small] = result.files;
    expect(big.status).toBe('truncated');
    expect(big.truncation).toEqual({ originalChars: patch.length, keptChars: MAX_FILE_PATCH_CHARS });
    expect(small.truncation).toBeUndefined();
  });

  it('the shared decision reports every truncated file it sends to lanes', () => {
    const patch = bigPatch();
    const decision = resolveReviewApplicability(roster('security').personas.filter((p) => p.enabled), [
      { path: 'src/big.ts', patch }, { path: 'src/small.ts', patch: smallPatch },
      // Excluded from review entirely, so not "sent in part".
      { path: 'package-lock.json', patch: bigPatch() },
    ]);
    expect(decision.truncatedFiles).toEqual([{ path: 'src/big.ts', originalChars: patch.length, keptChars: 20_000 }]);
  });

  it('the panel engine carries the truncation on its result', async () => {
    const patch = bigPatch();
    const result = await executePersonaPanel({
      config: roster('security'),
      changedFiles: [{ path: 'src/big.ts', patch }],
      repository: 'r/r',
      headSha: HEAD,
      client: approvingPanelClient(),
      requestPolicy: JSON_OUTPUT,
      deterministicRoster: true,
    });
    expect(result.truncatedFiles).toEqual([{ path: 'src/big.ts', originalChars: patch.length, keptChars: 20_000 }]);
  }, 60_000);

  it('the composed engine carries the truncation on its result', async () => {
    const patch = bigPatch();
    const result = await executeComposedReview({
      config: roster('security'),
      changedFiles: [{ path: 'src/big.ts', patch }],
      repository: 'r/r',
      headSha: HEAD,
      client: composedClient(['src/big.ts']),
    });
    expect(result.truncatedFiles).toEqual([{ path: 'src/big.ts', originalChars: patch.length, keptChars: 20_000 }]);
  }, 60_000);

  it('renders sanitized, capped disclosure lines', () => {
    const truncatedFiles = Array.from({ length: 22 }, (_, index) => ({
      path: index === 0 ? 'a`b<c>\nd.ts' : `src/f${index}.ts`, originalChars: 45_123, keptChars: 20_000,
    }));
    const [text] = renderReviewDepthDisclosure({ truncatedFiles });
    expect(text).toContain('Truncated patches (reviewed in part');
    expect(text).toContain('- `a b c  d.ts`: kept 20,000 of 45,123 characters');
    expect(text).toContain('src/f19.ts');
    expect(text).not.toContain('src/f20.ts');
    expect(text).toContain('- +2 more');
    expect(renderReviewDepthDisclosure({})).toEqual([]);
  });
});

/** A 406 read served by the pull-files API with the given entries. */
async function pullFilesFallbackDiff(files: unknown[]): Promise<string> {
  const request = vi.fn()
    .mockResolvedValueOnce({ data: { head: { sha: HEAD }, base: { sha: BASE } }, status: 200 })
    .mockRejectedValueOnce(Object.assign(new Error('diff too large'), { status: 406 }))
    .mockResolvedValueOnce({ data: files, status: 200 })
    .mockResolvedValueOnce({ data: { head: { sha: HEAD }, base: { sha: BASE } }, status: 200 });
  const source = await loadSameHeadReviewSource({
    token: 'ghs_test', repo: 'o/r', prNumber: 1, expectedBaseSha: BASE, expectedHeadSha: HEAD,
  }, request as never);
  return source.diff;
}

const PULL_FILES = [
  { filename: 'src/a.ts', status: 'modified', patch: smallPatch, additions: 1, deletions: 1, changes: 2 },
  // GitHub omits a patch it considers too large: text changed, no patch.
  { filename: 'src/huge.go', status: 'modified', additions: 30_000, deletions: 10, changes: 30_010 },
  // Binary: no patch, no changed lines.
  { filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, changes: 0 },
];

/** The same change as the trusted side's git-derived three-dot diff sees it. */
const TRUSTED_DIFF = [
  `diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n${smallPatch}`,
  `diff --git a/src/huge.go b/src/huge.go\nindex 3333333..4444444 100644\n--- a/src/huge.go\n+++ b/src/huge.go\n@@ -1 +1 @@\n-package old\n+package huge\n`,
  'diff --git a/assets/logo.png b/assets/logo.png\nindex 5555555..6666666 100644\nBinary files a/assets/logo.png and b/assets/logo.png differ\n',
].join('');

/** sec-lane reviews TypeScript; a Go lane reviews only Go. */
function splitRoster() {
  return roster('security,architecture').personas.filter((persona) => persona.enabled).map((persona) => ({
    ...persona,
    paths: persona.id === 'sec-lane' ? ['**/*.ts'] : ['**/*.go'],
  }));
}

describe('REL-1092: files the pull-files fallback has no patch for are kept and disclosed', () => {
  it('keeps every pull-files entry in the worker diff, marked when its patch is unavailable', async () => {
    const diff = await pullFilesFallbackDiff(PULL_FILES);
    const { files, unreadable } = parseChangedFiles(diff);
    expect(unreadable).toEqual([]);
    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'src/huge.go', 'assets/logo.png']);
    expect(files.map((file) => classifyUnavailablePatch(file.patch))).toEqual([null, 'omitted', 'binary']);
  });

  it('renders a pure rename with no patch as a rename, not as an unavailable patch', async () => {
    const diff = await pullFilesFallbackDiff([
      { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', changes: 0 },
    ]);
    const { files } = parseChangedFiles(diff);
    expect(files.map((file) => file.path)).toEqual(['src/new.ts']);
    expect(classifyUnavailablePatch(files[0].patch)).toBeNull();
  });

  it('worker and trusted side derive the same lanes from the shared decision', async () => {
    const worker = resolveReviewApplicability(splitRoster(), parseChangedFiles(await pullFilesFallbackDiff(PULL_FILES)).files);
    const trusted = resolveReviewApplicability(splitRoster(), parseChangedFiles(TRUSTED_DIFF).files);
    expect(trusted.applicable.map((persona) => persona.id)).toEqual(['sec-lane', 'arch-lane']);
    expect(worker.applicable.map((persona) => persona.id)).toEqual(trusted.applicable.map((persona) => persona.id));
    expect(worker.unavailablePatches).toEqual([
      { path: 'src/huge.go', kind: 'omitted' }, { path: 'assets/logo.png', kind: 'binary' },
    ]);
    // An omitted source file is never counted as reviewed; a binary asset is disclosed only.
    expect(worker.omittedSourcePaths).toEqual(['src/huge.go']);
    expect(trusted.unavailablePatches).toEqual([{ path: 'assets/logo.png', kind: 'binary' }]);
    expect(trusted.omittedSourcePaths).toEqual([]);
  });

  it('both engines carry the unavailable patches on their result', async () => {
    const changedFiles = parseChangedFiles(await pullFilesFallbackDiff(PULL_FILES)).files;
    const panel = await executePersonaPanel({
      config: roster('security'), changedFiles, repository: 'r/r', headSha: HEAD,
      client: approvingPanelClient(), requestPolicy: JSON_OUTPUT, deterministicRoster: true,
    });
    const composed = await executeComposedReview({
      config: roster('security'), changedFiles, repository: 'r/r', headSha: HEAD,
      client: composedClient(changedFiles.map((file) => file.path)),
    });
    for (const result of [panel, composed]) {
      expect(result.unavailablePatches).toEqual([
        { path: 'src/huge.go', kind: 'omitted' }, { path: 'assets/logo.png', kind: 'binary' },
      ]);
      expect(result.omittedSourcePaths).toEqual(['src/huge.go']);
    }
  }, 60_000);
});

function workerDeps(panel: Partial<PanelResult>) {
  const checkClient = {
    createCheck: vi.fn<PublishingCheckClient['createCheck']>(async () => 4242),
    completeCheck: vi.fn<PublishingCheckClient['completeCheck']>(async () => undefined),
  };
  return {
    checkClient,
    sourceLoader: vi.fn(async () => ({ diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n', githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: vi.fn(async () => panel) as never,
    client: {} as never,
  };
}

function workerEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test', REVIEW_PUBLICATION_MODE: 'app-gate', REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'calltelemetry/ct-meta', REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_POLICY_DIGEST: 'c'.repeat(64), REVIEW_CONFIG_DIGEST: 'd'.repeat(64), REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_PR_NUMBER: '2795', REVIEW_HEAD_SHA: HEAD, REVIEW_BASE_SHA: BASE, REVIEW_MODEL: 'ollama/glm-5.3-flash',
    OPENAI_BASE_URL: 'https://gateway.example.invalid/v1', OPENAI_API_KEY: 'vk-test', GH_TOKEN: 'ghs_test',
  };
}

const summaryOf = (d: ReturnType<typeof workerDeps>) =>
  String(((d.checkClient.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);

describe('REL-1092: the check summary discloses both, and omitted source is not counted as reviewed', () => {
  const lane = { id: 'sec-lane', findings: [], turnsCount: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1 };
  const clean = {
    applicablePersonaIds: ['sec-lane'], personas: [lane], optionalFailures: [],
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true }, arbiter: { verdict: 'SHIP' },
  } as unknown as Partial<PanelResult>;

  it('full panel: lists truncated and binary files and still ships a clean review', async () => {
    const d = workerDeps({
      ...clean,
      truncatedFiles: [{ path: 'src/big.ts', originalChars: 45_000, keptChars: 20_000 }],
      unavailablePatches: [{ path: 'assets/logo.png', kind: 'binary' }],
    });
    const receipt = await runPublishingReviewWorker(workerEnv(), d as never);
    expect(receipt.conclusion).toBe('success');
    const summary = summaryOf(d);
    expect(summary).toContain('Truncated patches (reviewed in part');
    expect(summary).toContain('- `src/big.ts`: kept 20,000 of 45,000 characters');
    expect(summary).toContain('Not reviewed: patch unavailable (binary/omitted):\n- `assets/logo.png` (binary)');
  });

  it('fast-ship: lists truncated and unavailable files too', async () => {
    const d = workerDeps({
      isFastShip: true, classifierRationale: 'Config only', tokensSaved: 100,
      personas: [{ id: 'fast-ship', findings: [] }],
      quorum: { required: 0, distinctProviders: [], satisfied: true }, arbiter: { verdict: 'SHIP' },
      truncatedFiles: [{ path: 'config/big.json', originalChars: 30_000, keptChars: 20_000 }],
      unavailablePatches: [{ path: 'assets/logo.png', kind: 'binary' }],
    } as unknown as Partial<PanelResult>);
    const receipt = await runPublishingReviewWorker(workerEnv(), d as never);
    expect(receipt.conclusion).toBe('success');
    const summary = summaryOf(d);
    expect(summary).toContain('### Review Yeti: SHIP (fast-ship)');
    expect(summary).toContain('- `config/big.json`: kept 20,000 of 30,000 characters');
    expect(summary).toContain('- `assets/logo.png` (binary)');
  });

  it('an omitted source patch blocks: coverage is incomplete and the gap is named', async () => {
    const d = workerDeps({
      ...clean,
      unavailablePatches: [{ path: 'src/huge.go', kind: 'omitted' }],
      omittedSourcePaths: ['src/huge.go'],
    });
    const receipt = await runPublishingReviewWorker(workerEnv(), d as never);
    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.conclusion).toBe('failure');
    const summary = summaryOf(d);
    expect(summary).toContain('- `src/huge.go` (omitted by GitHub) -- source, so coverage is incomplete');
  });
});

describe('REL-1092: the service acknowledges the worker completion (no ack mismatch)', () => {
  it('derives the same BLOCK from the worker coverage gap as the worker published', async () => {
    const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
      personas: 'security,testing', budget: { max_investigation_turns: 1 },
    } });
    const preparedTransport = { baseUrl: transport.baseUrl, model: 'prepared-review-model' };
    const prepared = preparePublishingPolicy({ content, source: {
      repositoryId: 987, repository: 'example/policy', sha: 'e'.repeat(40), path: 'policy/review.json',
      contentDigest: createHash('sha256').update(content).digest('hex'),
    } }, preparedTransport);
    const diff = await pullFilesFallbackDiff([
      { filename: 'src/a.ts', status: 'modified', patch: smallPatch, changes: 2 },
      { filename: 'src/huge.ts', status: 'modified', changes: 30_000 },
    ]);
    const usage = { prompt: 10, completion: 5, total: 15 };
    const panel: PanelResult = {
      headSha: HEAD,
      applicablePersonaIds: prepared.expectedPersonaIds,
      personas: prepared.expectedPersonaIds.map((id) => ({ id, required: id === 'sec-lane',
        providerId: 'bifrost', model: preparedTransport.model, decision: 'APPROVE', findings: [],
        usage, costUSD: null, durationMs: 25 })),
      optionalFailures: [], quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      moderator: { providerId: 'bifrost', model: preparedTransport.model, decision: 'RECONCILED', findings: [], usage, costUSD: null, durationMs: 10 },
      arbiter: { providerId: 'bifrost', model: preparedTransport.model, verdict: 'SHIP', rationale: 'Clean', usage, costUSD: null, durationMs: 10 },
    };
    // What the engines attach from the shared decision for this diff.
    const decision = resolveReviewApplicability(prepared.config.personas.filter((persona) => persona.enabled),
      parseChangedFiles(diff).files, { pathFilters: prepared.config.path_filters });
    expect(decision.omittedSourcePaths).toEqual(['src/huge.ts']);
    const reportReviewResult = vi.fn<WorkerReviewCompletionAdapter['reportReviewResult']>().mockResolvedValue(undefined);
    const deps: PublishingReviewDeps = {
      checkClient: {
        createCheck: vi.fn<PublishingCheckClient['createCheck']>(async () => 4242),
        completeCheck: vi.fn<PublishingCheckClient['completeCheck']>(async () => undefined),
      },
      sourceLoader: vi.fn<NonNullable<PublishingReviewDeps['sourceLoader']>>().mockResolvedValue({
        baseSha: BASE, headSha: HEAD, diff, diffDigest: createHash('sha256').update(diff).digest('hex'), githubReads: 4,
      }),
      panelRunner: vi.fn<NonNullable<PublishingReviewDeps['panelRunner']>>().mockResolvedValue({
        ...panel, unavailablePatches: decision.unavailablePatches, omittedSourcePaths: decision.omittedSourcePaths,
      }),
      client: { complete: vi.fn().mockRejectedValue(new Error('no provider')) } as never,
      now: vi.fn().mockReturnValue(Date.parse('2026-09-23T12:00:00.000Z')),
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      reviewCompletion: { reportReviewResult },
    };
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
    await runPublishingReviewWorker({
      NODE_ENV: 'test', REVIEW_PUBLICATION_MODE: 'app-gate', REVIEW_AUTHORITATIVE_GATE: 'true',
      REVIEW_RUN_ID: `run_${'c'.repeat(32)}`, REVIEW_REPOSITORY_ID: '123', REVIEW_REPO: 'example/project',
      REVIEW_PR_NUMBER: '42', REVIEW_HEAD_SHA: HEAD, REVIEW_BASE_SHA: BASE, REVIEW_EXECUTION_ATTEMPT: '2',
      REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest, REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
      REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport: preparedTransport }),
      REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
      REVIEW_MODEL: preparedTransport.model, OPENAI_BASE_URL: preparedTransport.baseUrl, OPENAI_API_KEY: 'vk_fake',
      GH_TOKEN: 'ghs_fake', GITHUB_PUBLISH_TOKEN: 'ghs_fake', REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
    }, deps);

    expect(reportReviewResult).toHaveBeenCalledOnce();
    const completion = parseWorkerReviewCompletion(reportReviewResult.mock.calls[0]?.[0]);
    expect(completion.result.coverageComplete).toBe(false);
    const { version: _version, result: _result, ...expectedCoordinates } = completion;
    // The trusted side read the full patch (git-derived), so its own coverage is complete.
    const trustedFiles = parseChangedFiles([
      `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${smallPatch}`,
      'diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n@@ -1 +1 @@\n-old\n+new\n',
    ].join('')).files;
    const derived = deriveCanonicalWorkerReviewEvidence(completion, {
      expectedCoordinates,
      expectedPersonaIds: prepared.expectedPersonaIds,
      changedFiles: trustedFiles,
      coverageComplete: true,
      quorumSatisfied: true,
    });
    expect(derived).toMatchObject({ valid: true, evidence: { verdict: 'BLOCK', coverageComplete: false } });
  });
});

function textOf(messages: unknown[]): string {
  return JSON.stringify(messages);
}

function lastText(messages: unknown[]): string {
  const last = messages[messages.length - 1] as { content?: unknown } | undefined;
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) return last.content.map((block: { text?: string }) => block.text || '').join('\n');
  return '';
}

function nonceFrom(text: string): string {
  const match = text.match(/CT_REVIEW_NONCE:([^\n"\\]+)/);
  return match ? match[1].trim() : 'nonce';
}

function fakeResponse(content: string) {
  return { model: 'test-model', content, usage: { prompt: 10, completion: 10, total: 20 }, costUSD: 0, raw: {} };
}

function approvingPanelClient(): ReviewModelClient {
  const complete = async (request: { messages: unknown[]; metadata?: { role?: string } }) => {
    const text = textOf(request.messages);
    const nonce = nonceFrom(text);
    const role = request.metadata?.role;
    if (role === 'moderator') return fakeResponse(JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }));
    if (role === 'arbiter') return fakeResponse(JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'ok' }));
    return fakeResponse(JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }));
  };
  return { complete } as unknown as ReviewModelClient;
}

function composedClient(paths: string[]): ReviewModelClient {
  const complete = async (payload: { messages: unknown[] }) => {
    const text = lastText(payload.messages);
    const nonce = nonceFrom(text);
    if (text.includes('PLAN TURN')) {
      return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'task-sec', dimension: 'security', paths, question: 'Is it safe?', rationale: 'changed source' },
      ] }));
    }
    if (text.includes('WORK TURN')) return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
  };
  return { complete } as unknown as ReviewModelClient;
}
