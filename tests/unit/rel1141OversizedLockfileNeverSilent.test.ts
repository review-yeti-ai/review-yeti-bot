import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import type { PanelResult } from '../../src/panel/types';
import {
  renderReviewDepthDisclosure, renderRoutedFiles, runPublishingReviewWorker, type PublishingCheckClient,
} from '../../src/cli/publishingReview';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import type { StoredReviewGate } from '../../src/persistence/reviewGateRepository';
import type { AuthoritativeReviewReader } from '../../src/github/authoritativeReviewReader';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from '../../src/review/authoritativeCompletionContext';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { renderDiffShrinkSummary, resolveShrunkReviewApplicability } from '../../src/review/diffShrink';
import { resolveReviewApplicability, scopeFilesForPersona } from '../../src/review/personaApplicability';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { sha256 } from '../../src/review/reviewCore';
import { MAX_FILE_PATCH_CHARS } from '../../src/pipeline/hunkFilter';
import { PATCH_UNAVAILABLE_MARKER } from '../../src/review/patchAvailability';

/**
 * REL-1141 (child of REL-1077). Found live on 1.92.9:
 * calltelemetry/openclaw-linear-plugin#30 (Dependabot, head 6a143677) changed
 * package.json by one line and package-lock.json by a 41,140-character patch
 * that adds four NEW packages (@koromix/koffi-android-arm64,
 * @koromix/koffi-android-x64, @koromix/koffi-linux-arm, import-meta-resolve).
 *
 * The patch was over the 20,000-character per-file cap, so the REL-1136
 * new-package routing did not apply; the shared filter hid the lockfile from
 * every lane; the run estimated 87 tokens, got SHIP, and the check summary
 * said "every change was sent in full". Lockfiles are security-sensitive
 * (REL-1135) and nothing may be dropped silently (REL-1092).
 *
 * The fixtures are the exact GitHub patches of that PR. This file imports only
 * APIs that exist on origin/main, so it runs there as the negative proof.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures/rel1141');
const PR30_LOCK = readFileSync(path.join(FIXTURES, 'openclaw-linear-plugin-30.package-lock.json.patch'), 'utf8');
const PR30_PKG = readFileSync(path.join(FIXTURES, 'openclaw-linear-plugin-30.package.json.patch'), 'utf8');
const NEW_PACKAGES = [
  '@koromix/koffi-android-arm64@3.2.1',
  '@koromix/koffi-android-x64@3.2.1',
  '@koromix/koffi-linux-arm@3.2.1',
  'import-meta-resolve@4.2.0',
];

const HEAD = '6a143677aa3f6b4329791eec6a0a54cd33b4dc71';
const BASE = 'd390b73c4ffce005b6af7dc4cf1d0673fd8e47d8';
const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas = 'architecture,security,documentation') => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const enabled = (personas?: string) => roster(personas).personas.filter((persona) => persona.enabled);
const pr30 = () => [
  { path: 'package-lock.json', patch: PR30_LOCK, mode: '100644' },
  { path: 'package.json', patch: PR30_PKG, mode: '100644' },
];

/** A large, registry-only npm lockfile patch that adds `name`, padded past the per-file cap. */
function oversizedNpmLock(name: string, extra: string[] = []): string {
  const bumps = Array.from({ length: 160 }, (_, index) => [
    `@@ -${100 + index * 20},7 +${100 + index * 20},7 @@`,
    '     },',
    `     "node_modules/pkg-${index}": {`,
    `-      "version": "1.0.${index}",`,
    `-      "resolved": "https://registry.npmjs.org/pkg-${index}/-/pkg-${index}-1.0.${index}.tgz",`,
    `+      "version": "1.1.${index}",`,
    `+      "resolved": "https://registry.npmjs.org/pkg-${index}/-/pkg-${index}-1.1.${index}.tgz",`,
    '       "dev": true,',
  ].join('\n'));
  return [
    ...bumps,
    '@@ -9000,6 +9000,12 @@',
    '       "license": "MIT"',
    '     },',
    `+    "node_modules/${name}": {`,
    '+      "version": "2.0.0",',
    ...(extra.length > 0 ? extra : [`+      "resolved": "https://registry.npmjs.org/${name}/-/${name}-2.0.0.tgz",`]),
    '+      "license": "MIT"',
    '+    },',
    '     "node_modules/zzz": {',
  ].join('\n');
}

