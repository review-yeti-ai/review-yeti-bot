import { describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import { ComposedRuntimeResourceObserver } from '../../src/panel/composedResourceReceipt';
import { ProviderAttemptBudget } from '../../src/gateway/providerAttemptBudget';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { TaskSourceDelivery } from '../../src/review/taskSourceDelivery';
import { groundedFixtureClient, groundedFixtureProvider } from '../support/groundedReviewFixture';

/**
 * Mutation target 1 (composed-engine PR): "Remove `panelSize: 1` -> a threshold-invariance test
 * must go red." This test constructs a composed-engine run with a 7-task roster carrying exactly
 * 3 P1 findings. `reviewCore.js`'s blocking threshold is `max(3, ceil(panelSize / 2))`:
 *   - panelSize = 1 (one composed context is one reviewer, wired at the computeArbitration call
 *     site in `src/cli/publishingReview.ts`) -> blockP1 = 3 -> 3 P1s meets the threshold -> BLOCK.
 *   - panelSize defaulted to the lane count (7, the task count) -> blockP1 = 4 -> 3 P1s is below
 *     threshold -> FIX_FIRST, not BLOCK.
 * A longer task plan must never let the composed reviewer silently raise its own blocking bar.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const ACCESS_CONTROL_REGRESSIONS = [
  { path: 'src/billingAccess.ts', line: 1, id: 'billing-read', fn: 'canReadBilling', capability: 'billing records' },
  { path: 'src/customerExportAccess.ts', line: 1, id: 'data-export', fn: 'canExportData', capability: 'customer data exports' },
  { path: 'src/userRoleAccess.ts', line: 1, id: 'user-management', fn: 'canManageUsers', capability: 'user role changes' },
] as const;

/** Base-policy JSON that selects the composed engine (see `resolveWorkerConfig` in
 * `src/config/publishingWorkerConfig.ts`). `review_engine` is only readable from here -- an env
 * var alone must never select the engine (see `resolveReviewEngine` in
 * `src/cli/publishingReview.ts`). */
const COMPOSED_POLICY_JSON = JSON.stringify({
  review_yeti: {
    personas: 'security',
    budget: { max_investigation_turns: 10 },
    review_engine: 'composed',
  },
});

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_YETI_POLICY_JSON: COMPOSED_POLICY_JSON,
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'exampleorg/example-meta',
    REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_PR_NUMBER: '2795',
    REVIEW_HEAD_SHA: HEAD,
    REVIEW_BASE_SHA: BASE,
    REVIEW_MODEL: 'ollama/glm-5.3-flash',
    OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
    OPENAI_API_KEY: 'vk-test',
    GH_TOKEN: 'ghs_test',
    ...overrides,
  };
}

function checkClient() {
  return {
    createCheck: vi.fn(async () => 4242),
    completeCheck: vi.fn(async () => {}),
  };
}

const DIFF = ACCESS_CONTROL_REGRESSIONS.map(({ path, fn }) => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1 +1 @@',
  `-export function ${fn}(isAdmin: boolean): boolean { return isAdmin; }`,
  `+export function ${fn}(isAdmin: boolean): boolean { return true; }`,
].join('\n')).join('\n') + '\n';

function makeFinding(path: string, line: number, id: string) {
  const regression = ACCESS_CONTROL_REGRESSIONS[Number(id.slice(1)) - 1];
  if (!regression || regression.path !== path || regression.line !== line) {
    throw new Error(`No access-control regression fixture for ${id} at ${path}:${line}`);
  }
  return {
    severity: 'P1',
    path,
    line,
    title: `Non-admin caller can access ${regression.capability}`,
    body: `The changed ${regression.fn} returns true for a non-admin caller.`,
  };
}

/** A 7-task composed roster with exactly 3 P1 findings, spread across 3 distinct tasks so
 * `clusterFindings` does not collapse them into one. */
