import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const callerPath = path.join(root, '.github/workflows/ct-review-bot.yml');
const legacyPath = path.join(root, '.github/workflows/review-bot.yaml');
const appTokenActionSha = 'fee1f7d63c2ff003460e3d139729b119787bc349';

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

function runBash(script: string, env: Record<string, string>, prelude: string) {
  return spawnSync('bash', ['-c', `${prelude}\n${script}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function callerSteps(): Array<Record<string, unknown>> {
  return (loadWorkflow(callerPath).jobs?.dispatch?.steps ?? []) as Array<Record<string, unknown>>;
}

describe('self-review workflow migration', () => {
  it('dispatches immutable coordinates to the private central workflow without provider credentials', () => {
    const workflow = loadWorkflow(callerPath);
    const trigger = workflow.on?.pull_request_target as {
      branches?: string[];
      types?: string[];
    };
    const dispatch = workflow.jobs?.dispatch;

    expect(workflow.name).toBe('Review Yeti');
    expect(trigger).toEqual({
      branches: ['main'],
      types: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
    });
    expect(workflow.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(dispatch).toMatchObject({
      name: 'Dispatch Review Yeti',
      if: 'github.event.pull_request.draft == false',
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': 5,
      env: {
        CENTRAL_EVENT_TYPE: 'review-yeti-request',
        TARGET_REPOSITORY: '${{ github.repository }}',
        PR_NUMBER: '${{ github.event.pull_request.number }}',
        EXPECTED_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
        EXPECTED_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
        REQUEST_ID:
          'review-yeti-bot:${{ github.event.pull_request.number }}:${{ github.event.pull_request.head.sha }}:${{ github.run_id }}:${{ github.run_attempt }}',
      },
    });

    const steps = dispatch?.steps as Array<Record<string, unknown>>;
    const validationIndex = steps.findIndex((step) => step.name === 'Validate immutable review coordinates');
    const mintIndex = steps.findIndex((step) => step.name === 'Mint Review Yeti dispatch token');
    const identityIndex = steps.findIndex((step) => step.name === 'Require Review Yeti dispatch identity');
    const dispatchIndex = steps.findIndex((step) => step.name === 'Dispatch central Review Yeti');
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(mintIndex).toBeGreaterThan(validationIndex);
    expect(identityIndex).toBeGreaterThan(mintIndex);
    expect(dispatchIndex).toBeGreaterThan(identityIndex);

    expect(steps[mintIndex]).toEqual({
      name: 'Mint Review Yeti dispatch token',
      id: 'ry_token',
      uses: `actions/create-github-app-token@${appTokenActionSha}`,
      with: {
        'app-id': '${{ secrets.CT_REVIEW_BOT_APP_ID }}',
        'private-key': '${{ secrets.CT_REVIEW_BOT_APP_PRIVATE_KEY }}',
        owner: 'calltelemetry',
        repositories: 'ct-review-actions',
        'permission-contents': 'write',
      },
    });

    expect(steps[identityIndex]).toEqual({
      name: 'Require Review Yeti dispatch identity',
      if: "steps.ry_token.outputs.token == ''",
      run: expect.stringMatching(/exit 1/u),
    });

    const source = fs.readFileSync(callerPath, 'utf8');
    expect(source).toContain('repos/calltelemetry/ct-review-actions/dispatches');
    expect(source).toContain('review-yeti-request');
    expect(source).not.toMatch(/review-yeti\.yml@/u);
    expect(source).not.toMatch(/^\s*secrets:\s*inherit\s*$/mu);
    expect(source).not.toContain('CT_REVIEW_OPENROUTER_API_KEY');
    expect(source).not.toContain('CENTRAL_REPOSITORY');
    expect(source).not.toMatch(/actions\/checkout@/u);
  });

  it('fails closed unless the live pull request still matches every immutable coordinate', () => {
    const validationScript = String(
      callerSteps().find((step) => step.name === 'Validate immutable review coordinates')?.run ?? '',
    );
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const env = {
      GH_TOKEN: 'test-token',
      TARGET_REPOSITORY: 'review-yeti-ai/review-yeti-bot',
      PR_NUMBER: '762',
      EXPECTED_BASE_SHA: baseSha,
      EXPECTED_HEAD_SHA: headSha,
      REQUEST_ID: `review-yeti-bot:762:${headSha}:12345:1`,
    };
    const fakeGh = 'gh() { printf \'%s\\n\' "$LIVE_COORDINATES"; }\nexport -f gh';

    const current = runBash(validationScript, {
      ...env,
      LIVE_COORDINATES: `open\t${baseSha}\t${headSha}`,
    }, fakeGh);
    expect(current.status, current.stderr).toBe(0);

    for (const staleCoordinates of [
      `closed\t${baseSha}\t${headSha}`,
      `open\t${'c'.repeat(40)}\t${headSha}`,
      `open\t${baseSha}\t${'d'.repeat(40)}`,
    ]) {
      const stale = runBash(validationScript, { ...env, LIVE_COORDINATES: staleCoordinates }, fakeGh);
      expect(stale.status).not.toBe(0);
      expect(stale.stdout).toContain('Pull request coordinates changed before central dispatch');
    }

    const wrongRepository = runBash(validationScript, {
      ...env,
      TARGET_REPOSITORY: 'attacker/repository',
      LIVE_COORDINATES: `open\t${baseSha}\t${headSha}`,
    }, fakeGh);
    expect(wrongRepository.status).not.toBe(0);
    expect(wrongRepository.stdout).toContain('Unexpected target repository');

    for (const invalid of [
      {
        env: { ...env, PR_NUMBER: '0' },
        diagnostic: 'Invalid pull request number',
      },
      {
        env: { ...env, EXPECTED_BASE_SHA: 'deadbeef' },
        diagnostic: 'Base and head coordinates must be full lowercase Git SHAs',
      },
      {
        env: { ...env, REQUEST_ID: 'review-yeti-bot:762:unbound:12345:1' },
        diagnostic: 'Generated request id is outside the central contract',
      },
    ]) {
      const rejected = runBash(validationScript, {
        ...invalid.env,
        LIVE_COORDINATES: `open\t${baseSha}\t${headSha}`,
      }, fakeGh);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toContain(invalid.diagnostic);
    }
  });

  it('submits the exact coordinate-only central dispatch envelope', () => {
    const dispatchStep = callerSteps().find((step) => step.name === 'Dispatch central Review Yeti');
    expect(dispatchStep?.env).toEqual({ GH_TOKEN: '${{ steps.ry_token.outputs.token }}' });
    const dispatchScript = String(dispatchStep?.run ?? '');
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const requestId = `review-yeti-bot:762:${headSha}:12345:1`;
    const fakeGh = [
      'gh() {',
      '  printf \'__ARGS__%s\\n\' "$*" >&2',
      '  printf \'__BODY__\' >&2',
      '  cat >&2',
      '  printf \'\\n\' >&2',
      '}',
      'export -f gh',
    ].join('\n');
    const result = runBash(dispatchScript, {
      GH_TOKEN: 'test-token',
      CENTRAL_EVENT_TYPE: 'review-yeti-request',
      TARGET_REPOSITORY: 'review-yeti-ai/review-yeti-bot',
      PR_NUMBER: '762',
      EXPECTED_BASE_SHA: baseSha,
      EXPECTED_HEAD_SHA: headSha,
      REQUEST_ID: requestId,
    }, fakeGh);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      '__ARGS__api --method POST repos/calltelemetry/ct-review-actions/dispatches --input - --silent',
    );
    const body = result.stderr.match(/^__BODY__(\{.*\})$/mu)?.[1];
    expect(JSON.parse(body ?? '{}')).toEqual({
      event_type: 'review-yeti-request',
      client_payload: {
        request_id: requestId,
        repository: 'review-yeti-ai/review-yeti-bot',
        pr_number: 762,
        base_sha: baseSha,
        head_sha: headSha,
      },
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
