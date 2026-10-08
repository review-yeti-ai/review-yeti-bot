import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { findingFingerprint } from '../../src/review/findingConvergence';
import type { RepoFileProvider } from '../../src/panel/panelEngine';
import { createDockerQualifiedReproductionAdapter, type GroundedReproductionRecipeV1 } from '../../src/review/qualifiedReproduction';

const enabled = process.env.REVIEW_YETI_REPRODUCTION_DOCKER_ACCEPTANCE === '1';
const image = 'node@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';
const repository = 'example-org/grounded-reproduction-fixture';
const baseSha = 'b'.repeat(40);
const headSha = 'a'.repeat(40);
const reviewId = `run_${'1'.repeat(32)}`;
const contextDigest = 'c'.repeat(64);
const sourceWindowManifestDigest = 'd'.repeat(64);
const path = 'src/guard.ts';
const finding = { severity: 'P1' as const, path, line: 1, title: 'Non-admin caller can read protected data' };
const fingerprint = findingFingerprint(finding);
const networkServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(networkServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function providerFor(input: { path?: string; baseContent: string; headContent: string; wrongHeadSha?: boolean }): RepoFileProvider {
  const sourcePath = input.path ?? path;
  return {
    findFiles: async () => [],
    readFile: async () => null,
    readFileAt: async (_requested, side) => {
      const content = side === 'head' ? input.headContent : input.baseContent;
      const revisionSha = side === 'head' ? headSha : baseSha;
      return { content, sha: side === 'head' && input.wrongHeadSha ? 'f'.repeat(40) : revisionSha,
        contentSha256: digest(content), presence: 'present',
        source: { repository, path: sourcePath, side } };
    },
    readDiff: () => ({ patch: '@@ -1 +1 @@\n-old\n+new', identity: { repository, baseSha, headSha } }),
  };
}

async function dockerAdapter(recipe: Record<string, unknown>, limits: Record<string, unknown> = {}) {
  const engine = await import('../../src/review/groundedReviewEngine') as unknown as Record<string, any>;
  const createAdapter = engine.createDockerQualifiedReproductionAdapter;
  expect(typeof createAdapter).toBe('function');
  const dockerBinaryPath = process.env.REVIEW_YETI_DOCKER_BINARY;
  const dockerHost = process.env.REVIEW_YETI_DOCKER_HOST;
  expect(dockerBinaryPath).toBeTruthy();
  expect(dockerHost).toMatch(/^unix:\/\//u);
  return createAdapter({ dockerBinaryPath, dockerHost, runtimeImageDigest: image,
    reviewContext: { reviewId, repository, baseSha, headSha },
    tempRoot: process.env.REVIEW_YETI_DOCKER_TEMP_ROOT ?? '/private/tmp', recipes: [recipe],
    executionTimeoutMs: 3_000, maxOutputBytes: 8_192, ...limits });
}

function request(provider: RepoFileProvider, recipeId = 'ts-guard-v1', currentReviewId = reviewId) {
  return { reviewId: currentReviewId, repository, baseSha, headSha, provider, candidate: { ...finding, fingerprint },
    affectedContextDigest: contextDigest, sourceWindowManifestDigest, recipeId };
}

describe('qualified reproduction source-read bound', () => {
  it('aborts a hung pinned-source read before Docker access', async () => {
    const receivedSignals: AbortSignal[] = [];
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_requestedPath, _side, options) => new Promise((_resolve, reject) => {
        if (!options?.signal) throw new Error('source reader did not receive an abort signal');
        receivedSignals.push(options.signal);
        options.signal.addEventListener('abort', () => reject(new Error('read_aborted')), { once: true });
      }),
      readDiff: () => ({ patch: '@@ -1 +1 @@\n-old\n+new', identity: { repository, baseSha, headSha } }),
    };
    const adapter = createDockerQualifiedReproductionAdapter({ dockerBinaryPath: '/usr/bin/docker',
      dockerHost: 'unix:///tmp/no-docker-socket-for-source-timeout-test', runtimeImageDigest: image,
      reviewContext: { reviewId, repository, baseSha, headSha }, sourceReadTimeoutMs: 50,
      recipes: [{ version: 'GroundedReproductionRecipe.v1', id: 'ts-guard-v1', repository,
        candidatePath: path, exportName: 'canRead', args: [], expectedBase: false, expectedHead: true }] });

    const receipt = await adapter.reproduce(request(provider));

    expect(receipt).toMatchObject({ status: 'unavailable', reason: 'source_read_timeout',
      identity: { reviewId, repository, baseSha, headSha } });
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals.every((signal) => signal.aborted)).toBe(true);
    expect(receipt.limits).toMatchObject({ sourceReadTimeoutMs: 50 });
  });

  it('aborts a sibling pinned-source read when the other side rejects early', async () => {
    let headSignal: AbortSignal | undefined;
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_requestedPath, side, options) => {
        if (side === 'base') throw new Error('base_read_failed');
        headSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          if (!headSignal) throw new Error('head source reader did not receive an abort signal');
          headSignal.addEventListener('abort', () => reject(new Error('head_read_aborted')), { once: true });
        });
      },
      readDiff: () => ({ patch: '@@ -1 +1 @@\n-old\n+new', identity: { repository, baseSha, headSha } }),
    };
    const adapter = createDockerQualifiedReproductionAdapter({ dockerBinaryPath: '/usr/bin/docker',
      dockerHost: 'unix:///tmp/no-docker-socket-for-sibling-abort-test', runtimeImageDigest: image,
      reviewContext: { reviewId, repository, baseSha, headSha }, sourceReadTimeoutMs: 4_000,
      recipes: [{ version: 'GroundedReproductionRecipe.v1', id: 'ts-guard-v1', repository,
        candidatePath: path, exportName: 'canRead', args: [], expectedBase: false, expectedHead: true }] });

    const receipt = await adapter.reproduce(request(provider));

    expect(receipt).toMatchObject({ status: 'unavailable', reason: 'pinned_source_read_failed' });
    expect(headSignal?.aborted).toBe(true);
  });
});