function sevenTaskComposedResult(input: { providerAttemptBudget?: ProviderAttemptBudget; config?: any; effectiveConfigDigest?: string }) {
  const taskIds = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
  const taskPlan = taskIds.map((id) => ({ id, dimension: 'security' as const,
    paths: ACCESS_CONTROL_REGRESSIONS.map((regression) => regression.path),
    question: 'Did this change weaken the administrator-only access contract?',
    rationale: 'Each task owns the exact changed authorization gate source.' }));
  const changedFiles = parseChangedFiles(DIFF, { repository: 'exampleorg/example-meta', headSha: HEAD, baseSha: BASE }).files;
  const providerAttemptBudget = input.providerAttemptBudget
    ?? new ProviderAttemptBudget({ totalLimit: 100, investigationLimit: 88, verificationLimit: 12 });
  const observer = new ComposedRuntimeResourceObserver({ configDigest: input.effectiveConfigDigest,
    configuration: input.config?.review_configuration_receipt, providerAttemptBudget });
  observer.configureBudget({ configuredTotalTurns: providerAttemptBudget.limits.totalLimit,
    investigationTurns: providerAttemptBudget.limits.investigationLimit,
    verificationReserveTurns: providerAttemptBudget.limits.verificationLimit });
  observer.setPlan(taskPlan);
  for (const task of taskPlan) {
    observer.markTaskStarted(task.id);
    const delivery = new TaskSourceDelivery({ taskId: task.id, paths: task.paths, files: changedFiles,
      prefix: DIFF, inlinedPaths: task.paths, headSha: HEAD, baseSha: BASE });
    delivery.beginAttempt();
    const receipt = delivery.acknowledgeRequest([{ role: 'user', content: DIFF }]);
    observer.markTaskOutcome(task.id, 'completed', receipt);
  }
  const composedResourceObservation = observer.snapshot('terminal');
  if (!composedResourceObservation) throw new Error('Expected complete composed resource observation');
  const personas = taskIds.map((id, idx) => ({
    id,
    required: true,
    providerId: 'bifrost',
    model: 'test-model',
    decision: idx < 3 ? 'FINDINGS' : 'APPROVE',
    findings: idx < 3 ? [makeFinding(ACCESS_CONTROL_REGRESSIONS[idx]!.path, ACCESS_CONTROL_REGRESSIONS[idx]!.line, id)] : [],
  }));
  return {
    taskPlan,
    headSha: HEAD,
    applicablePersonaIds: taskIds,
    personas,
    optionalFailures: [],
    zeroLaneNonEvidence: false,
    panelWallClockMs: 10,
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
    arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
    composedResourceObservation,
  };
}