afterEach(() => { vi.restoreAllMocks(); });

describe('REL-1141: the exact openclaw-linear-plugin#30 shape', () => {
  it('pins the fixture: a one-line manifest bump beside a lockfile over the per-file cap', () => {
    expect(PR30_LOCK.length).toBe(41_140);
    expect(PR30_LOCK.length).toBeGreaterThan(MAX_FILE_PATCH_CHARS);
    expect(PR30_PKG).toContain('+    "openclaw": "2026.9.5",');
    for (const name of ['@koromix/koffi-android-arm64', '@koromix/koffi-android-x64', '@koromix/koffi-linux-arm', 'import-meta-resolve']) {
      expect(PR30_LOCK).toContain(`+    "node_modules/${name}": {`);
    }
  });

  it('sends the lockfile to the lanes as a complete package-change summary, never hides it', () => {
    const decision = resolveReviewApplicability(enabled(), pr30());
    expect(decision.applicable.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);
    const lock = decision.effectiveFiles.find((file) => file.path === 'package-lock.json');
    expect(lock).toBeDefined();
    for (const pkg of NEW_PACKAGES) expect(lock!.patch).toContain(pkg);
    expect(lock!.patch).toContain('openclaw: 2026.9.4 -> 2026.9.5');
    expect(lock!.patch!.length).toBeLessThanOrEqual(MAX_FILE_PATCH_CHARS);
    // The required lane reads it (routed), not only a lane whose globs happen to match *.json.
    const sec = decision.applicable.find((persona) => persona.id === 'sec-lane')!;
    expect(scopeFilesForPersona(sec, decision.effectiveFiles).map((file) => file.path)).toContain('package-lock.json');
    expect(decision.routedFiles).toContainEqual({ path: 'package-lock.json', laneIds: ['sec-lane'], reason: 'summarized-lockfile' });
    expect(decision.summarizedLockfiles).toEqual([
      { path: 'package-lock.json', originalChars: 41_140, summaryChars: lock!.patch!.length, packageChanges: 54 },
    ]);
    // Summarized, so reviewed: coverage stays complete.
    expect(decision.omittedSourcePaths).toEqual([]);
    expect(decision.unreviewableLockfiles).toEqual([]);
  });

  it('routes it to the dependency lane too when the roster enables one', () => {
    const decision = resolveReviewApplicability(enabled('architecture,security,dependencies'), pr30());
    expect(decision.routedFiles.find((file) => file.path === 'package-lock.json'))
      .toEqual({ path: 'package-lock.json', laneIds: ['sec-lane', 'dep-lane'], reason: 'summarized-lockfile' });
    const dep = decision.applicable.find((persona) => persona.id === 'dep-lane')!;
    const sent = scopeFilesForPersona(dep, decision.effectiveFiles).find((file) => file.path === 'package-lock.json');
    expect(sent?.patch).toContain('import-meta-resolve@4.2.0');
  });

  it('is deterministic: the same patch always yields the same summary', () => {
    const first = resolveReviewApplicability(enabled(), pr30()).effectiveFiles.find((file) => file.path === 'package-lock.json');
    const second = resolveReviewApplicability(enabled(), pr30()).effectiveFiles.find((file) => file.path === 'package-lock.json');
    expect(first?.patch).toBeDefined();
    expect(second?.patch).toBe(first?.patch);
  });

  it('discloses it as "summarized: oversized lockfile" in the check summary', () => {
    const decision = resolveReviewApplicability(enabled(), pr30());
    expect(renderRoutedFiles({ routedFiles: decision.routedFiles }))
      .toContain('`package-lock.json` -> `sec-lane` (summarized: oversized lockfile)');
    const depth = renderReviewDepthDisclosure(decision as unknown as Parameters<typeof renderReviewDepthDisclosure>[0]).join('\n');
    expect(depth).toContain('Summarized: oversized lockfile');
    expect(depth).toContain('- `package-lock.json`: 41,140-character patch -> summary of 54 package change(s)');
  });

  it('never says "every change was sent in full" beside the summarized lockfile', () => {
    const decision = resolveShrunkReviewApplicability(enabled(), pr30(), { diffShrink: { enabled: true } });
    const text = renderDiffShrinkSummary(decision.diffShrink).join('\n');
    expect(text).not.toContain('; every change was sent in full');
    expect(text).toContain('No file was shrunk, but not every change was sent in full');
    expect(text).toContain('`package-lock.json` (summarized: oversized lockfile)');
  });

  it('still says so when every change really was sent in full', () => {
    const decision = resolveShrunkReviewApplicability(enabled(), [{ path: 'src/app.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' }],
      { diffShrink: { enabled: true } });
    expect(renderDiffShrinkSummary(decision.diffShrink).join('\n')).toContain('- No file was shrunk; every change was sent in full.');
  });

  it('both engines give the lanes the summary and carry the disclosure on their result', async () => {
    for (const engine of ['panel', 'composed'] as const) {
      const prompts: string[] = [];
      const result = engine === 'panel'
        ? await executePersonaPanel({
          config: roster(), changedFiles: pr30(), repository: 'calltelemetry/openclaw-linear-plugin', headSha: HEAD,
          client: approvingPanelClient(prompts), requestPolicy: { responseFormat: { type: 'json_object' } }, deterministicRoster: true,
        })
        : await executeComposedReview({
          config: roster(), changedFiles: pr30(), repository: 'calltelemetry/openclaw-linear-plugin', headSha: HEAD,
          client: composedClient(['package.json', 'package-lock.json'], prompts),
        });
      expect(prompts.join('\n')).toContain('import-meta-resolve@4.2.0');
      expect((result as PanelResult).summarizedLockfiles?.map((file) => file.path)).toEqual(['package-lock.json']);
      expect((result as PanelResult).omittedSourcePaths ?? []).toEqual([]);
    }
  }, 60_000);
});