describe('qualified reproduction review and limit binding', () => {
  it('clamps trusted option overrides and rejects reuse across a second review', async () => {
    const recipe: GroundedReproductionRecipeV1 = { version: 'GroundedReproductionRecipe.v1', id: 'ts-guard-v1', repository,
      candidatePath: path, exportName: 'canRead', args: [], expectedBase: false, expectedHead: true };
    const limits = { executionBudgetMs: 30_000, executionTimeoutMs: 30_000, maxOutputBytes: 32_000,
      sourceReadTimeoutMs: 30_000, controlPlaneTimeoutMs: 90_000 };
    const adapter = createDockerQualifiedReproductionAdapter({ dockerBinaryPath: '/usr/bin/docker',
      dockerHost: 'unix:///tmp/no-docker-socket-for-review-scope-test', runtimeImageDigest: image,
      reviewContext: { reviewId, repository, baseSha, headSha }, recipes: [recipe], ...limits });
    const content = 'export function canRead() { return false; }\n';

    const first = await adapter.reproduce(request(providerFor({ baseContent: content, headContent: content, wrongHeadSha: true })));
    const secondReview = await adapter.reproduce(request(providerFor({ baseContent: content, headContent: content }),
      'ts-guard-v1', `run_${'2'.repeat(32)}`));
    const secondReviewAdapter = createDockerQualifiedReproductionAdapter({ dockerBinaryPath: '/usr/bin/docker',
      dockerHost: 'unix:///tmp/no-docker-socket-for-review-scope-test', runtimeImageDigest: image,
      reviewContext: { reviewId: `run_${'2'.repeat(32)}`, repository, baseSha, headSha }, recipes: [recipe], ...limits });
    const secondReviewFreshAdapter = await secondReviewAdapter.reproduce(request(providerFor({
      baseContent: content, headContent: content, wrongHeadSha: true,
    }), 'ts-guard-v1', `run_${'2'.repeat(32)}`));

    expect(first).toMatchObject({ status: 'rejected', reason: 'source_revision_mismatch',
      limits: { executionBudgetMs: 15_000, executionTimeoutMs: 5_000, maxOutputBytes: 8_192,
        sourceReadTimeoutMs: 4_000, controlPlaneTimeoutMs: 12_000, cleanupTimeoutMs: 8_000 } });
    expect(secondReview).toMatchObject({ status: 'rejected', reason: 'review_context_mismatch',
      identity: { reviewId: `run_${'2'.repeat(32)}` } });
    expect(secondReviewFreshAdapter).toMatchObject({ status: 'rejected', reason: 'source_revision_mismatch',
      identity: { reviewId: `run_${'2'.repeat(32)}` } });
  });
});

