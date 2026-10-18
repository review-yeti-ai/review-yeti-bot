import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const actionPath = path.join(root, 'action.yml');
const rawAction = fs.readFileSync(actionPath, 'utf8');
const action: any = yaml.load(rawAction);

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
const EDGE_ALIAS_URL = 'https://edge.example.com/api/dispatch/action';

describe('retired DOKS dispatch aliases', () => {
  it('removes the DOKS-specific action inputs and backend description', () => {
    expect(action.inputs).not.toHaveProperty('doks-dispatch-url');
    expect(action.inputs).not.toHaveProperty('doks-publish-mode');
    expect(action.inputs['execution-backend'].description.toLowerCase()).not.toContain('doks');
    expect(rawAction).not.toMatch(/doks-dispatch-url|doks-publish-mode/u);
  });

  it('rejects execution-backend doks while retaining local and edge', () => {
    for (const backend of ['local', 'edge']) {
      const accepted = runValidate({ 'execution-backend': backend });
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).not.toContain('::error::');
    }

    const retired = runValidate({ 'execution-backend': 'doks' });
    expect(retired.status).not.toBe(0);
    expect(retired.stdout).toContain('::error::execution-backend must be local or edge');
  });

  it('keeps only the neutral and edge URL paths in the dispatch environment', () => {
    expect(validateStep.env).not.toHaveProperty('LEGACY_DOKS_DISPATCH_URL');
    expect(validateStep.env).not.toHaveProperty('LEGACY_DOKS_PUBLISH_MODE');
    expect(dispatchStep.env.DISPATCH_URL).toBe('${{ inputs.dispatch-url || inputs.edge-dispatch-url }}');
    expect(dispatchStep.env.DISPATCH_PUBLISH_MODE).toBe("${{ inputs.publish-mode || 'app-gate' }}");

    const edgeAlias = stepEnvironment(dispatchStep, { 'edge-dispatch-url': EDGE_ALIAS_URL });
    expect(edgeAlias.DISPATCH_URL).toBe(EDGE_ALIAS_URL);

    const explicit = stepEnvironment(dispatchStep, {
      'dispatch-url': NEUTRAL_URL,
      'edge-dispatch-url': EDGE_ALIAS_URL,
      'publish-mode': 'disabled',
    });
    expect(explicit.DISPATCH_URL).toBe(NEUTRAL_URL);
    expect(explicit.DISPATCH_PUBLISH_MODE).toBe('disabled');
    expect(stepEnvironment(dispatchStep, {}).DISPATCH_PUBLISH_MODE).toBe('app-gate');
  });
});
