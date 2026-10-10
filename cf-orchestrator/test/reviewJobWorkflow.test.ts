import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ReviewJobWorkflow } from '../src/reviewJobWorkflow.js';
import { MockContainerRunner, CloudflareContainerRunner } from '../src/runners/containerRunner.js';
import { DigitalOceanAgentRunner } from '../src/runners/digitalOceanAgentRunner.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import {
  REVIEW_GATE_CHECK_NAME,
  REVIEW_WORKER_CHECK_NAME,
  deriveGateExternalId,
  deriveWorkerExternalId,
} from '../src/github/edgeCheckPublisher.js';
import { createMockEnv, MockDurableObjectState } from './mockDurableObject.js';
import { reviewRunSpecDigest } from '../src/reviewRunIdentity.js';
import type { ReviewRunSpec } from '../src/types.js';

function assertCloudflareStepConfig(name: string, config: any): void {
  if (config?.retries && !Object.hasOwn(config.retries, 'delay')) {
    throw new Error(`Step config for ${name} is invalid: retries.delay is required`);
  }
}

function createOperatorPauseSpec(): ReviewRunSpec {
  return {
    runId: 'run_operator_pause_fixture',
    owner: 'exampleorg',
    repo: 'sample-project',
    prNumber: 7,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    installationId: 42,
  };
}

function installOperatorPauseGitHubMock(options: { appId?: number; headSha?: string; priorChecks?: any[]; reviews?: any[] } = {}) {
  const originalFetch = globalThis.fetch;
  const timeline: string[] = [];
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const checks = new Map<number, any>((options.priorChecks || []).map((check) => [check.id, check]));
  const expectedAppId = options.appId ?? 12345;
  let nextId = 701;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ method, path: url.pathname, body });

    if (url.pathname === '/repos/exampleorg/sample-project/pulls/7' && method === 'GET') {
      timeline.push('get-current-pr');
      return Response.json({
        state: 'open',
        draft: false,
        head: { sha: options.headSha ?? 'a'.repeat(40) },
        base: { sha: 'b'.repeat(40), ref: 'main' },
      });
    }

    if (url.pathname === `/repos/exampleorg/sample-project/commits/${options.headSha ?? 'a'.repeat(40)}/check-runs` && method === 'GET') {
      timeline.push('list-current-head-checks');
      const priorChecks = options.priorChecks || [];
      return Response.json({ total_count: priorChecks.length, check_runs: priorChecks });
    }
    if (url.pathname === '/repos/exampleorg/sample-project/pulls/7/reviews' && method === 'GET') {
      timeline.push('list-current-pr-reviews');
      return Response.json(options.reviews || []);
    }

    if (url.pathname === '/repos/exampleorg/sample-project/check-runs' && method === 'POST') {
      const id = nextId++;
      const check = { ...body, id, app: { id: expectedAppId } };
      checks.set(id, check);
      timeline.push(`create:${check.name}`);
      return Response.json(check);
    }

    const checkMatch = url.pathname.match(/\/check-runs\/(\d+)$/u);
    if (checkMatch) {
      const id = Number(checkMatch[1]);
      const current = checks.get(id);
      if (method === 'GET') {
        timeline.push(`read:${current?.name || id}:${current?.status || 'missing'}`);
        return current ? Response.json(current) : new Response('Not Found', { status: 404 });
      }
      if (method === 'PATCH' && current) {
        Object.assign(current, body);
        timeline.push(`patch:${current.name}:${body.conclusion}`);
        return Response.json(current);
      }
    }

    if (url.pathname.includes('/issues/') && url.pathname.endsWith('/comments')) {
      if (method === 'GET') return Response.json([]);
      if (method === 'POST') return Response.json({ id: 703 });
    }
    if (url.pathname.endsWith('/pulls/7/reviews') && method === 'POST') {
      return Response.json({ id: 704 });
    }

    return Response.json({});
  }) as typeof fetch;

  return {
    checks,
    requests,
    timeline,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

function captureReviewRunReceipt(env: any, timeline: string[], failPrepared = false, events: any[] = []) {
  const original = env.REVIEW_RUN;
  let receipt: any;
  env.REVIEW_RUN = {
    idFromName: original.idFromName,
    get: (id: string) => {
      const stub = original.get(id);
      return {
        fetch: async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          if (path === '/events') {
            timeline.push(`do-event:${body.type}`);
            events.push(body);
            if (failPrepared && body.type === 'operator_passthrough_prepared') {
              return Response.json({ error: 'fixture storage unavailable' }, { status: 503 });
            }
          }
          if (path === '/receipt') {
            receipt = body.receipt;
            timeline.push(`do-receipt:${receipt?.publicationState || 'missing'}`);
          }
          return stub.fetch(url, init);
        },
      };
    },
  };
  return () => receipt;
}

async function installPriorRunWitness(
  env: any,
  spec: ReviewRunSpec,
  runId: string,
  workflowStatus: any,
  terminalReceiptSummary: any
) {
  const original = env.REVIEW_RUN;
  const specDigest = await reviewRunSpecDigest({ ...spec, runId });
  env.REVIEW_RUN = {
    idFromName: original.idFromName,
    get: (id: string) => {
      if (id !== runId) return original.get(id);
      return {
        fetch: async (url: string) => {
          if (new URL(url).pathname !== '/status') return new Response('Not Found', { status: 404 });
          return Response.json({
            runId,
            owner: spec.owner,
            repo: spec.repo,
            prNumber: spec.prNumber,
            headSha: spec.headSha,
            specDigest,
            phase: terminalReceiptSummary.status === 'failed' ? 'Failed' : 'Running',
            isCurrentHead: true,
            cancelRequested: false,
            terminalReceiptSummary,
          });
        },
      };
    },
  };
  env.REVIEW_JOB_WORKFLOW = {
    get: async (id: string) => {
      if (id !== runId) throw new Error('unknown workflow instance');
      return { status: async () => workflowStatus };
    },
  };
}