/** Verifies only the exact changed access-control implementation visible in current source windows. */
function accessControlVerifier() {
  return {
    complete: vi.fn(async (request: { messages?: Array<{ content: unknown }> }) => {
      const rawContent = request.messages?.[1]?.content;
      const prompt = typeof rawContent === 'string' ? rawContent
        : Array.isArray(rawContent) ? rawContent.map((part) => part && typeof part === 'object'
          && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('\n')
        : String(rawContent ?? '');
      const claimMatch = /<claim>(\{[\s\S]*?\})<\/claim>/u.exec(prompt);
      const evidenceMatch = /<retrieved_repository_evidence>([\s\S]*?)<\/retrieved_repository_evidence>/u.exec(prompt);
      if (!claimMatch || !evidenceMatch) {
        return { model: 'grounded-fixture-model', content: JSON.stringify({ status: 'insufficient', citations: [] }) };
      }
      const claim = JSON.parse(claimMatch[1]!) as { path: string; line: number };
      const regression = ACCESS_CONTROL_REGRESSIONS.find((item) => item.path === claim.path && item.line === claim.line);
      const rows = JSON.parse(evidenceMatch[1]!) as Array<{ path: string;
        head: { windows: Array<{ id: string; role: string; startLine: number; endLine: number; source: string }> };
        base: { windows: Array<{ id: string; role: string; startLine: number; endLine: number; source: string }> };
        diffs: Array<{ id: string; patch: string }> }>;
      const row = rows.find((item) => item.path === claim.path);
      const head = row?.head.windows.find((window) => window.role === 'candidate'
        && claim.line >= window.startLine && claim.line <= window.endLine);
      const base = row?.base.windows.find((window) => window.role === 'mapped-base'
        && claim.line >= window.startLine && claim.line <= window.endLine);
      const diff = row?.diffs.find((item) => item.patch.includes(`@@ -${claim.line} +${claim.line} @@`));
      const expectedBase = regression
        ? `export function ${regression.fn}(isAdmin: boolean): boolean { return isAdmin; }` : '';
      const expectedHead = regression
        ? `export function ${regression.fn}(isAdmin: boolean): boolean { return true; }` : '';
      if (!regression || !head || !base || !diff
        || !head.source.includes(expectedHead) || !base.source.includes(expectedBase)
        || !diff.patch.includes(`-${expectedBase}`) || !diff.patch.includes(`+${expectedHead}`)) {
        return { model: 'grounded-fixture-model', content: JSON.stringify({ status: 'insufficient', citations: [] }) };
      }
      const citations = [head.id, base.id, diff.id];
      return { model: 'grounded-fixture-model', content: JSON.stringify({
        status: 'confirmed',
        violatedInvariant: `Only administrators may access ${regression.capability}.`,
        failurePath: `The changed ${regression.fn} returns true when isAdmin is false.`,
        benignCheck: `The base implementation returned the caller's isAdmin value.`,
        changeConnection: `The admitted hunk replaces the ${regression.fn} admin predicate with unconditional true.`,
        rootCause: { componentId: `access-control.${regression.id}`, behaviorId: 'admin-gate',
          contractId: 'administrator-only', failureModeId: 'unconditional-allow' },
        causeAnchor: { componentPath: claim.path, side: 'head', startLine: claim.line, endLine: claim.line,
          citationIds: [head.id] },
        causalPath: { relation: 'same-component', candidatePath: claim.path, componentPath: claim.path,
          citationIds: citations },
        baseState: { trigger: 'present', contract: 'not-violated', citationIds: [base.id] },
        headState: { trigger: 'present', contract: 'violated', citationIds: [head.id] },
        causalDelta: { kind: 'introduced', materiality: 'reachability', citationIds: [diff.id] },
        citations,
      }) };
    }),
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    checkClient: checkClient(),
    currentPullRequestVerifier: vi.fn(async () => undefined),
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    composedReviewRunner: vi.fn(async (options: any) => sevenTaskComposedResult(options)) as never,
    repoFileProviderFactory: (input: any) => groundedFixtureProvider(input),
    groundedVerifierClient: groundedFixtureClient as never,
    client: {} as never,
    ...over,
  };
}

describe('composed engine panelSize wiring (threshold invariance)', () => {
  it('blocks a 7-task roster with 3 P1 findings under the single-reviewer threshold', async () => {
    const verifier = accessControlVerifier();
    const receipt = await runPublishingReviewWorker(env(), deps({ groundedVerifierClient: verifier as never }));
    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.blockingFindingCount).toBe(3);
    expect(receipt.coverage).toMatchObject({ mode: 'panel', expectedLaneCount: 7, rosterValid: true,
      quorumSatisfied: true, fullPanelComplete: true });
    expect(receipt.groundedReview?.verification).toMatchObject({ version: 'GroundedIndependentVerification.v2',
      candidates: 3, confirmed: 3, contradicted: 0, insufficient: 0, unverifiedBlockerCount: 0, coverageComplete: true, calls: 3 });
    const outcomes = receipt.groundedReview?.verification.outcomes ?? [];
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ severity: 'P1', status: 'confirmed', candidateSide: 'head',
        evidence: {
          semanticsVersion: 'GroundedReviewEvidenceSemantics.v2',
          baseState: { trigger: 'present', contract: 'not-violated' },
          headState: { trigger: 'present', contract: 'violated' },
          causalDelta: { kind: 'introduced', materiality: 'reachability' },
          scopeProof: {
            identity: { repository: 'exampleorg/example-meta', baseSha: BASE, headSha: HEAD, candidateSide: 'head' },
            independentVerifier: { role: 'independent-grounded-verifier', status: 'confirmed' },
            causalChange: { relation: 'introduced', materiality: 'reachability' },
          },
        } });
      expect(outcome.evidence?.citations).toEqual(expect.arrayContaining([
        expect.objectContaining({ side: 'head', revisionSha: HEAD }),
        expect.objectContaining({ side: 'base', revisionSha: BASE }),
        expect.objectContaining({ side: 'diff', revisionSha: HEAD }),
      ]));
    }
    expect(outcomes.map((outcome) => [outcome.path, outcome.line]).sort()).toEqual(
      ACCESS_CONTROL_REGRESSIONS.map((regression) => [regression.path, regression.line]).sort());
    expect(verifier.complete).toHaveBeenCalledTimes(3);
  });

  it('never calls the fan-out panelRunner when base policy selects the composed engine', async () => {
    const panelRunner = vi.fn();
    const d = deps({ panelRunner: panelRunner as never });
    await runPublishingReviewWorker(env(), d);
    expect(panelRunner).not.toHaveBeenCalled();
    expect(d.composedReviewRunner).toHaveBeenCalledTimes(1);
  });

  it('stays on the fan-out panel engine by default (no policy review_engine)', async () => {
    const panelRunner = vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    const composedReviewRunner = vi.fn();
    const localEnv = env();
    delete (localEnv as Record<string, unknown>).REVIEW_YETI_POLICY_JSON;
    const d = {
      checkClient: checkClient(),
      currentPullRequestVerifier: vi.fn(async () => undefined),
      sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      composedReviewRunner: composedReviewRunner as never,
      client: {} as never,
    };
    await runPublishingReviewWorker(localEnv, d);
    expect(panelRunner).toHaveBeenCalledTimes(1);
    expect(composedReviewRunner).not.toHaveBeenCalled();
  });

  it('never lets a raw REVIEW_ENGINE env var select the engine -- only base policy can', async () => {
    // A PR/dispatch context setting REVIEW_ENGINE=composed directly (with no matching
    // review_engine in base policy) must not switch the review's own engine. Only
    // `workerConfig.review_engine`, projected from base policy, may do that (see
    // `resolveReviewEngine` in `src/cli/publishingReview.ts`).
    const panelRunner = vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    const composedReviewRunner = vi.fn();
    const localEnv = env();
    delete (localEnv as Record<string, unknown>).REVIEW_YETI_POLICY_JSON;
    (localEnv as Record<string, unknown>).REVIEW_ENGINE = 'composed';
    const d = {
      checkClient: checkClient(),
      currentPullRequestVerifier: vi.fn(async () => undefined),
      sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      composedReviewRunner: composedReviewRunner as never,
      client: {} as never,
    };
    await runPublishingReviewWorker(localEnv, d);
    expect(panelRunner).toHaveBeenCalledTimes(1);
    expect(composedReviewRunner).not.toHaveBeenCalled();
  });
});