describe('REL-1141: a changed lockfile beside a reviewed diff is never silently filtered', () => {
  it('sends a lockfile that fits the per-file cap in full to the required lane', () => {
    const small = [
      '@@ -10,7 +10,7 @@',
      '     "node_modules/left-pad": {',
      '-      "version": "1.3.0",',
      '-      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",',
      '+      "version": "1.3.1",',
      '+      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.1.tgz",',
      '       "license": "MIT"',
    ].join('\n');
    const decision = resolveReviewApplicability(enabled(), [
      { path: 'package.json', patch: PR30_PKG }, { path: 'package-lock.json', patch: small },
    ]);
    expect(decision.effectiveFiles.find((file) => file.path === 'package-lock.json')?.patch).toBe(small);
    expect(decision.routedFiles).toContainEqual({ path: 'package-lock.json', laneIds: ['sec-lane'], reason: 'changed-lockfile' });
    expect(renderRoutedFiles({ routedFiles: decision.routedFiles })).toContain('(lockfile change, sent in full)');
  });

  it('summarizes an oversized yarn.lock beside source', () => {
    const entries = Array.from({ length: 200 }, (_, index) => [
      `@@ -${10 + index * 10},6 +${10 + index * 10},6 @@`,
      ` "dep-${index}@^1.0.0":`,
      `-  version "1.0.${index}"`,
      `-  resolved "https://registry.yarnpkg.com/dep-${index}/-/dep-${index}-1.0.${index}.tgz#abc"`,
      `+  version "1.1.${index}"`,
      `+  resolved "https://registry.yarnpkg.com/dep-${index}/-/dep-${index}-1.1.${index}.tgz#def"`,
      '   integrity sha512-x',
    ].join('\n')).join('\n');
    expect(entries.length).toBeGreaterThan(MAX_FILE_PATCH_CHARS);
    const decision = resolveReviewApplicability(enabled(), [
      { path: 'src/index.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' }, { path: 'yarn.lock', patch: entries },
    ]);
    const lock = decision.effectiveFiles.find((file) => file.path === 'yarn.lock');
    expect(lock?.patch).toContain('dep-199: 1.0.199 -> 1.1.199');
    expect(decision.summarizedLockfiles.map((file) => [file.path, file.packageChanges])).toEqual([['yarn.lock', 200]]);
  });

  it('summarizes an oversized new-package lockfile even when it is the only change (zero configured lanes)', () => {
    const decision = resolveReviewApplicability(enabled(), [{ path: 'package-lock.json', patch: oversizedNpmLock('brand-new') }]);
    // Reviewed by the required lane (routed) and any lane whose own globs name it -- never exempted.
    expect(decision.applicable.map((persona) => persona.id)).toContain('sec-lane');
    expect(decision.routedFiles).toEqual([{ path: 'package-lock.json', laneIds: ['sec-lane'], reason: 'summarized-lockfile' }]);
    expect(decision.effectiveFiles[0].patch).toContain('brand-new@2.0.0');
    expect(decision.noReviewableContent).toBe(false);
    expect(decision.unmatchedPaths).toEqual([]);
  });
});