async function createPriorFailedCheckPair(spec: ReviewRunSpec, runId: string) {
  return [
    {
      id: 601,
      name: REVIEW_WORKER_CHECK_NAME,
      head_sha: spec.headSha,
      status: 'completed',
      conclusion: 'failure',
      external_id: deriveWorkerExternalId(runId, 1),
      app: { id: 12345 },
      output: { annotations_count: 0 },
    },
    {
      id: 602,
      name: REVIEW_GATE_CHECK_NAME,
      head_sha: spec.headSha,
      status: 'completed',
      conclusion: 'failure',
      external_id: await deriveGateExternalId({
        owner: spec.owner,
        repo: spec.repo,
        headSha: spec.headSha,
        runId,
        executionAttempt: 1,
      }),
      app: { id: 12345 },
      output: { annotations_count: 0 },
    },
  ];
}

async function runOperatorPauseWithPriorOutcome(options: {
  workflowStatus: any;
  terminalReceiptSummary: any;
  reviews?: any[];
  activeChecks?: boolean;
  activeGate?: boolean;
  omitChecks?: boolean;
}) {
  const spec = createOperatorPauseSpec();
  const priorRunId = `run_${'c'.repeat(32)}`;
  const priorChecks = options.omitChecks ? [] : await createPriorFailedCheckPair(spec, priorRunId);
  if (options.activeChecks) {
    for (const check of priorChecks) {
      check.status = 'in_progress';
      delete (check as any).conclusion;
    }
  }
  const env = {
    ...createMockEnv(),
    OPERATOR_GLOBAL_PASSTHROUGH: 'true',
    PILOT_REPOSITORIES: 'exampleorg/sample-project',
    GITHUB_APP_ID: '12345',
    GITHUB_TOKEN: 'fixture-auth-value',
  };
  const repoGate = env.REPO_GATE.get(env.REPO_GATE.idFromName(`${spec.owner}/${spec.repo}`.toLowerCase()));
  await repoGate.fetch('http://do/acquire', {
    method: 'POST',
    body: JSON.stringify({ runId: priorRunId, headSha: spec.headSha, prNumber: spec.prNumber }),
  });
  if (!options.activeGate) {
    await repoGate.fetch('http://do/release', {
      method: 'POST',
      body: JSON.stringify({ runId: priorRunId }),
    });
  }
  await installPriorRunWitness(env, spec, priorRunId, options.workflowStatus, options.terminalReceiptSummary);
  const api = installOperatorPauseGitHubMock({ priorChecks, reviews: options.reviews });
  const runner = new MockContainerRunner();
  const workflow = new ReviewJobWorkflow(env, runner);
  const receipt = captureReviewRunReceipt(env, api.timeline);
  const mockStep = {
    async do(_name: string, arg2: any, arg3?: any) {
      return (typeof arg2 === 'function' ? arg2 : arg3)();
    },
    async sleep() {},
  };
  try {
    const result = await workflow.run({ payload: spec }, mockStep as any);
    return { result, receipt: receipt(), api, runner, spec, priorRunId };
  } catch (error) {
    api.restore();
    throw error;
  }
}

async function runOperatorPauseWithCurrentTerminalOutcome() {
  const spec = createOperatorPauseSpec();
  const env = {
    ...createMockEnv(),
    OPERATOR_GLOBAL_PASSTHROUGH: 'true',
    PILOT_REPOSITORIES: 'exampleorg/sample-project',
    GITHUB_APP_ID: '12345',
    GITHUB_TOKEN: 'fixture-auth-value',
  };
  const originalRunBinding = env.REVIEW_RUN;
  const instance = new ReviewRunDO(new MockDurableObjectState() as any, env);
  const currentRunStub = {
    fetch: async (url: string, init?: RequestInit) => instance.fetch(new Request(url, init)),
  };
  env.REVIEW_RUN = {
    idFromName: originalRunBinding.idFromName,
    get: (id: string) => id === spec.runId ? currentRunStub : originalRunBinding.get(id),
  };
  await currentRunStub.fetch('http://do/init', { method: 'POST', body: JSON.stringify(spec) });
  const seeded = await currentRunStub.fetch('http://do/receipt', {
    method: 'POST',
    body: JSON.stringify({
      receipt: {
        status: 'failed',
        verdict: 'action_required',
        findings: [{ severity: 'P1', title: 'synthetic blocking finding' }],
      },
      epoch: 1,
    }),
  });
  assert.equal((await seeded.json() as any).accepted, true);
  const seededStatusResponse = await currentRunStub.fetch('http://do/status');
  const seededStatus = await seededStatusResponse.json() as any;

  const repoGate = env.REPO_GATE.get(env.REPO_GATE.idFromName(`${spec.owner}/${spec.repo}`.toLowerCase()));
  await repoGate.fetch('http://do/acquire', {
    method: 'POST',
    body: JSON.stringify({ runId: spec.runId, headSha: spec.headSha, prNumber: spec.prNumber }),
  });
  await repoGate.fetch('http://do/release', { method: 'POST', body: JSON.stringify({ runId: spec.runId }) });

  const api = installOperatorPauseGitHubMock();
  const runner = new MockContainerRunner();
  const workflow = new ReviewJobWorkflow(env, runner);
  const receipt = captureReviewRunReceipt(env, api.timeline);
  const mockStep = {
    async do(_name: string, arg2: any, arg3?: any) {
      return (typeof arg2 === 'function' ? arg2 : arg3)();
    },
    async sleep() {},
  };
  try {
    const result = await workflow.run({ payload: spec }, mockStep as any);
    return { result, receipt: receipt(), api, runner, spec, seededStatus };
  } catch (error) {
    api.restore();
    throw error;
  }
}

