import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { name?: string; if?: string; needs?: string | string[]; permissions?: Record<string, string>; steps: Step[] };
type Workflow = { on: Record<string, { branches?: string[]; types?: string[] } | null | unknown[]>;
  concurrency?: { group?: string; 'cancel-in-progress'?: string | boolean };
  permissions?: Record<string, string>; jobs: Record<string, Job> };
type Event = { name: string; action?: string; base?: string; ref?: string; draft?: boolean; state?: string; subject?: string };
type Need = { result: string; outputs: Record<string, string> };
const root = path.resolve(__dirname, '../..');
const ci = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/ci-cd.yaml'), 'utf8')) as Workflow;
const paid = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/review-bot.yaml'), 'utf8')) as Workflow;
const quality = ['test-plan', 'vitest', 'vitest-postgres', 'worker-helper', 'build', 'test', 'typecheck', 'operator-test', 'legacy-runtime'];
const publication = ['publish-ghcr-arch', 'publish-ghcr', 'attest-published-indexes'];
const actions = ['opened', 'synchronize', 'reopened', 'ready_for_review'];
const draft: Event = { name: 'pull_request', action: 'opened', base: 'main', ref: 'refs/pull/42/merge', state: 'open', draft: true };
function needs(): Record<string, Need> {
  return Object.fromEntries([...quality, ...publication].map(id => [id, { result: 'success', outputs: {
    'shard-count': '4', 'postgres-tests': '["tests/integration/example.postgres.test.ts"]',
  } }]));
}

function eventRegistered(event: Event, workflow: Workflow): boolean {
  const selector = workflow.on[event.name];
  if (event.name === 'pull_request' || event.name === 'repository_dispatch') {
    const configured = selector as { branches?: string[]; types?: string[] } | undefined;
    return !!configured?.types?.includes(event.action ?? '')
      && (!configured.branches || configured.branches.includes(event.base ?? ''));
  }
  if (event.name === 'push') {
    const configured = selector as { branches?: string[] } | undefined;
    return !!configured?.branches?.includes((event.ref ?? '').replace(/^refs\/heads\//u, ''));
  }
  return (event.name === 'schedule' || event.name === 'workflow_dispatch') && Object.hasOwn(workflow.on, event.name);
}

function evaluateGuard(guard: string | undefined, event: Event, dependencies: Record<string, Need>): boolean {
  if (!guard) return true;
  const expression = guard.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/gu, '');
  const tokens = expression.match(/\s+|github\.(?:event_name|ref|event\.action|event\.head_commit\.message|event\.pull_request\.(?:draft|state))|needs\.[a-z-]+\.(?:result|outputs\.[a-z-]+)|always\(\)|startsWith|'(?:[^'\\]|\\.)*'|true|false|==|!=|\|\||&&|[!(),]/gu) ?? [];
  if (tokens.join('') !== expression) throw new Error('Unsupported workflow condition syntax');
  const executable = tokens.map(token => token.startsWith('needs.')
    ? 'needs' + token.slice(6).split('.').map(key => `[${JSON.stringify(key)}]`).join('') : token).join('');
  return Boolean(vm.runInNewContext(executable, {
    github: { event_name: event.name, ref: event.ref, event: {
      action: event.action,
      head_commit: { message: event.subject }, pull_request: { draft: event.draft, state: event.state },
    } }, needs: dependencies, always: () => true,
    startsWith: (value: string, prefix: string) => value.toLowerCase().startsWith(prefix.toLowerCase()),
  }, { timeout: 2000 }));
}

function admitted(id: string, event: Event, workflow = ci, dependencies = needs()): boolean {
  if (!eventRegistered(event, workflow)) return false;
  const job = workflow.jobs[id];
  if (!job) throw new Error('Missing workflow job');
  const prerequisites = typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];
  // GitHub adds success() to a job condition unless it already uses a status function.
  if (!String(job.if ?? '').includes('always()') && prerequisites.some(key => dependencies[key].result !== 'success')) return false;
  return evaluateGuard(job.if, event, dependencies);
}

function cancelsInProgress(event: Event, workflow = ci): boolean {
  const predicate = workflow.concurrency?.['cancel-in-progress'];
  if (typeof predicate === 'boolean') return predicate;
  if (typeof predicate !== 'string') throw new Error('Missing workflow concurrency predicate');
  return evaluateGuard(predicate, event, needs());
}

