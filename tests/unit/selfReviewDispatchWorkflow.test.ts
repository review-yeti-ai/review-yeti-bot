import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { runInNewContext } from 'node:vm';

type DispatchWorkflow = {
  on: { pull_request_target: { types: string[] } };
  permissions: { contents: string };
  jobs: { dispatch: {
    if?: string;
    steps: Array<{ name: string; uses?: string; with?: Record<string, string>; run?: string }>;
  } };
};

const source = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ct-review-bot.yml'), 'utf8');
const workflow = yaml.load(source) as DispatchWorkflow;

describe('public self-review dispatch readiness boundary', () => {
  it('guards the whole job before App minting or durable central admission', () => {
    expect(workflow.jobs.dispatch.if).toBe("${{ github.event.pull_request.state == 'open' && !github.event.pull_request.draft }}");
    expect(workflow.jobs.dispatch.steps[0].name).toBe('Mint Review Yeti dispatch token');
  });

  it('retains the ready event so a formerly draft head can first admit after promotion', () => {
    expect(workflow.on.pull_request_target.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review']);
  });

  it('keeps the base-owned central route and narrowly scoped App grant', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const mint = workflow.jobs.dispatch.steps[0];
    expect(mint.uses).toMatch(/^actions\/create-github-app-token@[a-f0-9]{40}$/u);
    expect(mint.with?.owner).toBe('calltelemetry');
    expect(mint.with?.repositories).toBe('ct-review-actions');
    expect(mint.with?.['permission-contents']).toBe('write');
    const dispatch = workflow.jobs.dispatch.steps[1].run;
    expect(dispatch).toContain('repos/calltelemetry/ct-review-actions/dispatches');
    expect(dispatch).toContain('github.event.pull_request.base.sha');
    expect(dispatch).toContain('github.event.pull_request.head.sha');
    expect(source).not.toContain('actions/checkout');
  });
});

type DirectReviewWorkflow = {
  on: { pull_request: { types: string[] }; repository_dispatch: { types: string[] } };
  jobs: { review: { if?: string; steps: Array<{ name: string; uses?: string }> } };
};

const directSource = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/review-bot.yaml'), 'utf8');
const directWorkflow = yaml.load(directSource) as DirectReviewWorkflow;

// This workflow's guard uses only JS-compatible boolean operators and literal
// event fields. Evaluate the actual YAML expression, not a mirrored admission
// function; Actions admits a job without an `if` by default. No steps execute.
function directReviewAdmitted(eventName: 'pull_request' | 'repository_dispatch', action: string, draft?: boolean) {
  if (!directWorkflow.on[eventName].types.includes(action)) return false;
  const guard = directWorkflow.jobs.review.if;
  if (guard === undefined) return true;
  expect(guard).toMatch(/^\$\{\{[\s\S]+\}\}$/u);
  const expression = guard.slice(3, -2).trim();
  // Only the tiny guard vocabulary is executable in this test harness.
  expect(expression.replace(/github\.event_name|github\.event\.pull_request\.draft|'pull_request'|[!&|=\s]/gu, '')).toBe('');
  return runInNewContext(`Boolean(${expression})`, {
    github: {
      event_name: eventName,
      event: eventName === 'pull_request' ? { action, pull_request: { draft } } : { action },
    },
  }, { timeout: 100 }) as boolean;
}

describe('legacy direct self-review readiness boundary', () => {
  it('guards the whole review job before checkout and paid panel execution', () => {
    expect(directWorkflow.jobs.review.if).toBe("${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}");
    expect(directWorkflow.jobs.review.steps[0].name).toBe('Checkout Review Runner (this repository)');
    expect(directWorkflow.jobs.review.steps.find((step) => step.name === 'Execute AI Review Panel')?.uses).toBe('./');
  });

  it.each(['opened', 'synchronize', 'reopened'])('skips draft pull_request %s', (action) => {
    expect(directReviewAdmitted('pull_request', action, true)).toBe(false);
  });

  it('admits the first ready_for_review event after promotion', () => {
    expect(directWorkflow.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review']);
    expect(directReviewAdmitted('pull_request', 'ready_for_review', false)).toBe(true);
  });

  it('does not admit a ready event whose PR is still draft', () => {
    expect(directReviewAdmitted('pull_request', 'ready_for_review', true)).toBe(false);
  });

  it.each(['opened', 'synchronize', 'reopened'])('retains non-draft pull_request %s', (action) => {
    expect(directReviewAdmitted('pull_request', action, false)).toBe(true);
  });

  it.each(['review-requested', 're-review-requested', 'dispatch-review'])('retains repository_dispatch %s without a PR draft field', (action) => {
    expect(directReviewAdmitted('repository_dispatch', action)).toBe(true);
  });

  it('preserves the exact repository_dispatch event allowlist', () => {
    expect(directWorkflow.on.repository_dispatch.types).toEqual(['review-requested', 're-review-requested', 'dispatch-review']);
    expect(directReviewAdmitted('repository_dispatch', 'unregistered-review')).toBe(false);
  });
});
