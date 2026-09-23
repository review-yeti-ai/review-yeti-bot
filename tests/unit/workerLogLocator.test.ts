import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import {
  renderWorkerLogLocator,
  workerLogsQuery,
  WORKER_POD_NAME_ENV,
  WORKER_POD_NAMESPACE_ENV,
} from '../../src/cli/workerLogLocator';

// REL-1038: every published Review Yeti check names the LogsQL query for its
// own worker Pod, so a failed run stays diagnosable after the Pod is collected.

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const POD = 'ct-review-cccccccccccccccccccccccccccccccc-worker-x7k2p';
const EXPECTED_QUERY = `kubernetes.pod_namespace:"ct-review-system" AND kubernetes.pod_name:"${POD}" | sort by (_time)`;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'calltelemetry/ct-meta',
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
    [WORKER_POD_NAME_ENV]: POD,
    [WORKER_POD_NAMESPACE_ENV]: 'ct-review-system',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function deps(panelRunner: unknown) {
  return {
    checkClient: {
      createCheck: vi.fn(async () => 4242),
      completeCheck: vi.fn(async (_options: { summary: string; conclusion: string }) => {}),
    },
    sourceLoader: vi.fn(async () => ({
      diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      githubReads: 1,
    })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: panelRunner as never,
    client: {} as never,
  };
}

const shipPanel = vi.fn(async () => ({
  applicablePersonaIds: ['sec-lane'],
  personas: [{ id: 'sec-lane', findings: [] }],
  optionalFailures: [],
  quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
  arbiter: { verdict: 'SHIP' },
}));

describe('worker pod identity env contract', () => {
  // The operator (Go) projects these names; the worker (TypeScript) reads them.
  // A rename on one side would silently drop the locator, so pin both.
  it('matches the names the operator projects through the downward API', () => {
    const jobSource = fs.readFileSync(path.resolve(__dirname, '../../k8s-operator/pkg/job/job.go'), 'utf8');
    expect(jobSource).toMatch(new RegExp(`WorkerPodNameEnv\\s*=\\s*"${WORKER_POD_NAME_ENV}"`, 'u'));
    expect(jobSource).toMatch(new RegExp(`WorkerPodNamespaceEnv\\s*=\\s*"${WORKER_POD_NAMESPACE_ENV}"`, 'u'));
    expect(jobSource).toMatch(/Name: WorkerPodNameEnv, ValueFrom: .*FieldPath: "metadata\.name"/u);
    expect(jobSource).toMatch(/Name: WorkerPodNamespaceEnv, ValueFrom: .*FieldPath: "metadata\.namespace"/u);
  });
});

describe('workerLogsQuery', () => {
  it('builds the exact LogsQL locator for the downward-API pod identity', () => {
    expect(workerLogsQuery(env())).toBe(EXPECTED_QUERY);
    expect(renderWorkerLogLocator(env())).toBe(
      ['Worker logs (VictoriaLogs LogsQL):', '```', EXPECTED_QUERY, '```'].join('\n'),
    );
  });

  it('prints nothing when the pod identity is absent', () => {
    expect(workerLogsQuery(env({ [WORKER_POD_NAME_ENV]: undefined }))).toBeNull();
    expect(workerLogsQuery(env({ [WORKER_POD_NAMESPACE_ENV]: '' }))).toBeNull();
    expect(renderWorkerLogLocator(env({ [WORKER_POD_NAME_ENV]: '' }))).toBeNull();
  });

  it.each([
    'pod" OR _msg:*',
    'Pod-Upper',
    'pod name',
    'pod\n```\n# injected',
    `${'a'.repeat(254)}`,
    '-leading-dash',
  ])('refuses a malformed pod name %j instead of escaping it', (podName) => {
    expect(workerLogsQuery(env({ [WORKER_POD_NAME_ENV]: podName }))).toBeNull();
  });

  it('refuses a malformed namespace', () => {
    expect(workerLogsQuery(env({ [WORKER_POD_NAMESPACE_ENV]: 'ct-review-system" OR *' }))).toBeNull();
    expect(workerLogsQuery(env({ [WORKER_POD_NAMESPACE_ENV]: 'a.b' }))).toBeNull();
  });
});

describe('Review Yeti check output', () => {
  it('ends a completed check with the worker log locator', async () => {
    const d = deps(shipPanel);
    await runPublishingReviewWorker(env(), d);
    expect(d.checkClient.completeCheck).toHaveBeenCalledTimes(1);
    const { summary } = d.checkClient.completeCheck.mock.calls[0][0];
    expect(summary).toContain(EXPECTED_QUERY);
    expect(summary.trimEnd().endsWith('```')).toBe(true);
  });

  it('includes the locator on the fail-closed check, where it matters most', async () => {
    const failingPanel = vi.fn(async () => {
      throw new Error('persona lane crashed');
    });
    const d = deps(failingPanel);
    await runPublishingReviewWorker(env(), d).catch(() => undefined);
    const failure = d.checkClient.completeCheck.mock.calls.find(([options]) => options.conclusion === 'failure');
    expect(failure, 'expected a fail-closed check').toBeDefined();
    expect(failure![0].summary).toContain(EXPECTED_QUERY);
  });

  it('omits the locator entirely without a pod identity', async () => {
    const d = deps(shipPanel);
    await runPublishingReviewWorker(env({ [WORKER_POD_NAME_ENV]: undefined }), d);
    const { summary } = d.checkClient.completeCheck.mock.calls[0][0];
    expect(summary).not.toContain('VictoriaLogs');
    expect(summary).not.toContain('kubernetes.pod_name');
  });
});
