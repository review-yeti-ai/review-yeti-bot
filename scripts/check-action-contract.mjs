import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');

export function validateActionContract({ action, workflow }) {
  const errors = [];
  const actionSha = action?.inputs?.['action-sha'];
  if (!actionSha?.required || !/40-hex commit SHA/i.test(String(actionSha.description || ''))) {
    errors.push('action-sha must remain a required immutable 40-hex commit SHA input');
  }
  const reviewStep = (action?.runs?.steps || []).find((step) => step?.id === 'review');
  if (reviewStep?.env?.REVIEW_YETI_ACTION_SHA !== '${{ inputs.action-sha }}') {
    errors.push('review runtime must bind REVIEW_YETI_ACTION_SHA to inputs.action-sha');
  }
  const receiptSource = fs.readFileSync(path.join(root, '.github/workflows/pipelines/review-pipeline.js'), 'utf8');
  if (!receiptSource.includes('actionSha: runtimeEnv.REVIEW_YETI_ACTION_SHA')) {
    errors.push('dispatch receipt must bind actionSha from REVIEW_YETI_ACTION_SHA');
  }
  const consumerStep = (workflow?.jobs?.review?.steps || []).find((step) => step?.id === 'action-source');
  if (!String(consumerStep?.run || '').includes('git rev-parse HEAD')) {
    errors.push('the checked-out immutable action source must derive its SHA with git rev-parse HEAD');
  }
  const usesStep = (workflow?.jobs?.review?.steps || []).find((step) => step?.uses === './');
  if (usesStep?.with?.['action-sha'] !== '${{ steps.action-source.outputs.sha }}') {
    errors.push('the in-repository consumer must pass the checked-out action source SHA');
  }
  return { valid: errors.length === 0, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const action = yaml.load(fs.readFileSync(path.join(root, 'action.yml'), 'utf8'));
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/review-bot.yaml'), 'utf8'));
  const result = validateActionContract({ action, workflow });
  assert.deepEqual(result, { valid: true, errors: [] }, result.errors.join('; '));
  console.log('action contract preflight: ok');
}