describe.skipIf(!enabled)('qualified Docker source reproduction acceptance', () => {
  it('reproduces a public TypeScript guard difference at both exact revisions in a pinned isolated container', async () => {
    const baseContent = 'export function canRead(user: { admin: boolean }) { return user.admin; }\n';
    const headContent = 'export function canRead(user: { admin: boolean }) { return true; }\n';
    const adapter = await dockerAdapter({ version: 'GroundedReproductionRecipe.v1', id: 'ts-guard-v1', repository,
      candidatePath: path, exportName: 'canRead', args: [{ admin: false }], expectedBase: false, expectedHead: true },
    { executionBudgetMs: 30_000, executionTimeoutMs: 9_000, maxOutputBytes: 32_000,
      sourceReadTimeoutMs: 30_000, controlPlaneTimeoutMs: 90_000 });

    const receipt = await adapter.reproduce(request(providerFor({ baseContent, headContent })));

    expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: 'observed', identity: { repository, baseSha, headSha,
      candidateFingerprint: fingerprint, path, affectedContextDigest: contextDigest,
      sourceWindowManifestDigest }, recipe: { id: 'ts-guard-v1' },
      sourceManifest: { files: [{ path, baseContentSha256: digest(baseContent), headContentSha256: digest(headContent),
        baseRevisionSha: baseSha, headRevisionSha: headSha }] },
      sandbox: { runtimeImageDigest: image, networkMode: 'none', readOnlyRootfs: true,
        capDropAll: true, noNewPrivileges: true, hostSocketMounted: false,
        pidsLimit: 16, memoryBytes: 268_435_456, nanoCpus: 250_000_000 },
      limits: { executionBudgetMs: 15_000, executionTimeoutMs: 5_000, maxOutputBytes: 8_192,
        sourceReadTimeoutMs: 4_000, controlPlaneTimeoutMs: 12_000, cleanupTimeoutMs: 8_000 },
      observations: { baseMatchesExpected: true, headMatchesExpected: true } });
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    const secondReview = await adapter.reproduce(request(providerFor({ baseContent, headContent }), 'ts-guard-v1', `run_${'2'.repeat(32)}`));
    expect(secondReview).toMatchObject({ status: 'rejected', reason: 'review_context_mismatch',
      identity: { reviewId: `run_${'2'.repeat(32)}` } });
  }, 30_000);

  it('rejects a source revision mismatch before attaching a reproduction receipt', async () => {
    const content = 'export function canRead() { return false; }\n';
    const adapter = await dockerAdapter({ version: 'GroundedReproductionRecipe.v1', id: 'ts-guard-v1', repository,
      candidatePath: path, exportName: 'canRead', args: [], expectedBase: false, expectedHead: false });

    const receipt = await adapter.reproduce(request(providerFor({ baseContent: content,
      headContent: content, wrongHeadSha: true })));

    expect(receipt).toMatchObject({ status: 'rejected', reason: 'source_revision_mismatch',
      identity: { repository, baseSha, headSha, candidateFingerprint: fingerprint } });
    expect(receipt.sandbox).toBeUndefined();
  });

  it('reports a hard timeout as unavailable and stops the untrusted container', async () => {
    const baseContent = 'export function canRead() { return false; }\n';
    const headContent = 'export function canRead() { while (true) {} }\n';
    const adapter = await dockerAdapter({ version: 'GroundedReproductionRecipe.v1', id: 'ts-loop-v1', repository,
      candidatePath: path, exportName: 'canRead', args: [], expectedBase: false, expectedHead: true },
    { executionTimeoutMs: 1_500 });

    const receipt = await adapter.reproduce(request(providerFor({ baseContent, headContent }), 'ts-loop-v1'));

    expect(receipt).toMatchObject({ status: 'unavailable', reason: 'execution_timeout',
      executions: [{ side: 'base', exitStatus: 0 }, { side: 'head', exitStatus: 'timeout' }],
      sandbox: { networkMode: 'none', readOnlyRootfs: true, capDropAll: true, noNewPrivileges: true } });
    const remaining = execFileSync(process.env.REVIEW_YETI_DOCKER_BINARY!, ['--host', process.env.REVIEW_YETI_DOCKER_HOST!,
      'ps', '-aq', '--filter', 'name=review-yeti-repro-'], { encoding: 'utf8', env: {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/private/tmp',
      DOCKER_CONFIG: process.env.REVIEW_YETI_DOCKER_CONFIG ?? '/private/tmp', NODE_ENV: 'production',
    } });
    expect(remaining.trim()).toBe('');
  }, 30_000);

  it('keeps a source-controlled network probe offline and mounts no host socket', async () => {
    let hostRequests = 0;
    const server = createServer((_request, response) => { hostRequests += 1; response.end('host-network-visible'); });
    networkServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected an IPv4 loopback listener');
    const baseContent = "export async function canRead() { return 'blocked'; }\n";
    const headContent = `export async function canRead() { try { const response = await fetch('http://host.docker.internal:${address.port}', { signal: AbortSignal.timeout(350) }); return await response.text(); } catch { return 'blocked'; } }\n`;
    const adapter = await dockerAdapter({ version: 'GroundedReproductionRecipe.v1', id: 'ts-network-v1', repository,
      candidatePath: path, exportName: 'canRead', args: [], expectedBase: 'blocked', expectedHead: 'host-network-visible' });

    const receipt = await adapter.reproduce(request(providerFor({ baseContent, headContent }), 'ts-network-v1'));

    expect(hostRequests).toBe(0);
    expect(receipt.sandbox).toMatchObject({ networkMode: 'none', hostSocketMounted: false });
    expect(receipt.observations).toMatchObject({ baseMatchesExpected: true, headMatchesExpected: false });
    expect(receipt.status).toBe('not_observed');
  }, 30_000);

  it('rejects network-addressed Docker endpoints before any reproduction attempt', async () => {
    const engine = await import('../../src/review/groundedReviewEngine') as unknown as Record<string, any>;
    expect(() => engine.createDockerQualifiedReproductionAdapter({ dockerBinaryPath: '/usr/bin/docker',
      dockerHost: 'tcp://127.0.0.1:2375', runtimeImageDigest: image, recipes: [] })).toThrow(/local Unix socket/u);
  });
});