describe('REL-1141: fails closed (coverage incomplete) when the lockfile cannot be summarized', () => {
  const beside = (lock: { path: string; patch: string }) => [{ path: 'package.json', patch: PR30_PKG }, { ...lock, mode: '100644' }];

  it.each([
    ['a git source in an oversized npm lockfile', { path: 'package-lock.json', patch: oversizedNpmLock('evil', [
      '+      "resolved": "git+ssh://git@github.com/evil/evil.git#abc",',
    ]) }, /non-registry dependency source|outside a registry/],
    ['a tarball off the registry in an oversized npm lockfile', { path: 'package-lock.json', patch: oversizedNpmLock('evil', [
      '+      "resolved": "https://evil.example.com/evil-2.0.0.tgz",',
    ]) }, /outside the default public registries/],
    ['an oversized pnpm lockfile (no structural parser)', { path: 'pnpm-lock.yaml',
      patch: `@@ -1,3 +1,3 @@\n${'+  /left-pad@1.3.1:\n'.repeat(1500)}` }, /cannot be summarized/],
    ['a lockfile patch GitHub omitted', { path: 'package-lock.json',
      patch: `${PATCH_UNAVAILABLE_MARKER} (omitted by GitHub; 900 changed lines)` }, /omitted/],
  ])('%s', (_label, lock, reason) => {
    const decision = resolveReviewApplicability(enabled(), beside(lock));
    // Lanes still run for the manifest, but the lockfile is named and never counted as reviewed.
    expect(decision.applicable.length).toBeGreaterThan(0);
    expect(decision.effectiveFiles.map((file) => file.path)).not.toContain(lock.path);
    expect(decision.unreviewableLockfiles.map((file) => file.path)).toEqual([lock.path]);
    expect(decision.unreviewableLockfiles[0].reason).toMatch(reason);
    expect(decision.omittedSourcePaths).toContain(lock.path);
    const depth = renderReviewDepthDisclosure(decision as unknown as Parameters<typeof renderReviewDepthDisclosure>[0]).join('\n');
    expect(depth).toContain('Not reviewed: changed lockfile no lane could read in full or as a summary (coverage is incomplete)');
  });

  it('the worker blocks a clean panel whose lockfile could not be summarized, and names the gap', async () => {
    const d = workerDeps({
      ...CLEAN,
      unreviewableLockfiles: [{ path: 'package-lock.json', reason: 'cannot be summarized: it adds a non-registry dependency source' }],
      omittedSourcePaths: ['package-lock.json'],
    } as unknown as Partial<PanelResult>);
    const receipt = await runPublishingReviewWorker(workerEnv(), d as never);
    expect(receipt.verdict).not.toBe('SHIP');
    expect(receipt.conclusion).toBe('failure');
    const summary = summaryOf(d);
    expect(summary).toContain('- `package-lock.json`: cannot be summarized: it adds a non-registry dependency source');
    expect(summary).not.toContain('; every change was sent in full');
  });

  it('the worker ships a clean panel with a summarized lockfile and discloses it', async () => {
    const d = workerDeps({
      ...CLEAN,
      summarizedLockfiles: [{ path: 'package-lock.json', originalChars: 41_140, summaryChars: 2_000, packageChanges: 54 }],
      routedFiles: [{ path: 'package-lock.json', laneIds: ['sec-lane'], reason: 'summarized-lockfile' }],
    } as unknown as Partial<PanelResult>);
    const receipt = await runPublishingReviewWorker(workerEnv(), d as never);
    expect(receipt.conclusion).toBe('success');
    const summary = summaryOf(d);
    expect(summary).toContain('Summarized: oversized lockfile');
    expect(summary).toContain('`package-lock.json` -> `sec-lane` (summarized: oversized lockfile)');
  });
});