function workflowStrings(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  return Object.entries(value).flatMap(([key, nested]) => [key, workflowStrings(nested)]).join('\n');
}

function assertQualityClasses(workflow: Workflow): void {
  expect(Object.keys(workflow.jobs).sort()).toEqual([...quality, ...publication].sort());
  expect(workflow.permissions).toBeUndefined();
  for (const id of quality) {
    const job = workflow.jobs[id];
    expect(job.permissions).toEqual(id === 'test' ? {} : { contents: 'read' });
    expect(workflowStrings(job)).not.toMatch(/\bsecrets\b|CT_REVIEW_BOT_APP|calltelemetry\/ct-review-actions|\b(?:kubectl|doctl)\b/iu);
  }
  const build = workflow.jobs['legacy-runtime'].steps.find(step => step.uses?.startsWith('docker/build-push-action@'));
  expect(build?.with).toMatchObject({ load: true, push: false });
}

describe('public draft quality admission', () => {
  it('keeps the exact existing event/branch selectors', () => {
    expect(ci.on.pull_request).toEqual({ branches: ['main'], types: actions });
    expect(ci.on.push).toEqual({ branches: ['main'] });
    expect(ci.on.schedule).toEqual([{ cron: '23 7 * * *' }]);
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch']);
  });

  it.each(actions)('runs all ordinary quality jobs on an open draft %s', action => {
    for (const id of quality) expect(admitted(id, { ...draft, action }), id).toBe(true);
  });

  it.each(actions)('preserves ordinary quality admission on a ready %s', action => {
    for (const id of quality) expect(admitted(id, { ...draft, action, draft: false }), id).toBe(true);
  });

  it.each([
    { ...draft, action: 'edited', draft: false }, { ...draft, action: 'closed', draft: false },
    { ...draft, action: 'converted_to_draft', draft: false }, { ...draft, base: 'other', draft: false },
    { ...draft, name: 'pull_request_target', draft: false }, { name: 'repository_dispatch', action: 'review-requested' },
    { name: 'push', ref: 'refs/heads/other' }, { name: 'unknown-event' },
  ])('rejects unregistered event or branch %j', event => {
    for (const id of [...quality, ...publication]) expect(admitted(id, event), id).toBe(false);
  });

  it.each(['push', 'schedule', 'workflow_dispatch'])('preserves the existing %s quality path', name => {
    for (const id of quality) expect(admitted(id, { name, ref: 'refs/heads/main', subject: 'fix: ordinary change' }), id).toBe(true);
  });

  it('retains release-commit skips while keeping the existing type and operator checks', () => {
    const event = { name: 'push', ref: 'refs/heads/main', subject: 'chore(main): release 1.2.3' };
    for (const id of ['test-plan', 'worker-helper', 'build', 'test', 'legacy-runtime']) expect(admitted(id, event), id).toBe(false);
    for (const id of ['typecheck', 'operator-test']) expect(admitted(id, event), id).toBe(true);
    const skipped = needs(); skipped['test-plan'].result = 'skipped';
    expect(admitted('vitest', event, ci, skipped)).toBe(false);
    expect(admitted('vitest-postgres', event, ci, skipped)).toBe(false);
  });

  it.each(['failure', 'cancelled', 'skipped'])('does not launch planned tests after a %s plan', result => {
    const dependency = needs(); dependency['test-plan'].result = result;
    expect(admitted('vitest', draft, ci, dependency)).toBe(false);
    expect(admitted('vitest-postgres', draft, ci, dependency)).toBe(false);
    expect(admitted('test', draft, ci, dependency)).toBe(true); // actual aggregator must run and reject the failed plan
  });

  it('skips only the unneeded shard and Postgres jobs identified by a successful plan', () => {
    const empty = needs(); empty['test-plan'].outputs = { 'shard-count': '0', 'postgres-tests': '[]' };
    expect(admitted('vitest', draft, ci, empty)).toBe(false);
    expect(admitted('vitest-postgres', draft, ci, empty)).toBe(false);
    expect(admitted('test', draft, ci, empty)).toBe(true);
  });

  it('admits only the existing ordinary quality classes with read-only permissions and no publishing', () => {
    assertQualityClasses(ci);
  });

  it.each([true, false])('never admits publication from a pull request with draft=%s', isDraft => {
    for (const id of publication) {
      expect(admitted(id, { ...draft, draft: isDraft }), id).toBe(false);
      expect(admitted(id, { ...draft, draft: isDraft, ref: 'refs/heads/main' }), id).toBe(false);
    }
  });

  it.each(['push', 'workflow_dispatch'])('preserves successful main-only %s publication', name => {
    for (const id of publication) expect(admitted(id, { name, ref: 'refs/heads/main', subject: 'fix: ordinary change' }), id).toBe(true);
    if (name === 'workflow_dispatch') for (const id of publication) expect(admitted(id, { name, ref: 'refs/heads/other' }), id).toBe(false);
  });

  it('retains the exact paid readiness guard, public engine, and retired internal boundary', () => {
    expect(paid.jobs.review.if).toBe("${{ github.event_name == 'repository_dispatch' || (github.event.pull_request.state == 'open' && !github.event.pull_request.draft) }}");
    expect(paid.on.pull_request).toEqual({ types: actions });
    expect(paid.jobs.review.name).toBe('Execute AI Review Pipeline');
    expect(paid.jobs.review.steps.filter(step => step.uses === './').map(step => step.with?.['execution-backend'])).toEqual(['local']);
    expect(fs.existsSync(path.join(root, '.github/workflows/ct-review-bot.yml'))).toBe(false);
    for (const action of actions) {
      expect(admitted('review', { ...draft, action }, paid)).toBe(false);
      expect(admitted('review', { ...draft, action, draft: false }, paid)).toBe(true);
      expect(admitted('review', { ...draft, action, draft: false, state: 'closed' }, paid)).toBe(false);
    }
    expect(admitted('review', { name: 'repository_dispatch', action: 'review-requested' }, paid)).toBe(true);
  });

  it.each([
    '${{ secrets.SOME_TOKEN }}',
    "${{ secrets['SOME_TOKEN'] }}",
    "${{ secrets [ 'SOME_TOKEN' ] }}",
    "${{ SECRETS['SOME_TOKEN'] }}",
    '${{ SeCrEtS . SOME_TOKEN }}',
    "${{ secrets\t['SOME_TOKEN'] }}",
    "${{\n secrets\r\n[\t'SOME_TOKEN'\t] }}",
    "${{ secrets[format('SOME_{0}', 'TOKEN')] }}",
    '${{ toJSON(secrets) }}',
    '${{ secrets }}',
    '${{ toJSON(SECRETS) }}',
    '${{\n toJSON(\tSeCrEtS\r\n) }}',
    "${{ format('{0}', toJSON(secrets)) }}",
  ].flatMap(expression => ['job-env', 'step-env', 'step-with', 'step-run'].map(location => ({ location, expression }))))(
    'rejects planted quality secret access at $location: $expression', ({ location, expression }) => {
      const secret = structuredClone(ci);
      const job = secret.jobs.build;
      if (location === 'job-env') Object.assign(job, { env: { TOKEN: expression } });
      if (location === 'step-env') Object.assign(job.steps[0], { env: { TOKEN: expression } });
      if (location === 'step-with') job.steps[0].with = { ...job.steps[0].with, token: expression };
      if (location === 'step-run') job.steps.push({ name: 'Counterfactual secret output', run: `printf '%s' "${expression}"` });
      expect(() => assertQualityClasses(secret), location).toThrow();
    },
  );

  it('detects planted draft suppression, unwanted triggers, write grants, and publishing', () => {
    const suppression = structuredClone(ci); suppression.jobs.typecheck.if = "github.event.pull_request.draft == false";
    expect(admitted('typecheck', draft, suppression)).toBe(false);
    const trigger = structuredClone(ci);
    (trigger.on.pull_request as { types: string[] }).types.push('edited');
    expect(admitted('typecheck', { ...draft, action: 'edited', draft: false }, trigger)).toBe(true);
    expect(() => expect(trigger.on.pull_request).toEqual({ branches: ['main'], types: actions })).toThrow();
    const write = structuredClone(ci); write.jobs.build.permissions = { contents: 'write' };
    expect(() => assertQualityClasses(write)).toThrow();
    const publish = structuredClone(ci);
    const step = publish.jobs['legacy-runtime'].steps.find(step => step.uses?.startsWith('docker/build-push-action@'))!;
    step.with!.push = true;
    expect(() => assertQualityClasses(publish)).toThrow();
    const paidDraft = structuredClone(paid); paidDraft.jobs.review.if = undefined;
    expect(admitted('review', draft, paidDraft)).toBe(true);
    expect(() => expect(admitted('review', draft, paidDraft)).toBe(false)).toThrow();
    const unguarded = structuredClone(ci); unguarded.jobs['publish-ghcr-arch'].if = 'always()';
    expect(admitted('publish-ghcr-arch', draft, unguarded)).toBe(true);
    expect(() => expect(admitted('publish-ghcr-arch', draft, unguarded)).toBe(false)).toThrow();
  });

  it('refuses unexpected condition syntax or a missing job instead of inventing admission', () => {
    const syntax = structuredClone(ci); syntax.jobs.typecheck.if = 'process.env.UNTRUSTED';
    expect(() => admitted('typecheck', draft, syntax)).toThrow('Unsupported workflow condition syntax');
    expect(() => admitted('missing-job', draft)).toThrow('Missing workflow job');
  });

  it('preserves supersession guards but lets ready_for_review queue without cancelling draft quality CI', () => {
    const cases: Array<{ label: string; event: Event; cancel: boolean }> = [
      { label: 'ready_for_review transition', event: { ...draft, action: 'ready_for_review', draft: false }, cancel: false },
      { label: 'draft opened', event: { ...draft, action: 'opened', draft: true }, cancel: true },
      { label: 'synchronize', event: { ...draft, action: 'synchronize', draft: false }, cancel: true },
      { label: 'ordinary PR reopen', event: { ...draft, action: 'reopened', draft: false }, cancel: true },
      { label: 'main push', event: { name: 'push', ref: 'refs/heads/main' }, cancel: false },
      { label: 'branch push predicate', event: { name: 'push', ref: 'refs/heads/feature' }, cancel: true },
      { label: 'nightly schedule', event: { name: 'schedule', ref: 'refs/heads/main' }, cancel: false },
      { label: 'manual dispatch on main', event: { name: 'workflow_dispatch', ref: 'refs/heads/main' }, cancel: false },
      { label: 'manual dispatch on branch', event: { name: 'workflow_dispatch', ref: 'refs/heads/feature' }, cancel: true },
    ];

    for (const { label, event, cancel } of cases) {
      expect(cancelsInProgress(event), label).toBe(cancel);
    }

    // Counterfactual RED: the previous branch-only expression cancels the ready event.
    const previous = structuredClone(ci);
    previous.concurrency!['cancel-in-progress'] = "${{ github.ref != 'refs/heads/main' }}";
    expect(cancelsInProgress({ ...draft, action: 'ready_for_review', draft: false }, previous)).toBe(true);
    expect(cancelsInProgress({ ...draft, action: 'synchronize', draft: false }, previous)).toBe(true);
    expect(cancelsInProgress({ name: 'push', ref: 'refs/heads/main' }, previous)).toBe(false);
    expect(cancelsInProgress({ name: 'schedule', ref: 'refs/heads/main' }, previous)).toBe(false);
  });
});