describe('ReviewJobWorkflow Durable Execution', () => {
  const sampleSpec: ReviewRunSpec = {
    runId: 'run_wf_001',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
    installationId: 1001,
  };

  it('maps the existing deployment pause into Wrangler with a fail-closed default', async () => {
    const wrangler = await readFile(resolve(process.cwd(), 'wrangler.toml'), 'utf8');
    const workflow = await readFile(resolve(process.cwd(), '../.github/workflows/cf-orchestrator-ci.yaml'), 'utf8');
    const deployJob = workflow.slice(workflow.indexOf('name: Deploy to Cloudflare Edge'));

    assert.match(wrangler, /^OPERATOR_GLOBAL_PASSTHROUGH = "true"(?:\s+#.*)?$/mu);
    assert.match(
      deployJob,
      /OPERATOR_GLOBAL_PASSTHROUGH:\s*\$\{\{\s*vars\.REVIEW_YETI_PASSTHROUGH\s*\|\|\s*'true'\s*\}\}/u
    );
    assert.match(deployJob, /vars:\s*\|[\s\S]*?\n\s+OPERATOR_GLOBAL_PASSTHROUGH\s*\n/u);
  });

  it('uses a Cloudflare-valid zero-retry config for container dispatch', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);
    let dispatchConfig: any;
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        const config = typeof arg2 === 'function' ? undefined : arg2;
        assertCloudflareStepConfig(name, config);
        if (name === 'dispatch-container') dispatchConfig = config;
        return (typeof arg2 === 'function' ? arg2 : arg3)();
      },
      async sleep() {},
    };

    const result = await workflow.run({ payload: sampleSpec }, mockStep as any);

    assert.equal(result.status, 'succeeded');
    assert.equal(dispatchConfig.retries.limit, 0);
    assert.equal(dispatchConfig.retries.delay, '1 second');
  });

  it('requires the service-owned enrollment before publishing through the workflow', async () => {
    const spec = { ...createOperatorPauseSpec(), operatorPassthrough: false } as ReviewRunSpec;
    const env = {
      ...createMockEnv(),
      OPERATOR_GLOBAL_PASSTHROUGH: 'true',
      PILOT_REPOSITORIES: 'exampleorg/sample-project',
      GITHUB_APP_ID: '12345',
      GITHUB_TOKEN: 'fixture-auth-value',
    };
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);
    const api = installOperatorPauseGitHubMock();
    const mockStep = {
      async do(_name: string, arg2: any, arg3?: any) {
        return (typeof arg2 === 'function' ? arg2 : arg3)();
      },
      async sleep() {},
    };

    try {
      const result = await workflow.run({ payload: spec }, mockStep as any);

      assert.equal(result.status, 'unavailable');
      assert.equal(result.errorCode, 'service_configuration_unavailable');
      assert.equal(result.mergeEligible, false);
      assert.equal(runner.dispatched.length, 0);
      assert.equal(api.checks.size, 0);
    } finally {
      api.restore();
    }
  });

  it('does not publish a workflow result without current service-owned enrollment', async () => {
    const spec = createOperatorPauseSpec();
    const env = {
      ...createMockEnv(),
      OPERATOR_GLOBAL_PASSTHROUGH: 'true',
      PILOT_REPOSITORIES: 'exampleorg/sample-project',
      GITHUB_APP_ID: '12345',
      GITHUB_TOKEN: 'fixture-auth-value',
    };
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);
    const api = installOperatorPauseGitHubMock({ headSha: 'c'.repeat(40) });
    const mockStep = {
      async do(_name: string, arg2: any, arg3?: any) {
        return (typeof arg2 === 'function' ? arg2 : arg3)();
      },
      async sleep() {},
    };

    try {
      const result = await workflow.run({ payload: spec }, mockStep as any);

      assert.equal(result.status, 'unavailable');
      assert.equal(result.errorCode, 'service_configuration_unavailable');
      assert.equal(result.mergeEligible, false);
      assert.equal(runner.dispatched.length, 0);
      assert.equal(api.checks.size, 0);
    } finally {
      api.restore();
    }
  });

  it('returns unavailable when the deployment pause binding is missing', async () => {
    const spec = createOperatorPauseSpec();
    const env = createMockEnv();
    delete env.OPERATOR_GLOBAL_PASSTHROUGH;
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);
    const mockStep = {
      async do(_name: string, arg2: any, arg3?: any) {
        return (typeof arg2 === 'function' ? arg2 : arg3)();
      },
      async sleep() {},
    };

    const result = await workflow.run({ payload: spec }, mockStep as any);

    assert.equal(result.status, 'unavailable');
    assert.equal(result.mergeEligible, false);
    assert.equal(runner.dispatched.length, 0);
    assert.equal(result.errorCode, 'pause_binding_unavailable');
  });

  it('does not create a check pair before service-owned enrollment is configured', async () => {
    const spec = createOperatorPauseSpec();
    const env = {
      ...createMockEnv(),
      OPERATOR_GLOBAL_PASSTHROUGH: 'true',
      PILOT_REPOSITORIES: 'exampleorg/sample-project',
      GITHUB_APP_ID: '12345',
      GITHUB_TOKEN: 'fixture-auth-value',
    };
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);
    const api = installOperatorPauseGitHubMock({ appId: 99999 });
    const mockStep = {
      async do(_name: string, arg2: any, arg3?: any) {
        return (typeof arg2 === 'function' ? arg2 : arg3)();
      },
      async sleep() {},
    };

    try {
      const result = await workflow.run({ payload: spec }, mockStep as any);

      assert.equal(result.status, 'unavailable');
      assert.equal(result.errorCode, 'service_configuration_unavailable');
      assert.equal(result.mergeEligible, false);
      assert.equal(runner.dispatched.length, 0);
      assert.equal(api.checks.size, 0);
    } finally {
      api.restore();
    }
  });

  it('does not create checks when the authoritative service config is absent', async () => {
    const spec = createOperatorPauseSpec();
    const env = {
      ...createMockEnv(),
      OPERATOR_GLOBAL_PASSTHROUGH: 'true',
      PILOT_REPOSITORIES: 'exampleorg/sample-project',
      GITHUB_APP_ID: '12345',
      GITHUB_TOKEN: 'fixture-auth-value',
    };
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);
    const api = installOperatorPauseGitHubMock();
    const mockStep = {
      async do(_name: string, arg2: any, arg3?: any) {
        return (typeof arg2 === 'function' ? arg2 : arg3)();
      },
      async sleep() {},
    };

    try {
      const result = await workflow.run({ payload: spec }, mockStep as any);

      assert.equal(result.status, 'unavailable');
      assert.equal(result.errorCode, 'service_configuration_unavailable');
      assert.equal(result.mergeEligible, false);
      assert.equal(runner.dispatched.length, 0);
      assert.equal(api.checks.size, 0);
    } finally {
      api.restore();
    }
  });

  it('requires explicit target enrollment despite prior semantic history', async () => {
    const prior = await runOperatorPauseWithPriorOutcome({
      workflowStatus: { status: 'errored', error: { message: 'Step config for "dispatch-container" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/' } },
      terminalReceiptSummary: { status: 'failed', verdict: 'action_required', findingsCount: 1, hasSemanticVerdict: true },
    });
    try {
      assert.equal(prior.result.status, 'unavailable');
      assert.equal(prior.result.errorCode, 'service_configuration_unavailable');
      assert.equal(prior.result.mergeEligible, false);
      assert.equal(prior.runner.dispatched.length, 0);
      assert.equal(prior.api.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/check-runs')).length, 0);
    } finally {
      prior.api.restore();
    }
  });

  it('requires explicit target enrollment when prior review requested changes', async () => {
    const prior = await runOperatorPauseWithPriorOutcome({
      workflowStatus: { status: 'errored', error: { message: 'Step config for "dispatch-container" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/' } },
      terminalReceiptSummary: { status: 'failed', verdict: null, findingsCount: 0, hasSemanticVerdict: false },
      reviews: [{ id: 901, user: { id: 902 }, state: 'CHANGES_REQUESTED',
        submitted_at: '2026-10-10T00:00:00Z', commit_id: 'a'.repeat(40) }],
    });
    try {
      assert.equal(prior.result.status, 'unavailable');
      assert.equal(prior.result.errorCode, 'service_configuration_unavailable');
      assert.equal(prior.result.mergeEligible, false);
      assert.equal(prior.runner.dispatched.length, 0);
      assert.equal(prior.api.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/check-runs')).length, 0);
    } finally {
      prior.api.restore();
    }
  });

  it('requires explicit target enrollment for an unknown same-head workflow failure', async () => {
    const prior = await runOperatorPauseWithPriorOutcome({
      workflowStatus: { status: 'errored', error: { message: 'Step config for dispatch-container is in a invalid format' } },
      terminalReceiptSummary: { status: 'failed', verdict: null, findingsCount: 0, hasSemanticVerdict: false },
    });
    try {
      assert.equal(prior.result.status, 'unavailable');
      assert.equal(prior.result.errorCode, 'service_configuration_unavailable');
      assert.equal(prior.result.mergeEligible, false);
      assert.equal(prior.runner.dispatched.length, 0);
      assert.equal(prior.api.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/check-runs')).length, 0);
    } finally {
      prior.api.restore();
    }
  });

  it('requires explicit target enrollment when a terminal same-head run lacks an App pair', async () => {
    const prior = await runOperatorPauseWithPriorOutcome({
      workflowStatus: { status: 'errored', error: { message: 'Step config for "dispatch-container" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/' } },
      terminalReceiptSummary: { status: 'failed', verdict: null, findingsCount: 0, hasSemanticVerdict: false },
      omitChecks: true,
    });
    try {
      assert.equal(prior.result.status, 'unavailable');
      assert.equal(prior.result.errorCode, 'service_configuration_unavailable');
      assert.equal(prior.result.mergeEligible, false);
      assert.equal(prior.runner.dispatched.length, 0);
      assert.equal(prior.api.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/check-runs')).length, 0);
    } finally {
      prior.api.restore();
    }
  });

  it('requires explicit target enrollment while a same-head prior review is active', async () => {
    const prior = await runOperatorPauseWithPriorOutcome({
      workflowStatus: { status: 'running' },
      terminalReceiptSummary: { status: 'running', verdict: null, findingsCount: 0, hasSemanticVerdict: false },
      activeGate: true,
      omitChecks: true,
    });
    try {
      assert.equal(prior.result.status, 'unavailable');
      assert.equal(prior.result.errorCode, 'service_configuration_unavailable');
      assert.equal(prior.result.mergeEligible, false);
      assert.equal(prior.runner.dispatched.length, 0);
      assert.equal(prior.api.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/check-runs')).length, 0);
    } finally {
      prior.api.restore();
    }
  });

  it('requires explicit target enrollment before a same-run terminal semantic finding can publish', async () => {
    const prior = await runOperatorPauseWithCurrentTerminalOutcome();
    try {
      assert.equal(prior.seededStatus.phase, 'Completed');
      assert.equal(prior.seededStatus.terminalReceiptSummary.verdict, 'action_required');
      assert.equal(prior.seededStatus.terminalReceiptSummary.findingsCount, 1);
      assert.equal(prior.result.status, 'unavailable');
      assert.equal(prior.result.errorCode, 'service_configuration_unavailable');
      assert.equal(prior.result.mergeEligible, false);
      assert.equal(prior.runner.dispatched.length, 0);
      assert.equal(prior.api.checks.size, 0);
      assert.equal(prior.api.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/check-runs')).length, 0);
      assert.equal(prior.api.timeline.some((entry) => entry.startsWith('create:')), false);
    } finally {
      prior.api.restore();
    }
  });

  it('does not retry a prior transport failure without explicit target enrollment', async () => {
    const prior = await runOperatorPauseWithPriorOutcome({
      workflowStatus: { status: 'errored', error: { message: 'Step config for "dispatch-container" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/' } },
      terminalReceiptSummary: { status: 'failed', verdict: null, findingsCount: 0, hasSemanticVerdict: false },
    });
    try {
      assert.equal(prior.result.status, 'unavailable');
      assert.equal(prior.result.errorCode, 'service_configuration_unavailable');
      assert.equal(prior.result.mergeEligible, false);
      assert.equal(prior.runner.dispatched.length, 0);
      assert.equal(prior.api.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/check-runs')).length, 0);
    } finally {
      prior.api.restore();
    }
  });

  it('orchestrates complete review lifecycle and releases repo slot', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

    // Mock workflow step runner
    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
      async sleep(name: string, _duration: any) {
        executedSteps.push(name);
      },
    };

    const result = await workflow.run({ payload: sampleSpec }, mockStep as any);

    assert.equal(result.runId, 'run_wf_001');
    assert.equal(result.status, 'succeeded');

    // Verify all 5 steps ran
    assert.deepEqual(executedSteps, [
      'mint-scoped-token',
      'acquire-fencing-lease',
      'dispatch-container',
      'verify-and-record-receipt',
      'cleanup-and-release',
    ]);

    // Verify container received expected parameters
    assert.equal(runner.dispatched.length, 1);
    assert.equal(runner.dispatched[0].runId, 'run_wf_001');
    assert.equal(runner.dispatched[0].prNumber, 42);
    assert.ok(runner.dispatched[0].env.GITHUB_TOKEN.startsWith('ghs_ephemeral_'));
    assert.equal(Object.hasOwn(runner.dispatched[0].env, 'DISPATCH_STATUS_URL'), false);

    // Verify slot released in RepoGateDO
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    const statusRes = await repoGate.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.activeCount, 0);
  });

  it('waits for concurrency slot using step.sleep and succeeds when slot becomes available', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

    // Occupy slot beforehand
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'prior_run', headSha: 'abc' }),
    });

    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        // Before poll-slot-1 runs, simulate prior run releasing slot
        if (name === 'poll-slot-1') {
          await repoGate.fetch('http://do/release', {
            method: 'POST',
            body: JSON.stringify({ runId: 'prior_run' }),
          });
        }
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
      async sleep(name: string, _duration: any) {
        executedSteps.push(name);
      },
    };

    const result = await workflow.run({ payload: sampleSpec }, mockStep as any);
    assert.equal(result.status, 'succeeded');

    assert.ok(executedSteps.includes('acquire-fencing-lease'));
    assert.ok(executedSteps.includes('wait-for-slot-1'));
    assert.ok(executedSteps.includes('poll-slot-1'));
    assert.ok(executedSteps.includes('dispatch-container'));
    assert.ok(executedSteps.includes('cleanup-and-release'));
  });

  for (const { name, settings, expectedOrigin } of [
    { name: 'dispatch setting', settings: { DISPATCH_STATUS_BASE_URL: 'https://operator.example.com' }, expectedOrigin: 'https://operator.example.com' },
    { name: 'operator compatibility setting', settings: { OPERATOR_STATUS_BASE_URL: 'https://legacy.example.com' }, expectedOrigin: 'https://legacy.example.com' },
    { name: 'dispatch setting when both are configured', settings: { DISPATCH_STATUS_BASE_URL: 'https://operator.example.com', OPERATOR_STATUS_BASE_URL: 'https://legacy.example.com' }, expectedOrigin: 'https://operator.example.com' },
  ]) {
    it(`uses the explicit deployment-owned ${name}`, async () => {
      const env = { ...createMockEnv(), ...settings };
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow(env, runner);
      const mockStep = {
        async do(_name: string, arg2: any, arg3?: any) {
          return (typeof arg2 === 'function' ? arg2 : arg3)();
        },
        async sleep() {},
      };
      const result = await workflow.run({ payload: { ...sampleSpec, runId: 'run-status-origin' } }, mockStep as any);
      assert.equal(result.status, 'succeeded');
      assert.equal(runner.dispatched[0].env.DISPATCH_STATUS_URL, `${expectedOrigin}/api/dispatch/runs/run-status-origin/status`);
    });
  }

  for (const { name, settings, runId, expectedUrl } of [
    {
      name: 'bare origin',
      settings: { DISPATCH_STATUS_BASE_URL: 'https://operator.example.com' },
      runId: 'run-bare-origin',
      expectedUrl: 'https://operator.example.com/api/dispatch/runs/run-bare-origin/status',
    },
    {
      name: 'configured path prefix',
      settings: { DISPATCH_STATUS_BASE_URL: 'https://operator.example.com/gateway/review-yeti' },
      runId: 'run-path-prefix',
      expectedUrl: 'https://operator.example.com/gateway/review-yeti/api/dispatch/runs/run-path-prefix/status',
    },
    {
      name: 'trailing-slash path prefix and encoded run ID',
      settings: { OPERATOR_STATUS_BASE_URL: 'https://legacy.example.com/gateway/review-yeti/' },
      runId: 'run/slash ?#%',
      expectedUrl: 'https://legacy.example.com/gateway/review-yeti/api/dispatch/runs/run%2Fslash%20%3F%23%25/status',
    },
    {
      name: 'preferred dispatch path prefix when both settings exist',
      settings: {
        DISPATCH_STATUS_BASE_URL: 'https://operator.example.com/preferred',
        OPERATOR_STATUS_BASE_URL: 'https://legacy.example.com/ignored/',
      },
      runId: 'run-preferred-prefix',
      expectedUrl: 'https://operator.example.com/preferred/api/dispatch/runs/run-preferred-prefix/status',
    },
  ]) {
    it(`preserves dispatch status ${name}`, async () => {
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow({ ...createMockEnv(), ...settings }, runner);
      const mockStep = {
        async do(_name: string, arg2: any, arg3?: any) {
          return (typeof arg2 === 'function' ? arg2 : arg3)();
        },
        async sleep() {},
      };
      const result = await workflow.run({ payload: { ...sampleSpec, runId } }, mockStep as any);
      assert.equal(result.status, 'succeeded');
      assert.equal(runner.dispatched[0].env.DISPATCH_STATUS_URL, expectedUrl);
    });
  }

  for (const { name, value } of [
    { name: 'malformed URL', value: 'https://' },
    { name: 'schemeless URL', value: 'operator.example.com/gateway' },
    { name: 'unsupported protocol', value: 'ftp://operator.example.com/gateway' },
    { name: 'embedded credentials', value: 'https://fixture-user:fixture-password@operator.example.com/gateway' },
    { name: 'embedded username', value: 'https://fixture-user@operator.example.com/gateway' },
    { name: 'embedded password', value: 'https://:fixture-password@operator.example.com/gateway' },
  ]) {
    for (const { label, binding } of [
      { label: 'preferred setting', binding: 'DISPATCH_STATUS_BASE_URL' },
      { label: 'compatibility setting', binding: 'OPERATOR_STATUS_BASE_URL' },
    ]) {
      it(`omits invalid dispatch status hint for a ${name} from the ${label} without stopping dispatch`, async () => {
        const runner = new MockContainerRunner();
        const workflow = new ReviewJobWorkflow({ ...createMockEnv(), [binding]: value }, runner);
        const mockStep = {
          async do(_name: string, arg2: any, arg3?: any) {
            return (typeof arg2 === 'function' ? arg2 : arg3)();
          },
          async sleep() {},
        };
        const result = await workflow.run({ payload: { ...sampleSpec, runId: 'run-invalid-status-hint' } }, mockStep as any);
        assert.equal(result.status, 'succeeded');
        assert.equal(runner.dispatched.length, 1);
        assert.equal(Object.hasOwn(runner.dispatched[0].env, 'DISPATCH_STATUS_URL'), false);
      });
    }
  }

  it('omits an invalid preferred status hint without falling back to the compatibility setting', async () => {
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow({
      ...createMockEnv(),
      DISPATCH_STATUS_BASE_URL: 'https://',
      OPERATOR_STATUS_BASE_URL: 'https://legacy.example.com/gateway',
    }, runner);
    const mockStep = {
      async do(_name: string, arg2: any, arg3?: any) {
        return (typeof arg2 === 'function' ? arg2 : arg3)();
      },
      async sleep() {},
    };
    const result = await workflow.run({ payload: { ...sampleSpec, runId: 'run-invalid-preferred-status-hint' } }, mockStep as any);
    assert.equal(result.status, 'succeeded');
    assert.equal(runner.dispatched.length, 1);
    assert.equal(Object.hasOwn(runner.dispatched[0].env, 'DISPATCH_STATUS_URL'), false);
  });

  it('accepts an explicit HTTP status hint while preserving its prefix and encoded run ID', async () => {
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow({
      ...createMockEnv(),
      DISPATCH_STATUS_BASE_URL: 'http://operator.example.com/gateway/',
    }, runner);
    const mockStep = {
      async do(_name: string, arg2: any, arg3?: any) {
        return (typeof arg2 === 'function' ? arg2 : arg3)();
      },
      async sleep() {},
    };
    const result = await workflow.run({ payload: { ...sampleSpec, runId: 'run/http ?#%' } }, mockStep as any);
    assert.equal(result.status, 'succeeded');
    assert.equal(runner.dispatched.length, 1);
    assert.equal(runner.dispatched[0].env.DISPATCH_STATUS_URL, 'http://operator.example.com/gateway/api/dispatch/runs/run%2Fhttp%20%3F%23%25/status');
  });

  it('guarantees repo slot release in finally block even if container dispatch throws', async () => {
    const env = createMockEnv();
    // Runner that throws an exception during dispatch
    const failingRunner = {
      async dispatchJob(): Promise<any> {
        throw new Error('Sandbox Firecracker microVM launch failure: Out of memory');
      },
      async terminateJob(): Promise<any> {
        return { terminated: true };
      },
    };

    const workflow = new ReviewJobWorkflow(env, failingRunner as any);
    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
    };

    await assert.rejects(
      async () => workflow.run({ payload: sampleSpec }, mockStep as any),
      /Sandbox Firecracker microVM launch failure/
    );

    // Assert cleanup-and-release was still executed
    assert.ok(executedSteps.includes('cleanup-and-release'));

    // Assert RepoGateDO slot is clean (activeCount === 0)
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    const statusRes = await repoGate.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.activeCount, 0);

    // Assert ReviewRunDO received failed terminal receipt
    const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
    const runStatusRes = await runDO.fetch('http://do/status');
    const runStatus = (await runStatusRes.json()) as any;
    assert.equal(runStatus.phase, 'Failed');
  });

  it('guarantees repo slot release in finally block even if lease acquisition fails', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    // Pre-initialize and cancel runDO so /lease/acquire fails with cancel_requested
    const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
    await runDO.fetch('http://do/init', { method: 'POST', body: JSON.stringify(sampleSpec) });
    await runDO.fetch('http://do/cancel', { method: 'POST', body: JSON.stringify({ reason: 'pre_cancel' }) });

    const workflow = new ReviewJobWorkflow(env, runner);
    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
    };

    await assert.rejects(
      async () => workflow.run({ payload: sampleSpec }, mockStep as any),
      /Lease acquisition failed/
    );

    assert.ok(executedSteps.includes('cleanup-and-release'));
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    const statusRes = await repoGate.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.activeCount, 0);
  });

  it('persists receipt audit record to PostgreSQL Hyperdrive gracefully', async () => {
    const env = createMockEnv();
    env.HYPERDRIVE = {
      connectionString: 'postgresql://review_yeti:secret@hyperdrive.internal:5432/review_yeti_staging',
    };
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
    };

    const result = await workflow.run({ payload: sampleSpec }, mockStep as any);
    assert.equal(result.status, 'succeeded');
    assert.ok(executedSteps.includes('verify-and-record-receipt'));
  });

  it('terminates polling loop immediately and triggers saga release when ReviewRunDO is cancelled while waiting for concurrency slot', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

    // Occupy slot beforehand with a prior run
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'prior_run', headSha: 'abc' }),
    });

    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        // Before poll-slot-1 runs, simulate cancellation of this workflow's run in ReviewRunDO
        if (name === 'poll-slot-1') {
          const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
          await runDO.fetch('http://do/cancel', {
            method: 'POST',
            body: JSON.stringify({ reason: 'superseded_by_commit' }),
          });
        }
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
      async sleep(name: string, _duration: any) {
        executedSteps.push(name);
      },
    };

    await assert.rejects(
      async () => workflow.run({ payload: sampleSpec }, mockStep as any),
      /Workflow cancelled while waiting for concurrency slot/
    );

    // Verify step progression: acquire-fencing-lease, sleep, poll-slot-1, and cleanup-and-release
    assert.ok(executedSteps.includes('acquire-fencing-lease'));
    assert.ok(executedSteps.includes('wait-for-slot-1'));
    assert.ok(executedSteps.includes('poll-slot-1'));
    assert.ok(executedSteps.includes('cleanup-and-release'));

    // Assert container dispatch and receipt steps were SKIPPED
    assert.ok(!executedSteps.includes('dispatch-container'), 'dispatch-container must not run');
    assert.ok(!executedSteps.includes('verify-and-record-receipt'), 'verify-and-record-receipt must not run');
    assert.equal(runner.dispatched.length, 0);

    // Assert RepoGateDO queue was cleaned up for this runId
    const statusRes = await repoGate.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.queueLength, 0, 'Queue must be empty after saga cleanup');
  });

  it('initializes ReviewRunDO in acquire-fencing-lease so queued runs report Pending phase and isCurrentHead: true', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

    // Occupy slot beforehand
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'prior_run', headSha: 'abc' }),
    });

    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
      async sleep(_name: string, _duration: any) {
        // Halt workflow inside sleep to check intermediate state
        throw new Error('STOP_AT_SLEEP');
      },
    };

    try {
      await workflow.run({ payload: sampleSpec }, mockStep as any);
    } catch (err: any) {
      assert.equal(err.message, 'STOP_AT_SLEEP');
    }

    // Inspect ReviewRunDO: MUST be initialized in Pending state with isCurrentHead: true
    const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
    const statusRes = await runDO.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.phase, 'Pending');
    assert.equal(status.cancelRequested, false);
    assert.equal(status.isCurrentHead, true);
    assert.equal(status.fencingEpoch, 1);
  });

  describe('DigitalOcean Managed Agents (MARS) Runner Execution', () => {
    it('instantiates DigitalOceanAgentRunner when RUNNER_TYPE is digitalocean or mars', async () => {
      let dispatchedSessionBody: any = null;
      let authHeader = '';
      let reviewRunIdHeader = '';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        const urlStr = typeof input === 'string' ? input : input.url;
        if (urlStr.includes('/v2/genai/agents/custom-swarm-agent/sessions')) {
          dispatchedSessionBody = JSON.parse(init.body);
          authHeader = init.headers?.Authorization;
          reviewRunIdHeader = init.headers?.['X-Review-Run-Id'];
          return new Response(
            JSON.stringify({
              id: 'sess-12345',
              status: 'succeeded',
              exit_code: 0,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return originalFetch(input, init);
      };

      try {
        const env = {
          ...createMockEnv(),
          RUNNER_TYPE: 'digitalocean',
          DO_API_TOKEN: 'dop_v1_mock_token_12345',
          DO_AGENT_ID: 'custom-swarm-agent',
          DO_BASE_URL: 'https://api.digitalocean.com',
          PARALLEL_CHECK_NAME: 'Review Yeti',
        };

        const workflow = new ReviewJobWorkflow(env);

        // Pre-initialize ReviewRunDO with valid terminal receipt so verify step succeeds
        const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
        await runDO.fetch('http://do/init', {
          method: 'POST',
          body: JSON.stringify(sampleSpec),
        });
        await runDO.fetch('http://do/lease/acquire', {
          method: 'POST',
          body: JSON.stringify({ workerId: `cf-worker-${sampleSpec.runId.slice(0, 8)}`, epoch: 1 }),
        });
        await runDO.fetch('http://do/receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workerId: `cf-worker-${sampleSpec.runId.slice(0, 8)}`,
            epoch: 1,
            receipt: {
              status: 'success',
              findings: [],
              verdict: 'approved',
              summary: 'Clean PR',
            },
          }),
        });

        const mockStep = {
          async do(name: string, arg2: any, arg3?: any) {
            const fn = typeof arg2 === 'function' ? arg2 : arg3;
            return fn();
          },
        };

        const result = await workflow.run({ payload: sampleSpec }, mockStep as any);

        assert.equal(result.runId, sampleSpec.runId);
        assert.equal(authHeader, 'Bearer dop_v1_mock_token_12345');
        assert.equal(reviewRunIdHeader, sampleSpec.runId);
        assert.ok(dispatchedSessionBody);
        assert.equal(dispatchedSessionBody.session_id, `job-${sampleSpec.runId}`);
        assert.equal(dispatchedSessionBody.environment.PARALLEL_CHECK_NAME, 'Review Yeti');
        assert.equal(dispatchedSessionBody.environment.RUN_ID, sampleSpec.runId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('keys runner cache by normalized runner type and allows subsequent distinct target runners', () => {
      const env = createMockEnv();
      const workflow = new ReviewJobWorkflow(env);

      const cfRunner = workflow.getRunner('cloudflare');
      assert.ok(cfRunner instanceof CloudflareContainerRunner);

      const doRunner = workflow.getRunner('digitalocean');
      assert.ok(doRunner instanceof DigitalOceanAgentRunner);

      // Verify DO alias 'mars' returns the cached DigitalOcean runner
      const marsRunner = workflow.getRunner('mars');
      assert.equal(marsRunner, doRunner);

      // Verify subsequent request for cloudflare runner returns the cached Cloudflare runner
      const cfRunner2 = workflow.getRunner('cloudflare');
      assert.equal(cfRunner2, cfRunner);
    });

    it('falls back to DigitalOcean runner in production if Containers binding is unavailable', async () => {
      const originalFetch = globalThis.fetch;
      let doInvoked = false;
      try {
        globalThis.fetch = async (url: any) => {
          if (String(url).includes('digitalocean.com')) {
            doInvoked = true;
            return Response.json({ session_id: 'session-123', status: 'running' });
          }
          return new Response('Not Found', { status: 404 });
        };

        const env = {
          ...createMockEnv(),
          ENVIRONMENT: 'production',
          DO_API_TOKEN: 'dop_mock_token_production',
          DO_AGENT_ID: 'swarm-do-1',
        };
        const workflow = new ReviewJobWorkflow(env);
        const runner = workflow.getRunner('cloudflare') as CloudflareContainerRunner;

        assert.ok(runner instanceof CloudflareContainerRunner);

        const result = await runner.dispatchJob({
          jobId: 'job-1',
          runId: 'run-1',
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 42,
          headSha: 'head-sha',
          baseSha: 'base-sha',
          workerImage: 'ghcr.io/test:latest',
          env: {},
        });

        assert.ok(doInvoked, 'Expected fallback to DigitalOcean agent runner');
        assert.equal(result.jobId, 'job-1');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