describe('REL-1141: the trusted completion side derives the same lanes and coverage', () => {
  const target = { repositoryId: 123, owner: 'calltelemetry', repo: 'openclaw-linear-plugin', prNumber: 30, headSha: HEAD, baseSha: BASE };
  const current = { ...target, open: true, draft: false };
  function prepared(personas: string) {
    const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
      personas, budget: { max_investigation_turns: 3 },
    } });
    return preparePublishingPolicy({ content, source: { repositoryId: 456, repository: 'example/central-policy',
      sha: 'c'.repeat(40), path: 'policy/review.json', contentDigest: sha256(content) } },
    { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' });
  }
  function context(personas: string, changedFiles: Array<{ path: string; patch: string }>) {
    const stored = prepared(personas);
    const gate: StoredReviewGate = {
      coordinates: { ...target, runId: `run_${'1'.repeat(32)}`, policyDigest: stored.policy.effectivePolicyDigest,
        attemptId: `run_${'1'.repeat(32)}-g0-e2`, executionAttempt: 2 },
      reviewGeneration: 0, expectedAppId: 1234, externalId: 'service-gate', checkId: 456,
      creationState: 'bound', desiredState: 'in_progress', desiredVersion: 1, publishedVersion: 1, current: true,
    };
    const exactCurrentDiff = vi.fn<AuthoritativeReviewReader['exactCurrentDiff']>(async () => (
      { current: { ...current }, diff: '', expectedFileCount: changedFiles.length, changedFiles }));
    const options: AuthoritativeCompletionContextOptions = {
      getStoredPrepared: async () => stored,
      readerFactory: async () => ({ currentCandidate: async () => ({ ...current }), exactCurrentDiff }) as never,
      publishingResolver: { resolve: async () => ({ current: { ...current }, prepared: structuredClone(stored),
        identity: buildAuthoritativeReviewIdentity({ requested: target, current, policy: stored.policy }) }) },
    };
    return createAuthoritativeCompletionContext(options)(gate);
  }

  it('#30: requires the same lanes the worker runs, with complete coverage', async () => {
    const files = pr30().map(({ path: filePath, patch }) => ({ path: filePath, patch }));
    // The trusted publishing policy does not enable the dependency persona; the worker is given the same roster.
    const resolved = await context('architecture,security', files);
    const worker = resolveReviewApplicability(enabled('architecture,security'), files);
    expect(resolved.coverage.expectedPersonaIds).toEqual(worker.applicable.map((persona) => persona.id));
    expect(resolved.coverage.expectedPersonaIds).toContain('sec-lane');
    expect(worker.summarizedLockfiles.map((file) => file.path)).toEqual(['package-lock.json']);
    expect(resolved.coverage.coverageComplete).toBe(true);
  });

  it('an unsummarizable oversized lockfile is coverage-incomplete on the trusted side too', async () => {
    const files = [{ path: 'package.json', patch: PR30_PKG }, { path: 'package-lock.json', patch: oversizedNpmLock('evil', [
      '+      "resolved": "git+ssh://git@github.com/evil/evil.git#abc",',
    ]) }];
    const resolved = await context('architecture,security', files);
    expect(resolved.coverage.coverageComplete).toBe(false);
    expect(resolveReviewApplicability(enabled('architecture,security'), files).omittedSourcePaths).toEqual(['package-lock.json']);
  });
});

