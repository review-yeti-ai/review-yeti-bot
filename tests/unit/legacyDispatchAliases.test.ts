import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * Deprecated dispatch surface kept only while the central caller workflow still passes it:
 * execution-backend `doks`, and the `doks-dispatch-url`, `edge-dispatch-url` and
 * `doks-publish-mode` inputs. Each is an alias of the neutral edge contract.
 * Delete this file together with the aliases in action.yml.
 */
const root = path.resolve(__dirname, '../..');
const action: any = yaml.load(fs.readFileSync(path.join(root, 'action.yml'), 'utf8'));
const modulePath = path.join(root, 'scripts/dispatch-review-action.mjs');

const validateStep = action.runs.steps.find((step: any) => step.name === 'Validate execution backend');
const dispatchStep = action.runs.steps.find((step: any) => step.id === 'dispatch');

/** Evaluates the `${{ a || b || 'literal' }}` expressions this action uses for env values. */
function evaluate(expression: string, inputs: Record<string, string>): string {
  const match = /^\$\{\{\s*(.+?)\s*\}\}$/u.exec(String(expression).trim());
  if (!match) return String(expression);
  for (const term of match[1].split('||').map((part) => part.trim())) {
    const literal = /^'(.*)'$/u.exec(term);
    const value = literal ? literal[1] : inputs[term.replace(/^inputs\./u, '')] ?? '';
    if (value) return value;
  }
  return '';
}

function stepEnvironment(step: any, inputs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, evaluate(String(value), inputs)]));
}

function runValidate(inputs: Record<string, string>) {
  return spawnSync('bash', ['-c', validateStep.run], {
    env: { ...process.env, ...stepEnvironment(validateStep, inputs) },
    encoding: 'utf8',
  });
}

const NEUTRAL_URL = 'https://review.example.com/api/dispatch/action';
const LEGACY_URL = 'https://legacy.example.com/api/dispatch/action';

describe('deprecated dispatch aliases', () => {
  it('marks every legacy input as a deprecated alias with empty defaults', () => {
    for (const name of ['doks-dispatch-url', 'edge-dispatch-url', 'doks-publish-mode']) {
      expect(action.inputs[name].description).toContain('DEPRECATED alias, removed once the central caller workflow no longer passes it');
      expect(action.inputs[name].default).toBe('');
    }
  });

  it('accepts execution-backend doks with a deprecation warning and still rejects mars', () => {
    const doks = runValidate({ 'execution-backend': 'doks' });
    expect(doks.status).toBe(0);
    expect(doks.stdout).toContain("::warning::execution-backend 'doks' is deprecated and is treated as 'edge'");

    for (const backend of ['local', 'edge']) {
      const accepted = runValidate({ 'execution-backend': backend });
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).not.toContain('::warning::');
    }

    const mars = runValidate({ 'execution-backend': 'mars' });
    expect(mars.status).not.toBe(0);
    expect(mars.stdout).toContain('::error::execution-backend must be local or edge');
  });

  it('warns for each deprecated input that is set', () => {
    const result = runValidate({
      'execution-backend': 'edge',
      'doks-dispatch-url': LEGACY_URL,
      'edge-dispatch-url': LEGACY_URL,
      'doks-publish-mode': 'app-gate',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::input doks-dispatch-url is deprecated; use dispatch-url');
    expect(result.stdout).toContain('::warning::input edge-dispatch-url is deprecated; use dispatch-url');
    expect(result.stdout).toContain('::warning::input doks-publish-mode is deprecated; use publish-mode');
  });

  it('treats the legacy inputs as aliases and lets the neutral inputs win', () => {
    const legacyOnly = stepEnvironment(dispatchStep, { 'execution-backend': 'doks', 'doks-dispatch-url': LEGACY_URL, 'doks-publish-mode': 'disabled' });
    expect(legacyOnly.DISPATCH_URL).toBe(LEGACY_URL);
    expect(legacyOnly.DISPATCH_PUBLISH_MODE).toBe('disabled');

    const edgeAlias = stepEnvironment(dispatchStep, { 'edge-dispatch-url': LEGACY_URL });
    expect(edgeAlias.DISPATCH_URL).toBe(LEGACY_URL);

    const both = stepEnvironment(dispatchStep, {
      'dispatch-url': NEUTRAL_URL, 'doks-dispatch-url': LEGACY_URL, 'edge-dispatch-url': LEGACY_URL,
      'publish-mode': 'disabled', 'doks-publish-mode': 'app-gate',
    });
    expect(both.DISPATCH_URL).toBe(NEUTRAL_URL);
    expect(both.DISPATCH_PUBLISH_MODE).toBe('disabled');

    expect(stepEnvironment(dispatchStep, {}).DISPATCH_PUBLISH_MODE).toBe('app-gate');
  });

  it('dispatches a legacy doks caller as edge with the edge OIDC audience', async () => {
    const { dispatchAction } = await import(modulePath);
    const resolved = stepEnvironment(dispatchStep, {
      'execution-backend': 'doks',
      'doks-dispatch-url': LEGACY_URL,
      'doks-publish-mode': 'app-gate',
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 'ActionDispatchAccepted.v1',
        status: 'accepted',
        runId: `run_${'1'.repeat(32)}`,
      }), { status: 202 }));

    const result = await dispatchAction({
      DISPATCH_URL: resolved.DISPATCH_URL,
      DISPATCH_OIDC_AUDIENCE: resolved.DISPATCH_OIDC_AUDIENCE,
      DISPATCH_PUBLISH_MODE: resolved.DISPATCH_PUBLISH_MODE,
      ACTION_SHA: 'a'.repeat(40),
      REPOSITORY_ID: '12345',
      REPOSITORY: 'exampleorg/example-api',
      PR_NUMBER: '42',
      HEAD_SHA: 'b'.repeat(40),
      BASE_SHA: 'c'.repeat(40),
      GITHUB_RUN_ID: '98765',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW_REF: 'exampleorg/example-review-actions/.github/workflows/review.yml@refs/heads/main',
      GITHUB_WORKFLOW_SHA: 'd'.repeat(40),
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/token?x=1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-runtime-token',
    }, fetchMock);

    expect(result.status).toBe('accepted');
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('audience')).toBe('review-yeti-edge-dispatch');
    expect(fetchMock.mock.calls[1][0]).toBe(LEGACY_URL);
  });
});
