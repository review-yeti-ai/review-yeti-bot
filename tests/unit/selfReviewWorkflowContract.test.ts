import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const callerPath = path.join(root, '.github/workflows/ct-review-bot.yml');
const legacyPath = path.join(root, '.github/workflows/review-bot.yaml');
const centralReviewSha = 'd0f54d0dc80b6501d1652f73461f62983da0fe3b';

type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Record<string, unknown>>;
};

function loadWorkflow(file: string): Workflow {
  // GitHub Actions uses YAML 1.2, where `on` is a string rather than the YAML
  // 1.1 boolean alias. Select that schema explicitly so this contract cannot
  // drift with a parser-default change.
  return yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.CORE_SCHEMA }) as Workflow;
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
      uses: `calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@${centralReviewSha}`,
      secrets: {
        CT_REVIEW_BOT_APP_ID: '${{ secrets.CT_REVIEW_BOT_APP_ID }}',
        CT_REVIEW_BOT_APP_PRIVATE_KEY: '${{ secrets.CT_REVIEW_BOT_APP_PRIVATE_KEY }}',
        OPENROUTER_REVIEW_FLEET_KEY: '${{ secrets.CT_REVIEW_OPENROUTER_API_KEY }}',
      },
    });

    const source = fs.readFileSync(callerPath, 'utf8');
    expect(source).toContain(`v1 provenance: calltelemetry/ct-review-actions@${centralReviewSha}`);
    expect(source).not.toContain('review-yeti.yml@v1');
    expect(source).not.toMatch(/^\s*secrets:\s*inherit\s*$/mu);
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