const CLEAN = {
  applicablePersonaIds: ['sec-lane'],
  personas: [{ id: 'sec-lane', findings: [], turnsCount: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1 }],
  optionalFailures: [],
  quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
  arbiter: { verdict: 'SHIP' },
} as unknown as Partial<PanelResult>;

function workerDeps(panel: Partial<PanelResult>) {
  const checkClient = {
    createCheck: vi.fn<PublishingCheckClient['createCheck']>(async () => 4242),
    completeCheck: vi.fn<PublishingCheckClient['completeCheck']>(async () => undefined),
  };
  return {
    checkClient,
    sourceLoader: vi.fn(async () => ({ diff: 'diff --git a/package.json b/package.json\n@@ -1 +1 @@\n-old\n+new\n', githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: vi.fn(async () => panel) as never,
    client: {} as never,
  };
}

function workerEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test', REVIEW_PUBLICATION_MODE: 'app-gate', REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'calltelemetry/openclaw-linear-plugin', REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_POLICY_DIGEST: 'c'.repeat(64), REVIEW_CONFIG_DIGEST: 'd'.repeat(64), REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_PR_NUMBER: '30', REVIEW_HEAD_SHA: HEAD, REVIEW_BASE_SHA: BASE, REVIEW_MODEL: 'ollama/glm-5.3-flash',
    OPENAI_BASE_URL: 'https://gateway.example.invalid/v1', OPENAI_API_KEY: 'vk-test', GH_TOKEN: 'ghs_test',
  };
}

const summaryOf = (d: ReturnType<typeof workerDeps>) =>
  String(((d.checkClient.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);

function approvingPanelClient(prompts: string[]): ReviewModelClient {
  const complete = async (request: { messages: unknown[]; metadata?: { role?: string } }) => {
    const text = JSON.stringify(request.messages);
    prompts.push(text);
    const nonce = nonceFrom(text);
    const role = request.metadata?.role;
    if (role === 'moderator') return fakeResponse(JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }));
    if (role === 'arbiter') return fakeResponse(JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'ok' }));
    return fakeResponse(JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }));
  };
  return { complete } as unknown as ReviewModelClient;
}

function composedClient(paths: string[], prompts: string[]): ReviewModelClient {
  const complete = async (payload: { messages: unknown[] }) => {
    prompts.push(JSON.stringify(payload.messages));
    const last = payload.messages[payload.messages.length - 1] as { content?: unknown } | undefined;
    const text = typeof last?.content === 'string' ? last.content
      : Array.isArray(last?.content) ? last.content.map((block: { text?: string }) => block.text || '').join('\n') : '';
    const nonce = nonceFrom(text);
    if (text.includes('PLAN TURN')) {
      return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'task-sec', dimension: 'security', paths, question: 'Is it safe?', rationale: 'dependency change' },
      ] }));
    }
    if (text.includes('WORK TURN')) return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
  };
  return { complete } as unknown as ReviewModelClient;
}

function nonceFrom(text: string): string {
  const match = text.match(/CT_REVIEW_NONCE:([^\n"\\]+)/);
  return match ? match[1].trim() : 'nonce';
}

function fakeResponse(content: string) {
  return { model: 'test-model', content, usage: { prompt: 10, completion: 10, total: 20 }, costUSD: 0, raw: {} };
}
