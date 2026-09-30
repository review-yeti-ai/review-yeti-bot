import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

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
