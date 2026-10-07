import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import * as benchmark from '../../scripts/competitive-review-benchmark.mjs';
import { resolveComposedEngineMaxTurns } from '../../src/panel/composedEngine';

const manifest = {
  schemaVersion: 'review-yeti-competitive-benchmark-manifest-v1',
  datasetSha256: benchmark.AACR_BENCHMARK.sha256,
  cases: [{ id: 'aacr-js-7', repository: 'example/repo', prNumber: 7, language: 'JavaScript' }],
};

function referenceRows() {
  const rows = [];
  for (const label of [1, 0]) {
    for (const context of ['Diff Level', 'File Level', 'Repo Level']) {
      rows.push({
        label,
        note: label ? 'A concrete claim about a changed path.' : 'This claim does not describe a defect.',
        path: 'src/app.js',
        side: 'RIGHT',
        from_line: 12,
        to_line: 13,
        context,
        category: 'logic',
        pr_url: 'https://github.com/example/repo/pull/7',
        pr_source_commit: 'a'.repeat(40),
        pr_target_commit: 'b'.repeat(40),
      });
    }
  }
  return rows;
}

function createPinnedGitFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-pinned-git-source-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  git(['init', '--quiet', directory]);
  git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  git(['config', 'user.name', 'Benchmark Fixture']);
  git(['config', 'user.email', 'benchmark-fixture@example.invalid']);
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'src/changed.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(directory, 'src/deleted.ts'), 'export const removed = true;\n');
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'base']);
  const baseSha = git(['rev-parse', 'HEAD']).trim();

  fs.writeFileSync(path.join(directory, 'src/changed.ts'), 'export const value = 2;\n');
  fs.writeFileSync(path.join(directory, 'src/added.ts'), 'export const added = true;\n');
  fs.rmSync(path.join(directory, 'src/deleted.ts'));
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'head']);
  const headSha = git(['rev-parse', 'HEAD']).trim();
  const changedPaths = git(['diff', '--name-only', '-z', baseSha, headSha]).split('\0').filter(Boolean);
  const changedFiles = changedPaths.map((filePath) => {
    const patch = git(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--full-index', '--unified=5', baseSha, headSha, '--', filePath]);
    return { path: filePath, patch, originalPatchLength: Buffer.byteLength(patch, 'utf8') };
  });
  return { directory, git, snapshot: { repository: 'example/repo', baseSha, headSha, changedFiles } };
}