describe('actual required-test aggregator on draft quality results', () => {
  const script = ci.jobs.test.steps.find(step => step.name === 'Require every test job to have passed')!.run!;
  const complete = { PLAN: 'success', MODE: 'full', SHARD_COUNT: '4', POSTGRES_TESTS: '["example"]',
    VITEST: 'success', VITEST_POSTGRES: 'success', WORKER_HELPER: 'success', BUILD: 'success' };
  function aggregate(overrides: Record<string, string> = {}) {
    return spawnSync('/bin/bash', ['-c', script], { env: { ...process.env, ...complete, ...overrides }, encoding: 'utf8' });
  }

  it('accepts complete success and skips only an actually empty successful plan', () => {
    expect(aggregate().status).toBe(0);
    expect(aggregate({ SHARD_COUNT: '0', POSTGRES_TESTS: '[]', VITEST: 'skipped', VITEST_POSTGRES: 'skipped' }).status).toBe(0);
  });

  it.each(['PLAN', 'VITEST', 'VITEST_POSTGRES', 'WORKER_HELPER', 'BUILD'])('rejects failed/cancelled/unplanned skipped %s', job => {
    for (const result of ['failure', 'cancelled', 'skipped']) expect(aggregate({ [job]: result }).status).toBe(1);
  });
});
