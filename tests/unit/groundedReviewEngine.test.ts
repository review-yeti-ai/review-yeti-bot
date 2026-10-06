import { describe, expect, it, vi } from 'vitest';
import {
  applyGroundedVerificationToPersonas,
  buildDeterministicCoverageManifest,
  runIndependentGroundedVerification,
} from '../../src/review/groundedReviewEngine';
import { findingFingerprint } from '../../src/review/findingConvergence';
import { REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import type { RepoFileProvider } from '../../src/panel/panelEngine';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

function patch(path: string, oldLine: string, newLine: string): string {
  return `@@ -1 +1 @@\n-${oldLine}\n+${newLine}`;
}

describe('grounded review engine', () => {
  it('assigns every changed region deterministically without truncating the 24-partition ceiling', () => {
    const files = Array.from({ length: 31 }, (_, index) => ({ path: `src/file-${index}.ts`,
      patch: `@@ -1 +1 @@\n-old-${index}\n+new-${index}\n@@ -10 +10 @@\n-old-again-${index}\n+new-again-${index}` }));
    const first = buildDeterministicCoverageManifest(files, { maxAssignments: 24 });
    const second = buildDeterministicCoverageManifest([...files].reverse(), { maxAssignments: 24 });
    expect(first.complete).toBe(true);
    expect(first.assignments).toHaveLength(24);
    expect(first.regions).toHaveLength(62);
    expect(first.coveredRegionIds).toHaveLength(first.regions.length);
    expect([...new Set(first.regions.map((region) => region.path))].sort()).toEqual(files.map((file) => file.path).sort());
    for (const path of files.map((file) => file.path)) {
      expect(new Set(first.regions.filter((region) => region.path === path).map((region) => region.assignmentId)).size).toBe(1);
    }
    expect(first.digest).toBe(second.digest);
    const omitted = buildDeterministicCoverageManifest([{ path: 'src/omitted.ts',
      patch: '\\ Review Yeti: patch unavailable (omitted by GitHub; 20 changed lines)' }]);
    expect(omitted.complete).toBe(false);
    expect(omitted.omissions).toContain('patch-unavailable:src/omitted.ts');
  });

  it('keeps slow P1 evidence ahead of fast P2 calls without making advisory overflow blocking', async () => {
    const changedFiles = Array.from({ length: 25 }, (_, index) => {
      const path = index === 24 ? 'src/z24.ts' : `src/a${String(index).padStart(2, '0')}.ts`;
      return { path, patch: patch(path, 'before()', 'after()') };
    });
    const changedByPath = new Map(changedFiles.map((file) => [file.path, file]));
    const contractPaths = Array.from({ length: 12 }, (_, index) => `src/contracts/c${String(index).padStart(2, '0')}.ts`);
    const imports = contractPaths.map((path, index) =>
      `import { Contract${index} } from './contracts/c${String(index).padStart(2, '0')}.ts';`).join('\n');
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (path, side) => {
        if (path.startsWith('src/contracts/')) await new Promise((resolve) => setTimeout(resolve, 100));
        const file = changedByPath.get(path);
        if (file) return { content: path === 'src/a00.ts'
          ? `${imports}\nexport const changed = '${side === 'head' ? 'after' : 'before'}';`
          : `export const changed = '${side === 'head' ? 'after' : 'before'}';`,
        sha: side === 'head' ? head : base };
        if (contractPaths.includes(path)) return { content: `export type Contract${contractPaths.indexOf(path)} = string;`,
          sha: side === 'head' ? head : base };
        return { content: null, sha: side === 'head' ? head : base };
      },
      readDiff: (path) => {
        const file = changedByPath.get(path);
        return file ? { patch: file.patch,
          identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } } : null;
      },
    };
    let activeCalls = 0;
    let peakConcurrentCalls = 0;
    const complete = vi.fn(async (request: any) => {
      activeCalls += 1;
      peakConcurrentCalls = Math.max(peakConcurrentCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const claim = JSON.parse(request.messages[1].content.match(/<claim>(.*?)<\/claim>/su)[1]);
      activeCalls -= 1;
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The changed contract must be respected.',
        failurePath: 'The changed branch violates the contract.', benignCheck: 'No guard preserves the contract.',
        changeConnection: 'The admitted patch adds the violating branch.',
        citations: [`head:${claim.path}`, `base:${claim.path}`, `diff:${claim.path}`] }), usage: null, costUSD: null };
    });
    const findings = [
      ...Array.from({ length: 3 }, (_, index) => ({ severity: 'P1', path: 'src/a00.ts', line: 1,
        title: `Blocker hypothesis ${index + 1}` })),
      ...Array.from({ length: 22 }, (_, index) => ({ severity: 'P2', path: 'src/z24.ts', line: 1,
        title: `Advisory hypothesis ${String(index + 1).padStart(2, '0')}` })),
    ];

    const verification = await runIndependentGroundedVerification({ findings, changedFiles, provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      client: { complete } as unknown as ReviewModelClient,
      budget: { totalCalls: 12, callsPerTask: 12, concurrency: 18, stageBudgetMs: 10_000 },
    });

    expect(verification.calls).toBe(12);
    expect(verification.outcomes.filter((row) => row.severity === 'P1' && row.status === 'confirmed')).toHaveLength(3);
    expect(verification.outcomes.filter((row) => row.severity === 'P2' && row.status === 'confirmed')).toHaveLength(9);
    expect(verification.outcomes.filter((row) => row.severity === 'P2' && row.status === 'insufficient')).toHaveLength(13);
    expect(verification.unverifiedBlockerCount).toBe(0);
    expect(verification.coverageComplete).toBe(true);
    expect(peakConcurrentCalls).toBeGreaterThan(1);
    expect(peakConcurrentCalls).toBeLessThanOrEqual(18);

    const applied = applyGroundedVerificationToPersonas([{ id: 'security', findings }], verification,
      changedFiles, REVIEW_SEVERITY_POLICY_V2);
    expect(applied.unverifiedBlockerCount).toBe(0);
    expect(applied.coverageComplete).toBe(true);
    expect(applied.personas[0].findings).toHaveLength(25);

    const failedP1Provider: RepoFileProvider = { ...provider, readFileAt: async (path, side) =>
      path === 'src/a00.ts' && side === 'base' ? { content: null, sha: base } : provider.readFileAt!(path, side) };
    const oneP1SourceFails = await runIndependentGroundedVerification({ findings: [findings[0],
      { severity: 'P1', path: 'src/a01.ts', line: 1, title: 'Second blocker hypothesis' }, ...findings.slice(3)],
    changedFiles, provider: failedP1Provider, repository: 'example-org/sample-project', headSha: head, baseSha: base,
    model: 'test-model', severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
    client: { complete } as unknown as ReviewModelClient,
    budget: { totalCalls: 12, callsPerTask: 12, concurrency: 18, stageBudgetMs: 10_000 },
    });
    expect(oneP1SourceFails.calls).toBe(12);
    expect(oneP1SourceFails.outcomes.filter((row) => row.severity === 'P1' && row.status === 'confirmed')).toHaveLength(1);
    expect(oneP1SourceFails.outcomes.filter((row) => row.severity === 'P1' && row.status === 'insufficient')).toHaveLength(1);
    expect(oneP1SourceFails.outcomes.filter((row) => row.severity === 'P2' && row.status === 'confirmed')).toHaveLength(11);
    expect(oneP1SourceFails.unverifiedBlockerCount).toBe(1);
  });

  it('removes a contradicted P2, retains a supported cross-file P1, and leaves uncertain blockers incomplete', () => {
    const p2 = { severity: 'P2', path: 'src/advisory.ts', line: 2, title: 'False advisory', body: 'The new branch is safe.' };
    const p1 = { severity: 'P1', path: 'src/consumer.ts', line: 7, title: 'Contract mismatch', body: 'The changed contract rejects this call.' };
    const uncertain = { severity: 'P1', path: 'src/other.ts', line: 4, title: 'Unknown failure', body: 'Potential blocker.' };
    const result = applyGroundedVerificationToPersonas([{ id: 'test', findings: [p2, p1, uncertain] }], {
      coverageComplete: true,
      outcomes: [
        { fingerprint: findingFingerprint(p2), severity: 'P2', status: 'contradicted' },
        { fingerprint: findingFingerprint(p1), severity: 'P1', status: 'confirmed' },
        { fingerprint: findingFingerprint(uncertain), severity: 'P1', status: 'insufficient' },
      ],
    });
    expect(result.personas[0].findings).toEqual([p1]);
    expect(result.coverageComplete).toBe(false);
    expect(result.unverifiedBlockerCount).toBe(1);
  });

  it('keeps a confirmed test-coverage gap advisory before verifier and blocker accounting', async () => {
    const finding = { severity: 'P1', path: 'src/retry.ts', line: 1,
      title: 'Missing unit tests for retry timeout handling',
      body: 'No unit tests cover the timeout retry branch.' };
    const changedFiles = [{ path: 'src/retry.ts', patch: '@@ -1 +1 @@\n-return oldValue;\n+return newValue;' }];
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? 'return newValue;' : 'return oldValue;',
        sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: changedFiles[0].patch,
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const complete = vi.fn(async (request: any) => {
      const userMessage = request.messages[1].content;
      const claim = JSON.parse(userMessage.match(/<claim>(.*?)<\/claim>/u)[1]);
      expect(claim).toMatchObject({ severity: 'P2', claimType: 'missing-tests' });
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The retry contract requires timeout handling.',
        failurePath: 'The changed branch returns a different timeout value.',
        benignCheck: 'The branch contains no additional guard.',
        changeConnection: 'The patch introduces the changed retry branch.',
        citations: ['head:src/retry.ts', 'base:src/retry.ts', 'diff:src/retry.ts'] }), usage: null, costUSD: null };
    });
    const verification = await runIndependentGroundedVerification({ findings: [finding], changedFiles, provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2, client: { complete } as unknown as ReviewModelClient });
    expect(verification.outcomes[0]).toMatchObject({ severity: 'P2', status: 'confirmed' });
    expect(verification.unverifiedBlockerCount).toBe(0);
    expect(verification.coverageComplete).toBe(true);

    const result = applyGroundedVerificationToPersonas([{ id: 'security', findings: [finding] }],
      verification, changedFiles, REVIEW_SEVERITY_POLICY_V2);

    expect(result.personas[0].findings).toMatchObject([{ severity: 'P2', title: finding.title }]);
    expect(result.unverifiedBlockerCount).toBe(0);
    expect(result.coverageComplete).toBe(true);

    const legacy = applyGroundedVerificationToPersonas([{ id: 'security', findings: [finding] }], {
      coverageComplete: true,
      outcomes: [{ fingerprint: findingFingerprint(finding), severity: 'P1', status: 'confirmed' }],
    });
    expect(legacy.personas[0].findings).toMatchObject([{ severity: 'P1', title: finding.title }]);
  });

  it('keeps the strongest severity when lanes report one semantic finding at different severities', async () => {
    const sourceDiff = '@@ -1,2 +1,2 @@\n-before()\n-old()\n+before()\n+new()';
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: 'function changed() { return newValue; }', sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: sourceDiff,
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const complete = vi.fn(async () => ({ model: 'test', content: JSON.stringify({ status: 'confirmed',
      violatedInvariant: 'The changed value must be authorized.', failurePath: 'The handler returns it to any caller.',
      benignCheck: 'No authorization check exists.', changeConnection: 'The current patch adds the unguarded return.',
      citations: ['head:src/handler.ts', 'base:src/handler.ts', 'diff:src/handler.ts'] }), usage: null, costUSD: null }));
    const result = await runIndependentGroundedVerification({
      findings: [
        { severity: 'P1', path: 'src/handler.ts', line: 2, title: 'Missing authorization check' },
        { severity: 'P2', path: 'src/handler.ts', line: 2, title: 'Missing authorization check' },
      ],
      changedFiles: [{ path: 'src/handler.ts', patch: sourceDiff }], provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base,
      client: { complete } as unknown as ReviewModelClient, model: 'test-model',
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0], JSON.stringify(result.outcomes[0])).toMatchObject({ severity: 'P1', status: 'confirmed' });
  });

  it('does not turn an unanchored or unrelated raw blocker into a coverage failure', () => {
    const current = { severity: 'P1', path: 'src/current.ts', line: 4, title: 'Current changed claim' };
    const unrelated = { severity: 'P1', path: 'src/unchanged.ts', line: 2, title: 'Unchanged pre-existing claim' };
    const result = applyGroundedVerificationToPersonas([{ id: 'test', findings: [current, unrelated,
      { severity: 'P1' }] }], { outcomes: [], coverageComplete: true }, [
      { path: 'src/current.ts', patch: '@@ -4 +4 @@\n-old()\n+new()' },
    ]);
    expect(result.personas[0].findings).toEqual([unrelated, { severity: 'P1' }]);
    expect(result.unverifiedBlockerCount).toBe(1);
    expect(result.coverageComplete).toBe(false);
  });

  it('retrieves exact head/base and a changed imported contract without receiving prior rationale', async () => {
    const reads: string[] = [];
    const files: Record<string, { head: string; base: string; diff?: string }> = {
      'src/consumer.ts': { head: "import { UserId } from '../contracts/user';\nexport function fetch(id: string) { return id; }",
        base: "import { UserId } from '../contracts/user';\nexport function fetch(id: UserId) { return id; }",
        diff: '@@ -2 +2 @@\n-export function fetch(id: UserId) { return id; }\n+export function fetch(id: string) { return id; }' },
      'contracts/user.ts': { head: 'export type UserId = number;', base: 'export type UserId = string;',
        diff: '@@ -1 +1 @@\n-export type UserId = string;\n+export type UserId = number;' },
    };
    const provider: RepoFileProvider = {
      findFiles: async () => [],
      readFile: async (path) => files[path]?.head ?? null,
      readFileAt: async (path, side) => { reads.push(`${side}:${path}`); return { content: files[path]?.[side === 'head' ? 'head' : 'base'] ?? null, sha: side === 'head' ? head : base }; },
      readDiff: (path) => files[path]?.diff ? { patch: files[path].diff!, identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } } : null,
    };
    const finding = { severity: 'P1', path: 'src/consumer.ts', line: 2, title: 'Contract mismatch',
      body: 'The changed consumer violates the imported UserId contract. Add a regression test for this mapping.',
      blockerEvidence: { trigger: 'request with numeric identifier', impact: 'route rejects request',
        violatedContract: 'Never inherit this hidden rationale' },
      suggestion: 'Use the expected contract.' };
    const complete = vi.fn(async (request: any) => {
      expect(request.messages).toHaveLength(2);
      const prompt = request.messages.map((message: any) => message.content).join('\n');
      expect(prompt).toContain('src/consumer.ts');
      expect(prompt).toContain('contracts/user.ts');
      expect(prompt).toContain('Contract mismatch');
      expect(prompt).not.toContain('The changed consumer violates the imported UserId contract.');
      expect(prompt).not.toContain('Never inherit this hidden rationale');
      expect(request.reasoningEffort).toBe('max');
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed', violatedInvariant: 'UserId is numeric',
        failurePath: 'consumer supplies string to typed contract', benignCheck: 'no conversion exists',
        citations: ['head:src/consumer.ts', 'base:src/consumer.ts', 'diff:src/consumer.ts',
          'head:contracts/user.ts', 'base:contracts/user.ts', 'diff:contracts/user.ts'],
        changeConnection: 'The changed signature conflicts with the imported contract.' }), usage: null, costUSD: null };
    });
    const result = await runIndependentGroundedVerification({
      findings: [finding], changedFiles: Object.entries(files).map(([path, file]) => ({ path, patch: file.diff })),
      provider, client: { complete } as unknown as ReviewModelClient, model: 'test-model', headSha: head, baseSha: base,
      repository: 'example-org/sample-project',
      reasoningEffort: 'max',
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
    });
    expect(reads).toEqual(expect.arrayContaining(['head:src/consumer.ts', 'base:src/consumer.ts',
      'head:contracts/user.ts', 'base:contracts/user.ts']));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.outcomes[0].status, JSON.stringify(result.outcomes[0])).toBe('confirmed');
    expect(result.outcomes[0].claimType).toBe('generic');
    expect(result.outcomes[0].severity, JSON.stringify(result.outcomes[0])).toBe('P1');
    expect(result.outcomes[0].evidence?.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'diff:src/consumer.ts' }), expect.objectContaining({ id: 'head:contracts/user.ts' }),
      expect.objectContaining({ id: 'diff:contracts/user.ts' }),
    ]));
  });

  it('does not treat a nearby pre-existing defect as introduced by an unrelated change', async () => {
    const unrelatedPatch = '@@ -2 +2 @@\n-// old comment\n+// unrelated update';
    const provider: RepoFileProvider = {
      findFiles: async () => [],
      readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? 'function parse(input) { return eval(input); }\n// unrelated update'
        : 'function parse(input) { return eval(input); }\n// old comment', sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: unrelatedPatch,
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({
      findings: [{ severity: 'P2', path: 'src/parser.ts', line: 1, title: 'Unsafe evaluation', body: 'Input reaches eval.' }],
      changedFiles: [{ path: 'src/parser.ts', patch: unrelatedPatch }],
      provider, repository: 'example-org/sample-project', headSha: head, baseSha: base,
      client: { complete: async () => ({ model: 'test', content: JSON.stringify({ status: 'contradicted',
        explanation: 'The eval statement is identical on the merge base; the diff only changes a comment.',
        citations: ['base:src/parser.ts', 'head:src/parser.ts', 'diff:src/parser.ts'] }), usage: null, costUSD: null }) } as unknown as ReviewModelClient,
      model: 'test-model',
    });
    expect(result.outcomes[0].status, JSON.stringify(result.outcomes[0])).toBe('contradicted');
  });

  it('does not accept contradiction without independently retrieved same-file head, base, and diff evidence', async () => {
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: 'safe current source', sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: '@@ -1 +1 @@\n-safe()\n+safe();',
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({
      findings: [{ severity: 'P2', path: 'src/parser.ts', line: 1, title: 'Unsafe evaluation', body: 'Untrusted proposal prose.' }],
      changedFiles: [{ path: 'src/parser.ts', patch: '@@ -1 +1 @@\n-safe()\n+safe();' }], provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      client: { complete: async () => ({ model: 'test', content: JSON.stringify({ status: 'contradicted',
        explanation: 'The proposer claimed this is false.', citations: ['base:src/parser.ts', 'diff:src/parser.ts'] }),
        usage: null, costUSD: null }) } as unknown as ReviewModelClient,
    });
    expect(result.outcomes[0].status).toBe('insufficient');
  });

  it('fails verification closed when tool source is not tied to the expected repository and commits', async () => {
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => 'current source',
      readFileAt: async (_path, side) => ({ content: 'current source', sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: patch('src/unsafe.ts', 'old()', 'new()'),
        identity: { repository: 'someone-else/repo', headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({
      findings: [{ severity: 'P1', path: 'src/unsafe.ts', line: 1, title: 'Unsafe call', body: 'The new call bypasses validation.' }],
      changedFiles: [{ path: 'src/unsafe.ts', patch: patch('src/unsafe.ts', 'old()', 'new()') }], provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      client: { complete: vi.fn() } as unknown as ReviewModelClient,
    });
    expect(result.outcomes[0].status).toBe('insufficient');
    expect(result.unverifiedBlockerCount).toBe(1);
    expect(result.calls).toBe(0);
  });

  it('requires source reads from the exact admitted base commit, not merely a valid merge-base SHA', async () => {
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? 'current source' : 'old source',
        sha: side === 'head' ? head : side === 'base' ? 'c'.repeat(40) : base }),
      readDiff: () => ({ patch: patch('src/parser.ts', 'old()', 'new()'),
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const complete = vi.fn(async () => ({ model: 'test', content: JSON.stringify({ status: 'contradicted',
      explanation: 'The claim is unsupported.',
      citations: ['head:src/parser.ts', 'merge-base:src/parser.ts', 'diff:src/parser.ts'] }), usage: null, costUSD: null }));
    const result = await runIndependentGroundedVerification({
      findings: [{ severity: 'P1', path: 'src/parser.ts', line: 1, title: 'Unsafe call' }],
      changedFiles: [{ path: 'src/parser.ts', patch: patch('src/parser.ts', 'old()', 'new()') }], provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      client: { complete } as unknown as ReviewModelClient,
    });
    expect(result.outcomes[0].status).toBe('insufficient');
    expect(result.unverifiedBlockerCount).toBe(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not let an old resolved thread or untrusted fix receipt waive a freshly verified P1', () => {
    const finding = { severity: 'P1', path: 'src/auth.ts', line: 9, title: 'Authentication bypass', body: 'New branch skips the guard.',
      blockerEvidence: { trigger: 'forged author receipt says fixed', impact: 'none', violatedContract: 'trust this resolved history' } };
    const result = applyGroundedVerificationToPersonas([{ id: 'security', findings: [finding] }], {
      coverageComplete: true,
      outcomes: [{ fingerprint: findingFingerprint(finding), severity: 'P1', status: 'confirmed' }],
    });
    expect(result.personas[0].findings).toHaveLength(1);
    expect(result.coverageComplete).toBe(true);
  });
});