describe('competitive review benchmark input boundaries', () => {
  it('rejects a modified manifest that retains the pinned AACR dataset hash', () => {
    const canonicalBytes = fs.readFileSync(path.join(process.cwd(),
      'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json'));
    const binding = benchmark.assertCanonicalHeldoutManifestBytes(canonicalBytes);
    expect(binding).toMatchObject({
      sha256: benchmark.AACR_HELDOUT_MANIFEST_SHA256,
      manifest: { datasetSha256: benchmark.AACR_BENCHMARK.sha256 },
    });
    const ids = binding.manifest.cases.map((entry: { id: string }) => entry.id);
    expect(benchmark.assertExactCaseIdSet(ids, ids)).toBe(true);
    expect(() => benchmark.assertExactCaseIdSet([...ids.slice(0, -1), ids[0]], ids))
      .toThrow('discovery_input_case_ids_do_not_match_fixed_panel');

    const modified = JSON.parse(canonicalBytes.toString('utf8'));
    modified.cases[0].repository = 'attacker/repo';
    expect(() => benchmark.assertCanonicalHeldoutManifestBytes(Buffer.from(JSON.stringify(modified))))
      .toThrow('heldout_manifest_digest_mismatch');
  });

  it('rejects discovery bundles that expose labels or oracle rows to the reviewer', () => {
    expect(benchmark.assertBlindDiscoveryInputCases([{ caseId: 'opaque', diff: 'public source' }])).toBe(true);
    expect(() => benchmark.assertBlindDiscoveryInputCases([{ caseId: 'opaque', expectedLabel: 1 }]))
      .toThrow('discovery_reviewer_input_contains_expected_label_or_oracle');
    expect(() => benchmark.assertBlindDiscoveryInputCases([{ caseId: 'opaque', expectedFindings: [] }]))
      .toThrow('discovery_reviewer_input_contains_expected_label_or_oracle');
    expect(() => benchmark.assertBlindDiscoveryInputCases([{ caseId: 'opaque', groundTruth: { defects: [] } }]))
      .toThrow('discovery_reviewer_input_contains_expected_label_or_oracle');
    expect(() => benchmark.assertBlindDiscoveryInputCases([{ caseId: 'opaque', oracle: { valid: true } }]))
      .toThrow('discovery_reviewer_input_contains_expected_label_or_oracle');
  });

  it('builds an unmodified full-production policy without smoke-only task ceilings', () => {
    const sourcePolicy = {
      review_engine: 'dsh',
      fallback_review_engine: 'composed',
      personas: ['architecture', 'security', 'documentation'],
      reviewer_effort: 'medium',
      budget: { max_investigation_turns: 20 },
      transports: [{ name: 'bifrost', enabled: true, reasoning_effort: 'medium' }],
    };
    const policy = benchmark.buildDiscoveryPolicy(sourcePolicy, { purpose: 'qualification' });

    expect(policy).toEqual(sourcePolicy);
    expect(policy.composed).toBeUndefined();
    expect(benchmark.discoveryResourceProfile(policy, { verificationReserveTurns: 12 })).toEqual({
      source: 'composed_engine_defaults',
      policyMaxInvestigationTurns: 20,
      configuredMaxTasks: null,
      configuredMaxTurnsTotal: null,
      configuredMaxTurnsPerTask: null,
      effectiveMaxTasks: 8,
      effectiveMaxTurnsTotal: 100,
      planTurns: 4,
      baseTaskTurns: 12,
      dynamicTaskTurnsMax: 18,
      dynamicTaskTurnsPerAdditionalPath: 2,
      dynamicTaskPathIncrementMax: 6,
      taskFinalizationReserveTurns: 3,
      coverageAssignmentCeiling: 24,
      taskConcurrencyCeiling: 3,
      configuredMaxFindingsTotal: null,
      effectiveMaxFindingsTotal: 25,
      verificationReserveTurns: 12,
      discoveryTurnsAvailable: 88,
    });
  });

  it('forces the smoke turn ceiling over an inherited process override and restores the caller environment', async () => {
    const prior = process.env.COMPOSED_ENGINE_MAX_TURNS;
    process.env.COMPOSED_ENGINE_MAX_TURNS = '100';
    try {
      expect(resolveComposedEngineMaxTurns(process.env)).toBe(100);
      await expect(benchmark.withScopedComposedEngineTurnLimit(4, async () => {
        expect(process.env.COMPOSED_ENGINE_MAX_TURNS).toBe('4');
        return resolveComposedEngineMaxTurns(process.env);
      })).resolves.toBe(4);
      expect(process.env.COMPOSED_ENGINE_MAX_TURNS).toBe('100');

      await expect(benchmark.withScopedComposedEngineTurnLimit(2, async () => {
        throw new Error('smoke_runner_failed');
      })).rejects.toThrow('smoke_runner_failed');
      expect(process.env.COMPOSED_ENGINE_MAX_TURNS).toBe('100');

      delete process.env.COMPOSED_ENGINE_MAX_TURNS;
      await expect(benchmark.withScopedComposedEngineTurnLimit(3, async () =>
        resolveComposedEngineMaxTurns(process.env))).resolves.toBe(3);
      expect(process.env.COMPOSED_ENGINE_MAX_TURNS).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.COMPOSED_ENGINE_MAX_TURNS;
      else process.env.COMPOSED_ENGINE_MAX_TURNS = prior;
    }
  });

  it('rejects qualification policies that narrow the full production envelope or mismatch effort', () => {
    const sourcePolicy = {
      review_engine: 'dsh',
      fallback_review_engine: 'composed',
      personas: ['architecture', 'security', 'documentation'],
      transports: [{ name: 'bifrost', enabled: true, reasoning_effort: 'medium' }],
    };
    expect(() => benchmark.buildDiscoveryPolicy({ ...sourcePolicy, composed: { max_turns_total: 20 } }, {
      purpose: 'qualification',
    })).toThrow('qualification_policy_must_preserve_composed_engine_defaults');
    expect(() => benchmark.buildDiscoveryPolicy({ ...sourcePolicy, transports: [] }, {
      purpose: 'qualification', effortProfile: 'medium',
    })).toThrow('qualification_policy_effort_profile_mismatch');
    expect(() => benchmark.assertFullEnvelopeQualificationProfile(sourcePolicy, {
      verificationReserveTurns: 12,
      env: { NODE_ENV: 'test', COMPOSED_ENGINE_MAX_TURNS: '20' },
    })).toThrow('qualification_resource_profile_differs_from_supported_production_envelope');
    expect(benchmark.assertFullEnvelopeQualificationProfile(sourcePolicy, {
      verificationReserveTurns: 12, env: { NODE_ENV: 'test' },
    }).discoveryTurnsAvailable).toBe(88);
    expect(benchmark.assertKnownPolicyProjection('medium',
      benchmark.V1_POLICY_PROVENANCE.projectionSha256ByEffort.medium)).toBe(true);
    expect(() => benchmark.assertKnownPolicyProjection('medium', 'a'.repeat(64)))
      .toThrow('qualification_policy_projection_provenance_mismatch');
  });

  it('requires the WS3 receipt for revised qualification and a clean exact runtime alias', () => {
    expect(benchmark.assertDiscoveryCaseQualification({
      purpose: 'qualification', verdict: 'APPROVE', selectedRunnerInvoked: true,
      coverage: { rosterValid: true, quorumSatisfied: true, fullPanelComplete: true },
      sourceReadOmissions: [], groundedReview: null,
    })).toBe(false);
    const qualificationInput = {
      purpose: 'qualification', verdict: 'APPROVE', selectedRunnerInvoked: true,
      coverage: { rosterValid: true, quorumSatisfied: true, fullPanelComplete: true },
      sourceReadOmissions: [], groundedReview: {
        version: 'GroundedReviewReceipt.v1',
        coverage: { complete: true, regionCount: 4, coveredRegionCount: 4, assignmentCount: 4 },
        verification: { version: 'GroundedIndependentVerification.v1', coverageComplete: true,
          calls: 12, budget: { totalCalls: 12, callsPerTask: 12 } },
      },
    };
    expect(benchmark.assertDiscoveryCaseQualification(qualificationInput)).toBe(true);
    expect(benchmark.assertDiscoveryCaseQualification({ ...qualificationInput,
      groundedReview: { ...qualificationInput.groundedReview,
        verification: { ...qualificationInput.groundedReview.verification, calls: 13 } } })).toBe(false);
    expect(benchmark.assertDiscoveryCaseQualification({ ...qualificationInput,
      groundedReview: { ...qualificationInput.groundedReview,
        verification: { ...qualificationInput.groundedReview.verification,
          budget: { totalCalls: 100, callsPerTask: 12 } } } })).toBe(false);
    expect(benchmark.assertDiscoveryCaseQualification({ ...qualificationInput,
      groundedReview: { ...qualificationInput.groundedReview,
        verification: { ...qualificationInput.groundedReview.verification,
          budget: { totalCalls: 12, callsPerTask: 13 } } } })).toBe(false);
    expect(benchmark.assertDiscoveryCaseQualification({ ...qualificationInput,
      groundedReview: { ...qualificationInput.groundedReview,
        verification: { ...qualificationInput.groundedReview.verification, budget: undefined } } })).toBe(false);
    expect(benchmark.assertDiscoveryCaseQualification({
      purpose: 'baseline', verdict: 'APPROVE', selectedRunnerInvoked: true,
      coverage: { rosterValid: true, quorumSatisfied: true, fullPanelComplete: true },
      sourceReadOmissions: [], groundedReview: null,
    })).toBe(true);
    expect(() => benchmark.assertQualificationRuntime({
      expectedRuntimeSha: 'a'.repeat(40), runtimeIdentity: { commit: 'b'.repeat(40), worktreeClean: true },
      transportEnv: { NODE_ENV: 'test', REVIEW_MODEL: 'other-route' },
    })).toThrow('qualification_runtime_identity_or_cleanliness_mismatch');
    expect(() => benchmark.assertQualificationRuntime({
      expectedRuntimeSha: 'a'.repeat(40), runtimeIdentity: { commit: 'a'.repeat(40), worktreeClean: true },
      transportEnv: { NODE_ENV: 'test', REVIEW_MODEL: 'other-route' },
    })).toThrow('qualification_route_alias_mismatch');
    expect(benchmark.assertV1BaselineRuntime({
      expectedRuntimeSha: benchmark.V1_BASELINE_RUNTIME_SHA,
      runtimeIdentity: { commit: benchmark.V1_BASELINE_RUNTIME_SHA, worktreeClean: true },
      transportEnv: { NODE_ENV: 'test', REVIEW_MODEL: 'pr-reviewer' },
    })).toBe(true);
    expect(() => benchmark.assertV1BaselineRuntime({
      expectedRuntimeSha: 'a'.repeat(40), runtimeIdentity: { commit: 'a'.repeat(40), worktreeClean: true },
      transportEnv: { NODE_ENV: 'test', REVIEW_MODEL: 'pr-reviewer' },
    })).toThrow('v1_baseline_runtime_sha_mismatch');
  });

  it('abstains on any incomplete full-panel run and keeps a complete v1 run baseline-only', () => {
    expect(benchmark.discoveryQualificationDisposition({ purpose: 'qualification', completed: 7, total: 10 }))
      .toEqual({ status: 'ABSTAIN', reason: 'incomplete_source_or_runtime_coverage_no_quality_score' });
    expect(benchmark.discoveryQualificationDisposition({ purpose: 'qualification', completed: 7, total: 7 }))
      .toEqual({ status: 'READY_FOR_BLIND_ADJUDICATION', reason: 'selected_source_complete_subset_only' });
    expect(benchmark.discoveryQualificationDisposition({ purpose: 'baseline', completed: 7, total: 7 }))
      .toEqual({ status: 'BASELINE_ONLY', reason: 'not_a_standalone_quality_claim' });
  });

  it('retains only structured grounded receipt metadata and drops verifier evidence text', () => {
    const summary = benchmark.sanitizeGroundedReviewReceipt({
      version: 'GroundedReviewReceipt.v1',
      coverage: { digest: 'a'.repeat(64), regionCount: 4, assignmentCount: 4,
        coveredRegionCount: 4, complete: true, omissions: [] },
      history: { status: 'unavailable', eventCount: 0, findingCount: 0, loadedEventCount: 0,
        loadedFindingCount: 0, eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0,
        omissions: ['service-owned lifecycle history could not be loaded completely'],
        memorySources: { honho: 'unavailable', mcp: 'unavailable' },
        verificationWrites: { attempted: 0, recorded: 0, failed: 0 } },
      verification: { candidates: 1, confirmed: 1, contradicted: 0, insufficient: 0,
        unverifiedBlockerCount: 0, coverageComplete: true, calls: 1,
        budget: { totalCalls: 12, callsPerTask: 12, concurrency: 18 },
        outcomes: [{ fingerprint: 'raw-fingerprint', status: 'confirmed', affectedContextDigest: 'b'.repeat(64),
          relatedDiffPaths: ['src/a.ts'], evidenceDigest: 'c'.repeat(64), evidence: 'private prompt text' }] },
    });
    if (!summary) throw new Error('expected_grounded_receipt_summary');

    expect(summary.coverage).toMatchObject({ regionCount: 4, coveredRegionCount: 4, complete: true });
    expect(summary.history).toMatchObject({ status: 'unavailable', eventCount: 0 });
    expect(summary.verification).toMatchObject({ candidates: 1, confirmed: 1, calls: 1 });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('private prompt text');
    expect(serialized).not.toContain('raw-fingerprint');
    const panel = benchmark.sanitizePanelResult({ history: { status: 'partial', omissions: ['private free-form reason'] },
      verification: { coverageComplete: false, omissions: ['raw verifier response'] } });
    if (!panel) throw new Error('expected_sanitized_panel_summary');
    expect(JSON.stringify(panel)).not.toContain('private free-form reason');
    expect(JSON.stringify(panel)).not.toContain('raw verifier response');
    expect(panel.history).toMatchObject({ status: 'partial', omissionCount: 1 });
    expect(panel.verification).toMatchObject({ coverageComplete: false, omissionCount: 1 });
  });

  it('reduces publishing coverage to the closed structured projection', () => {
    const coverage = benchmark.sanitizePublishingCoverage({
      mode: 'panel', expectedLaneCount: 3, completedLaneCount: 3, failedLaneCount: 0,
      rosterValid: true, quorumSatisfied: true, fullPanelComplete: true,
      groundedReviewComplete: true, internalReason: 'untrusted model/source text',
    });
    expect(coverage).toEqual({ mode: 'panel', expectedLaneCount: 3, completedLaneCount: 3,
      failedLaneCount: 0, rosterValid: true, quorumSatisfied: true, fullPanelComplete: true,
      groundedReviewComplete: true });
    expect(JSON.stringify(coverage)).not.toContain('untrusted model/source text');
  });

  it('hashes the exact prepared input bytes consumed by a run', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-prepared-input-'));
    try {
      const inputPath = path.join(directory, 'cases.json');
      const bytes = Buffer.from('{"datasetSha256":"pinned"}\n');
      fs.writeFileSync(inputPath, bytes);

      const prepared = benchmark.readPreparedInput(inputPath);
      expect(prepared.value).toEqual({ datasetSha256: 'pinned' });
      expect(prepared.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
      expect(prepared.sha256).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports a missing pinned Git cache instead of treating failed source reads as complete', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-missing-source-cache-'));
    try {
      const repository = 'example/repo';
      const baseSha = 'a'.repeat(40);
      const headSha = 'b'.repeat(40);
      const patch = 'diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n';
      const changedFiles = [{ path: 'src/app.js', patch, originalPatchLength: patch.length }];
      let workerCalls = 0;
      const runtime = {
        publishing: {
          openaiTransport: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'test-only', model: 'pr-reviewer' }),
          resolveWorkerConfig: () => ({ review_engine: 'composed', reviewer_effort: 'medium' }),
          resolveReviewEngine: () => 'composed',
          runPublishingReviewWorker: async (_env: unknown, deps: any) => {
            workerCalls += 1;
            const provider = deps.repoFileProviderFactory();
            await provider.readFileAt('src/app.js', 'head');
            return { version: 'WorkerReviewResult.v1', verdict: 'BLOCK', conclusion: 'failure',
              coverage: { mode: 'panel', expectedLaneCount: 1, completedLaneCount: 1, failedLaneCount: 0,
                rosterValid: true, quorumSatisfied: false, fullPanelComplete: false },
              findingCount: 0, blockingFindingCount: 0,
              metrics: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, totalTurns: 0,
                totalDurationMs: 0 } };
          },
        },
        OpenRouterClient: class { async complete() { throw new Error('unexpected_network_call'); } },
        createPathMatcher: () => () => true,
        executeComposedReview: async () => ({ personas: [] }),
      };

      const result = await benchmark.runActualDiscoveryCase({ repository, prNumber: 7, baseSha, headSha }, {
        repository, baseSha, headSha, changedFiles, omissions: [], sourceAdapter: 'pinned_git_objects',
        sourceRepoDir: path.join(directory, 'missing-cache'),
      }, runtime as any, {
        purpose: 'smoke', transportEnv: {
          NODE_ENV: 'test',
          REVIEW_YETI_GATEWAY_BASE_URL: 'https://gateway.example/v1',
          REVIEW_YETI_BIFROST_API_KEY: 'test-only', REVIEW_MODEL: 'pr-reviewer',
        },
      });

      expect(result.source?.sourceReadOmissions).toContain('pinned_source_cache_unavailable');
      expect(result.status).toBe('incomplete');
      expect(result.sourceCachePreflight).toMatchObject({ status: 'failed', reason: 'pinned_source_cache_unavailable' });
      expect(workerCalls).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preflights exact base/head Git pins and patches while allowing genuine add/delete sides', () => {
    const fixture = createPinnedGitFixture();
    try {
      expect(benchmark.preflightPinnedGitSnapshot(fixture.snapshot, fixture.directory)).toMatchObject({
        status: 'verified', baseSha: fixture.snapshot.baseSha, headSha: fixture.snapshot.headSha,
        changedFileCount: 3, addedFileCount: 1, deletedFileCount: 1,
      });
      expect(benchmark.preflightDiscoveryCaseSource({ ...fixture.snapshot, sourceAdapter: 'pinned_git_objects' },
        fixture.directory)).toMatchObject({ status: 'verified', sourceAdapter: 'pinned_git_objects', immutableSourceRechecked: true });
      expect(benchmark.preflightDiscoveryCaseSource({ ...fixture.snapshot, sourceAdapter: 'github_exact_commit_trees_and_raw_blobs',
        sourceTreeIndex: { base: {}, head: {} } },
        fixture.directory)).toMatchObject({ status: 'prepared_input_only', immutableSourceRechecked: false });
      expect(benchmark.preflightDiscoveryCaseSource({ ...fixture.snapshot, sourceAdapter: 'unknown' },
        fixture.directory)).toMatchObject({ status: 'failed', reason: 'source_adapter_unavailable' });
      expect(() => benchmark.preflightPinnedGitSnapshot(fixture.snapshot,
        path.join(fixture.directory, 'missing-cache'))).toThrow('pinned_source_cache_unavailable');
      expect(() => benchmark.preflightPinnedGitSnapshot({ ...fixture.snapshot, headSha: 'f'.repeat(40) },
        fixture.directory)).toThrow('pinned_source_reference_unavailable');
      const changedFiles = fixture.snapshot.changedFiles.map((file: any) => file.path === 'src/changed.ts'
        ? { ...file, patch: `${file.patch}tampered` } : file);
      expect(() => benchmark.preflightPinnedGitSnapshot({ ...fixture.snapshot, changedFiles },
        fixture.directory)).toThrow('pinned_source_diff_mismatch');
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('records missing pinned blobs without treating valid add/delete absence as read failure', async () => {
    const fixture = createPinnedGitFixture();
    try {
      const provider = benchmark.createGitSnapshotFileProvider(fixture.directory, fixture.snapshot, () => () => true);
      const addedBase = await provider.readFileAt('src/added.ts', 'base');
      const addedHead = await provider.readFileAt('src/added.ts', 'head');
      const deletedBase = await provider.readFileAt('src/deleted.ts', 'base');
      const deletedHead = await provider.readFileAt('src/deleted.ts', 'head');
      expect([addedBase.content, addedHead.content, deletedBase.content, deletedHead.content])
        .toEqual([null, 'export const added = true;\n', 'export const removed = true;\n', null]);
      expect(provider.sourceReadOmissions()).toEqual([]);

      const headBlob = fixture.git(['rev-parse', `${fixture.snapshot.headSha}:src/changed.ts`]).trim();
      const blobPath = path.join(fixture.directory, '.git', 'objects', headBlob.slice(0, 2), headBlob.slice(2));
      expect(fs.existsSync(blobPath)).toBe(true);
      fs.rmSync(blobPath);
      const brokenProvider = benchmark.createGitSnapshotFileProvider(fixture.directory, fixture.snapshot, () => () => true);
      await brokenProvider.readFileAt('src/changed.ts', 'head');
      expect(brokenProvider.sourceReadOmissions()).toEqual(['pinned_source_blob_unavailable']);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('pins the checked-in local policy projection bytes to the v1 source record', () => {
    const projectionDirectory = path.join(process.cwd(), 'eval-baselines/competitive-review-benchmark/policy-projections');
    expect(benchmark.readPreparedInput(path.join(projectionDirectory, 'yeti-v1-native-omitted.json')).sha256)
      .toBe(benchmark.V1_POLICY_PROVENANCE.projectionSha256ByEffort.native_omitted);
    expect(benchmark.readPreparedInput(path.join(projectionDirectory, 'yeti-v1-medium.json')).sha256)
      .toBe(benchmark.V1_POLICY_PROVENANCE.projectionSha256ByEffort.medium);
  });

  it('creates an opaque, context-stratified verification panel without labels in reviewer input', () => {
    const cases = benchmark.buildVerificationCases(referenceRows(), manifest);
    expect(cases).toHaveLength(6);
    expect(cases.map((entry: any) => entry.context).sort()).toEqual([
      'Diff Level', 'Diff Level', 'File Level', 'File Level', 'Repo Level', 'Repo Level',
    ]);
    for (const testCase of cases) {
      const input = benchmark.toVerifierInput(testCase);
      expect(input.caseId).toMatch(/^aacr-v1-[a-f0-9]{20}$/u);
      expect(input.caseId).not.toMatch(/correct|incorrect|positive|negative/iu);
      expect(JSON.stringify(input)).not.toMatch(/expectedLabel|aacr-comment-/u);
      expect(input.finding.body).toBe(testCase.reference.note);
    }
  });

  it('separates verification from discovery and leaves unmatched discovery findings unjudged', () => {
    const rows = referenceRows();
    const result = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [{ id: 'finding-1', path: 'src/app.js', line: 12 }],
    }], manifest);
    expect(result.referenceAnchorRecall).toBe(1);
    expect(result.precision).toBeNull();
    expect(result.adjudicatedSubsetPrecision).toBeNull();
    expect(result.unjudgedGeneratedFindingCount).toBe(1);
    expect(result.qualified).toBe(false);

    const partiallyAdjudicated = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [
        { id: 'finding-1', path: 'src/app.js', line: 12 },
        { id: 'finding-2', path: 'src/other.js', line: 8 },
      ],
    }], manifest, {
      judge: { kind: 'independent_human', protocolId: 'double-blind-v1' },
      judgments: [{ findingId: 'finding-1', verdict: 'valid' }],
    } as any);
    expect(partiallyAdjudicated.precision).toBeNull();
    expect(partiallyAdjudicated.precision95).toBeNull();
    expect(partiallyAdjudicated.adjudicatedSubsetPrecision).toBe(1);
    expect(partiallyAdjudicated.adjudicatedSubsetPrecisionDenominator).toBe(1);
    expect(partiallyAdjudicated.unjudgedGeneratedFindingCount).toBe(1);
    expect(partiallyAdjudicated.qualified).toBe(false);

    const ambiguousJudgments = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [
        { id: 'finding-1', path: 'src/app.js', line: 12 },
        { id: 'finding-2', path: 'src/other.js', line: 8 },
      ],
    }], manifest, {
      judge: { kind: 'independent_human', protocolId: 'double-blind-v1' },
      judgments: [
        { findingId: 'finding-1', verdict: 'valid' },
        { findingId: 'finding-1', verdict: 'invalid' },
        { findingId: 'not-generated', verdict: 'valid' },
      ],
    } as any);
    expect(ambiguousJudgments.precision).toBeNull();
    expect(ambiguousJudgments.adjudicatedSubsetPrecision).toBeNull();
    expect(ambiguousJudgments.adjudicatedSubsetPrecisionDenominator).toBe(0);
    expect(ambiguousJudgments.unjudgedGeneratedFindingCount).toBe(2);

    const duplicateGeneratedIds = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [
        { id: 'finding-1', path: 'src/app.js', line: 12 },
        { id: 'finding-1', path: 'src/other.js', line: 8 },
      ],
    }], manifest, {
      judge: { kind: 'independent_human', protocolId: 'double-blind-v1' },
      judgments: [
        { findingId: 'finding-1', verdict: 'valid' },
        { findingId: 'foreign-finding', verdict: 'valid' },
      ],
    } as any);
    expect(duplicateGeneratedIds.precision).toBeNull();
    expect(duplicateGeneratedIds.qualified).toBe(false);

    const adjudicated = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [{ id: 'finding-1', path: 'src/app.js', line: 12 }],
    }], manifest, {
      judge: { kind: 'independent_human', protocolId: 'double-blind-v1' },
      judgments: [{ findingId: 'finding-1', verdict: 'valid' }],
    } as any);
    expect(adjudicated.precision).toBe(1);
    expect(adjudicated.adjudicatedSubsetPrecision).toBe(1);
    expect(adjudicated.qualified).toBe(true);
  });

  it('does not score a verifier result when its pinned source snapshot has omissions', async () => {
    const matchingTestCase = benchmark.buildVerificationCases(referenceRows(), manifest)
      .find((entry: any) => entry.context === 'Diff Level');
    if (!matchingTestCase) throw new Error('diff-level fixture case missing');
    const testCase = matchingTestCase;
    let verifierCalls = 0;
    const result = await benchmark.runActualVerificationCase(testCase, {
      changedFiles: [{ path: testCase.reference.path, patch: 'diff --git a/src/app.js b/src/app.js\n+changed' }],
      omissions: ['head_blob_fetch_failed'],
    }, {
      resolveModelConfig: () => ({ enabled: true, transports: [
        { name: 'route', apiKey: 'secret', model: 'vendor/model' },
      ] }),
    }, {
      falsification: {
        runFindingFalsification: async () => {
          verifierCalls += 1;
          return { outcomes: [{ verdict: 'CONFIRM', reason: 'confirmed' }], receipt: { usage: {} } };
        },
      },
    } as any);

    expect(result.status).toBe('incomplete');
    expect(result.verdict).toBe('ABSTAIN');
    expect(result.sourceOmissions).toEqual(['head_blob_fetch_failed']);
    expect(verifierCalls).toBe(0);

    const score = benchmark.scoreVerificationCases([testCase], [result]);
    expect(score.completed).toBe(0);
    expect(score.byContext['Diff Level'].scoredCompleted).toBe(0);
  });

  it('requires a single credentialed real transport and refuses synthetic scoring', () => {
    expect(() => benchmark.assertActualModelConfig({
      resolveModelConfig: () => ({ enabled: false, transports: [] }),
    })).toThrow('actual_model_credentials_unavailable');
    expect(() => benchmark.assertActualModelConfig({
      resolveModelConfig: () => ({ enabled: true, transports: [
        { name: 'route-a', apiKey: 'secret', model: 'm1' },
        { name: 'route-b', apiKey: 'secret', model: 'm2' },
      ] }),
    })).toThrow('select_one_actual_transport_to_prevent_fallback');
    expect(() => benchmark.assertActualModelConfig({
      resolveModelConfig: () => ({ enabled: true, transports: [{ name: 'synthetic', apiKey: 'secret', model: 'm' }] }),
    })).toThrow('synthetic_provider_forbidden_for_qualification');
    const config = benchmark.assertActualModelConfig({
      resolveModelConfig: () => ({ enabled: true, transports: [{ name: 'route', apiKey: 'secret', model: 'vendor/model' }] }),
    });
    expect(config.selectedTransport).toEqual({ name: 'route', requestedModel: 'vendor/model' });
    expect(config.apiKey).toBe('');
  });

  it('forces loopback-only transport and replaces inherited secrets for WS5 child mode', () => {
    const caRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-loopback-ca-test-'));
    const caPath = path.join(caRoot, 'public-ca.pem');
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----\n', { mode: 0o600 });
    const saved = {
      loopback: process.env.WS5_LOOPBACK_BROKER,
      baseUrl: process.env.OPENROUTER_BASE_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL,
      destination: process.env.REVIEW_TRANSPORT_DESTINATION,
      gatewayUrl: process.env.REVIEW_YETI_GATEWAY_BASE_URL,
      gatewayKey: process.env.REVIEW_YETI_BIFROST_API_KEY,
    };
    process.env.WS5_LOOPBACK_BROKER = '1';
    process.env.OPENROUTER_BASE_URL = 'https://127.0.0.1:45678/v1';
    process.env.OPENROUTER_API_KEY = 'dummy-local-proxy-token-1234567890';
    process.env.OPENROUTER_MODEL = 'pr-reviewer';
    process.env.REVIEW_TRANSPORT_DESTINATION = 'gateway';
    process.env.REVIEW_YETI_GATEWAY_BASE_URL = 'https://127.0.0.1:45678/v1';
    process.env.REVIEW_YETI_BIFROST_API_KEY = 'dummy-local-proxy-token-1234567890';
    try {
      const config = benchmark.assertActualModelConfig({
        resolveModelConfig: () => ({
          enabled: true,
          model: 'pr-reviewer',
          apiKey: 'provider-secret-sentinel',
          transports: [{ name: 'bifrost', model: 'pr-reviewer', apiKey: 'provider-secret-sentinel',
            baseUrl: 'https://private.gateway.invalid/v1',
            headers: { authorization: 'provider-secret-sentinel' } }],
        }),
      }, { transportName: 'bifrost' });

      expect(config.transports[0].baseUrl).toBe('https://127.0.0.1:45678/v1');
      expect(config.transports[0].apiKey).toBe('dummy-local-proxy-token-1234567890');
      expect(config.apiKey).toBe('');
      expect(JSON.stringify(config)).not.toContain('provider-secret-sentinel');
      expect(JSON.stringify(config)).not.toContain('private.gateway.invalid');
      expect(benchmark.inspectActualLoopbackTransport({
        resolveModelConfig: () => ({ enabled: true, apiKey: 'provider-secret-sentinel', transports: [{
          name: 'openrouter', provider: 'openrouter', compat: 'openrouter', model: 'pr-reviewer',
          apiKey: 'provider-secret-sentinel', baseUrl: 'https://private.gateway.invalid/v1',
          stream: true, maxTokens: 24_576, timeoutMs: 240_000,
        }] }),
      }, { expectedModel: 'pr-reviewer', transportEnv: {
        NODE_ENV: 'production',
        WS5_LOOPBACK_BROKER: '1',
        OPENROUTER_BASE_URL: 'https://127.0.0.1:45678/v1',
        OPENROUTER_API_KEY: 'dummy-local-proxy-token-1234567890',
        OPENROUTER_MODEL: 'pr-reviewer',
        REVIEW_TRANSPORT_DESTINATION: 'gateway',
        REVIEW_YETI_GATEWAY_BASE_URL: 'https://127.0.0.1:45678/v1',
        REVIEW_YETI_BIFROST_API_KEY: 'dummy-local-proxy-token-1234567890',
        NODE_EXTRA_CA_CERTS: caPath,
      } })).toMatchObject({
        status: 'ready_without_model_call',
        transportName: 'openrouter',
        requestedModel: 'pr-reviewer',
        modelConfigDefaults: {
          source: 'pipeline.resolveModelConfig',
          transportName: 'openrouter',
          requestedModel: 'pr-reviewer',
          compat: 'openrouter',
          stream: true,
          maxTokens: 24_576,
          timeoutMs: 240_000,
        },
        loopbackOnly: true,
        inactiveProviderCredentialCount: 0,
      });
      process.env.OPENROUTER_BASE_URL = 'https://outside.gateway.invalid/v1';
      expect(() => benchmark.assertActualModelConfig({
        resolveModelConfig: () => ({ enabled: true, transports: [{ name: 'bifrost', apiKey: 'secret', model: 'pr-reviewer' }] }),
      }, { transportName: 'bifrost' })).toThrow('ws5_loopback_route_required');
    } finally {
      if (saved.loopback === undefined) delete process.env.WS5_LOOPBACK_BROKER;
      else process.env.WS5_LOOPBACK_BROKER = saved.loopback;
      if (saved.baseUrl === undefined) delete process.env.OPENROUTER_BASE_URL;
      else process.env.OPENROUTER_BASE_URL = saved.baseUrl;
      if (saved.apiKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved.apiKey;
      if (saved.model === undefined) delete process.env.OPENROUTER_MODEL;
      else process.env.OPENROUTER_MODEL = saved.model;
      if (saved.destination === undefined) delete process.env.REVIEW_TRANSPORT_DESTINATION;
      else process.env.REVIEW_TRANSPORT_DESTINATION = saved.destination;
      if (saved.gatewayUrl === undefined) delete process.env.REVIEW_YETI_GATEWAY_BASE_URL;
      else process.env.REVIEW_YETI_GATEWAY_BASE_URL = saved.gatewayUrl;
      if (saved.gatewayKey === undefined) delete process.env.REVIEW_YETI_BIFROST_API_KEY;
      else process.env.REVIEW_YETI_BIFROST_API_KEY = saved.gatewayKey;
      fs.rmSync(caRoot, { recursive: true, force: true });
    }
  });

  it('scores only exact opaque panel IDs and reports task/context counts separately', () => {
    const testCases = benchmark.buildVerificationCases(referenceRows(), manifest);
    const results = testCases.map((entry: any) => ({
      caseId: entry.id,
      status: 'completed',
      verdict: entry.reference.expectedLabel === 1 ? 'CONFIRM' : 'REFUTE',
      contextQualification: entry.context === 'Diff Level' ? 'aligned_diff_only' : 'not_comparable_context_not_provided',
    }));
    const score = benchmark.scoreVerificationCases(testCases, results);
    expect(score.completed).toBe(2);
    expect(score.modelCompleted).toBe(6);
    expect(score.positiveReference.correctDecisions).toBe(1);
    expect(score.negativeReference.correctDecisions).toBe(1);
    expect(score.byContext['Diff Level'].scoredCompleted).toBe(2);
    expect(score.byContext['File Level'].correctDecisions).toBeNull();
    expect(score.byContext['Repo Level'].contextQualification).toBe('not_comparable_context_not_provided');
    expect(score.servingIdentity).toBe('unverified');
    expect(() => benchmark.scoreVerificationCases(testCases, [...results, results[0]])).toThrow('verification result IDs');
  });

  it('records sanitized completion route metadata without request identifiers or endpoint URLs', async () => {
    const identity = {
      requestedModels: new Set(), responseModels: new Set(), responseProviders: new Set(),
      responseRouteHints: new Set(), requestIdDigests: new Set(), fetchFailureClasses: new Set(),
      fetchToHeadersMs: [], httpStatuses: [], requestProfiles: new Map(), pendingResponseMetadataReads: [],
    };
    const wrappedFetch = benchmark.trackCompletion(async () => new Response(
      JSON.stringify({ model: 'deepseek-v4.1-flash', provider: 'NeuralWatt' }),
      { status: 200, headers: { 'x-bifrost-provider': 'neuralwatt', 'x-request-id': 'raw-private-request-id' } },
    ), identity);
    await wrappedFetch('https://private.gateway.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'pr-reviewer', reasoning_effort: 'medium', max_tokens: 4096 }),
    });
    await Promise.all(identity.pendingResponseMetadataReads);
    const summary = benchmark.identitySummary(identity);
    expect(summary.requestedModels).toEqual(['pr-reviewer']);
    expect(summary.responseReportedModels).toEqual(['deepseek-v4.1-flash']);
    expect(summary.responseReportedProviders).toEqual(['NeuralWatt']);
    expect(summary.responseRouteHints).toEqual(['neuralwatt']);
    expect(summary.httpStatuses).toEqual([200]);
    expect(summary.fetchToHeadersMs).toHaveLength(1);
    expect(summary.requestIdDigests).toHaveLength(1);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('raw-private-request-id');
    expect(serialized).not.toContain('private.gateway.example');
  });

  it('attaches parent-only logical and physical ordinals for the loopback broker', async () => {
    const identity = {
      requestedModels: new Set(), responseModels: new Set(), responseProviders: new Set(),
      responseRouteHints: new Set(), requestIdDigests: new Set(), fetchFailureClasses: new Set(),
      fetchToHeadersMs: [], httpStatuses: [], requestProfiles: new Map(), pendingResponseMetadataReads: [],
    };
    const previous = process.env.WS5_LOOPBACK_BROKER;
    process.env.WS5_LOOPBACK_BROKER = '1';
    const observedHeaders: { value: Headers | null } = { value: null };
    try {
      const wrappedFetch = benchmark.trackCompletion(async (_url: string, init: RequestInit) => {
        observedHeaders.value = new Headers(init.headers);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }, identity);
      const dispatches: any[] = [];
      await benchmark.trackLogicalCompletion('review', dispatches, () => wrappedFetch(
        'http://127.0.0.1/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({ model: 'pr-reviewer', max_tokens: 128 }),
        },
      ));

      expect(observedHeaders.value?.get('x-ws5-local-attempt-ordinal')).toBe('1');
      expect(observedHeaders.value?.get('x-ws5-logical-dispatch-ordinal')).toBe('1');
      expect(dispatches[0].localAttemptOrdinals).toEqual([1]);
    } finally {
      if (previous === undefined) delete process.env.WS5_LOOPBACK_BROKER;
      else process.env.WS5_LOOPBACK_BROKER = previous;
    }
  });

  it('does not read or clone a streamed completion body for telemetry', async () => {
    let cloneCount = 0;
    const identity = {
      requestedModels: new Set(), responseModels: new Set(), responseProviders: new Set(),
      responseRouteHints: new Set(), requestIdDigests: new Set(), fetchFailureClasses: new Set(),
      fetchToHeadersMs: [], httpStatuses: [], requestProfiles: new Map(), pendingResponseMetadataReads: [],
    };
    const response = {
      status: 200,
      headers: new Headers({ 'x-bifrost-provider': 'neuralwatt' }),
      clone() { cloneCount += 1; throw new Error('stream body must stay untouched'); },
    };
    const wrappedFetch = benchmark.trackCompletion(async () => response, identity);
    await wrappedFetch('https://private.gateway.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'pr-reviewer', stream: true, reasoning_effort: 'medium' }),
    });
    expect(cloneCount).toBe(0);
    expect(identity.httpStatuses).toEqual([200]);
    expect(identity.requestProfiles.get(JSON.stringify({
      model: 'pr-reviewer', reasoningEffort: 'medium', maxOutputTokens: null, stream: true, providerPreferencePresent: false,
    }))).toMatchObject({ count: 1 });
  });

  it('retains bounded finding details while dropping free-form decision and verifier text from private receipts', () => {
    const summary = benchmark.sanitizePanelResult({
      personas: [{ id: 'review-lane', findings: [{
        path: 'src/queue.ts', line: 24, severity: 'P1', title: 'Rejected event is retried',
        comment: 'The retry loop can re-submit a rejected event.',
        recommendation: 'Stop retrying after the terminal response.', hiddenReasoning: 'do not preserve this reasoning',
      }] }],
      reviewDecision: {
        schemaVersion: 'review-yeti-severity.v2',
        classification: 'APPROVE',
        reason: 'raw completion text must not be serialized',
      },
      groundedReview: {
        verifierOutcomes: [{ verdict: 'ABSTAIN', reason: 'raw verifier response must not be serialized' }],
      },
      gracefulExit: { reason: 'model supplied arbitrary private text', completedTaskIds: [], pendingTaskIds: [] },
    });
    if (!summary) throw new Error('panel summary fixture was not sanitized');
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('raw completion text');
    expect(serialized).not.toContain('raw verifier response');
    expect(serialized).not.toContain('arbitrary private text');
    expect(serialized).not.toContain('do not preserve this reasoning');
    expect(summary.reviewDecision).toEqual({ schemaVersion: 'review-yeti-severity.v2', classification: 'APPROVE' });
    expect(summary.verifierOutcomes).toEqual([{ verdict: 'ABSTAIN' }]);
    expect(summary.findings[0]).toMatchObject({
      path: 'src/queue.ts', line: 24, severity: 'P1', lane: 'review-lane',
      title: 'Rejected event is retried', comment: 'The retry loop can re-submit a rejected event.',
      recommendation: 'Stop retrying after the terminal response.',
    });
  });

  it('refuses to score a production-entrypoint smoke as a discovery evaluation', () => {
    expect(() => benchmark.assertDiscoveryRunEligible({
      executionPurpose: 'production_entrypoint_runtime_smoke_only',
      qualification: 'not_established_by_runtime_smoke_or_AACR_reference_match_alone',
      panelSize: 10,
      completion: { completed: 1, total: 1, allRuntimeReceiptsComplete: true },
      cases: [{ status: 'completed' }],
    })).toThrow('discovery_runtime_run_not_quality_eligible');
    expect(() => benchmark.assertDiscoveryRunEligible({
      executionPurpose: 'paired_heldout_evaluation',
      qualification: 'not_established_by_runtime_smoke_or_AACR_reference_match_alone',
      panelSize: 1,
      completion: { completed: 1, total: 1, allRuntimeReceiptsComplete: true },
      cases: [{ status: 'completed' }],
    })).toThrow('discovery_runtime_evaluation_incomplete');
    expect(() => benchmark.assertDiscoveryRunEligible({
      executionPurpose: 'paired_heldout_evaluation',
      qualification: 'eligible_for_independent_adjudication',
      panelSize: 1,
      completion: { completed: 1, total: 1, allRuntimeReceiptsComplete: true },
      cases: [{ status: 'completed' }],
    })).toThrow('run_missing_prepared_input_digest');
    expect(() => benchmark.assertDiscoveryRunEligible({
      executionPurpose: 'paired_heldout_evaluation',
      qualification: 'eligible_for_independent_adjudication',
      panelSize: 1,
      completion: { completed: 1, total: 1, allRuntimeReceiptsComplete: true },
      cases: [{ status: 'completed' }],
      preparedInputSha256: 'a'.repeat(64),
    })).toThrow('run_source_verification_boundary_missing');
  });
});
