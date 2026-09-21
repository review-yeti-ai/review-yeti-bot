#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const workflowPath = path.join(process.cwd(), '.github/workflows/ct-review-bot.yml');

function readWorkflow() {
  return fs.readFileSync(workflowPath, 'utf8');
}

function compactWorkflowScript(script) {
  return script.replace(/\\\r?\n/gu, ' ').replace(/\s+/gu, ' ').trim();
}

test('public Review Yeti caller matches the central dispatch contract', () => {
  const workflow = readWorkflow();
  const withoutComments = workflow
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+#.*$/u, ''))
    .join('\n');

  const topLevelKeys = [...withoutComments.matchAll(/^([A-Za-z0-9_-]+):(?:\s|$)/gmu)].map(
    ([, key]) => key,
  );
  assert.deepEqual(topLevelKeys, ['name', 'on', 'permissions', 'jobs']);
  assert.match(withoutComments, /^\s{2}pull_request_target:\s*$/mu);
  assert.match(withoutComments, /^permissions:\n  contents: read\n/mu);
  assert.doesNotMatch(withoutComments, /^ {4,}permissions:\s*$/mu);

  const secretRefs = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/gu)].map(
    ([, secret]) => secret,
  );
  assert.deepEqual([...new Set(secretRefs)].sort(), [
    'REVIEW_YETI_DISPATCH_APP_ID',
    'REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY',
  ]);

  for (const forbidden of [
    /actions\/checkout/u,
    /github\.token/u,
    /GITHUB_TOKEN/u,
    /PERSONAL_ACCESS_TOKEN/u,
    /NPM_TOKEN/u,
    /\bPAT\b/u,
    /CT_REVIEW_BOT_APP_ID/u,
    /CT_REVIEW_BOT_APP_PRIVATE_KEY/u,
    /secrets: inherit/u,
  ]) {
    assert.doesNotMatch(workflow, forbidden);
  }

  assert.equal((workflow.match(/^ {6}- name:/gmu) || []).length, 2);
  assert.deepEqual(
    [...workflow.matchAll(/^\s+uses:\s*([^\s]+)\s*$/gmu)].map(([, reference]) => reference),
    ['actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349'],
  );
  for (const marker of [
    'id: dispatch_token',
    'app-id: ${{ secrets.REVIEW_YETI_DISPATCH_APP_ID }}',
    'private-key: ${{ secrets.REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY }}',
    'owner: calltelemetry',
    'repositories: ct-review-actions',
    'permission-contents: write',
  ]) {
    assert.match(workflow, new RegExp(`^\\s+${marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*$`, 'mu'));
  }

  const dispatchStep = workflow.match(/^\s+run:\s*\|\s*\n([\s\S]*)$/mu)?.[1] || '';
  assert.match(workflow, /^\s+GH_TOKEN:\s*\$\{\{\s*steps\.dispatch_token\.outputs\.token\s*\}\}\s*$/mu);
  assert.equal(
    compactWorkflowScript(dispatchStep),
    [
      'set -euo pipefail',
      'jq -n',
      '--arg repository "${{ github.repository }}"',
      '--argjson pr_number "${{ github.event.pull_request.number }}"',
      '--arg base_sha "${{ github.event.pull_request.base.sha }}"',
      '--arg head_sha "${{ github.event.pull_request.head.sha }}"',
      '--arg request_id "${{ github.event.repository.name }}:${{ github.event.pull_request.number }}:${{ github.event.pull_request.head.sha }}:${{ github.run_id }}:${{ github.run_attempt }}"',
      "'{event_type:\"review-yeti-request\",client_payload:{repository:$repository,pr_number:$pr_number,base_sha:$base_sha,head_sha:$head_sha,request_id:$request_id}}'",
      '| gh api --method POST repos/calltelemetry/ct-review-actions/dispatches --input -',
    ].join(' '),
  );
});
