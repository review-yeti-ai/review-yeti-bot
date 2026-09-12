import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const callerPath = path.join(root, '.github/workflows/ct-review-bot.yml');
const legacyPath = path.join(root, '.github/workflows/review-bot.yaml');

type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Record<string, unknown>>;
};

function loadWorkflow(file: string): Workflow {
  return yaml.load(fs.readFileSync(file, 'utf8')) as Workflow;
}

describe('self-review workflow migration', () => {
  it('delegates base-owned pull request reviews to the promoted central workflow', () => {
    const workflow = loadWorkflow(callerPath);
    const trigger = workflow.on?.pull_request_target as {
      branches?: string[];
      types?: string[];
    };
    const review = workflow.jobs?.review;

    expect(workflow.name).toBe('Review Yeti');
    expect(trigger).toEqual({
      branches: ['main'],
      types: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
    });
    expect(workflow.permissions).toEqual({
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });
    expect(review).toEqual({
      name: 'Review Yeti',
      if: 'github.event.pull_request.draft == false',
      uses: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@v1',
      secrets: 'inherit',
    });
  });

  it('keeps the legacy direct self-review check during phase one', () => {
    const workflow = loadWorkflow(legacyPath);
    const trigger = workflow.on ?? {};
    const review = workflow.jobs?.review;

    expect(trigger).toHaveProperty('pull_request');
    expect(trigger).toHaveProperty('repository_dispatch');
    expect(review?.name).toBe('Execute AI Review Pipeline');
    expect(review).toHaveProperty('steps');
  });
});
