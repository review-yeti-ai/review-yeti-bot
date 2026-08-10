#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { evaluateOfflinePromotionMatrix } from './evaluate-review-intelligence.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const fixturePath = path.resolve(process.cwd(), argument('--fixture', 'tests/fixtures/review-intelligence/offline-promotion-matrix.json'));
const offline = await evaluateOfflinePromotionMatrix(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
const actionRuntime = JSON.parse(execFileSync(process.execPath, ['scripts/check-action-runtime.mjs'], { cwd: process.cwd(), encoding: 'utf8' }));
const liveSmoke = { status: 'not_run', reason: 'optional live smoke requires explicit separate invocation' };
const receipt = { status: offline.status === 'pass' && actionRuntime.pipelineExports && !actionRuntime.loadedTypescript ? 'pass' : 'fail', offline, actionRuntime, liveSmoke };
console.log(JSON.stringify(receipt));
if (receipt.status !== 'pass') process.exitCode = 1;
