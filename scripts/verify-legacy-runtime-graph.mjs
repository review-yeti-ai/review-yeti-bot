#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('legacy-runtime');
const modules = path.join(root, 'node_modules');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

function fail(message) {
  process.stderr.write(`legacy-runtime graph failed: ${message}\n`);
  process.exit(1);
}

if (manifest.dependencies?.['@openrouter/sdk'] !== '1.2.80') {
  fail('@openrouter/sdk must be pinned to 1.2.80');
}
if (manifest.dependencies?.['js-yaml'] !== '4.1.1') {
  fail('js-yaml must be pinned to 4.1.1');
}
if (Object.keys(manifest.dependencies || {}).length !== 2) {
  fail('legacy-runtime must declare exactly two dependencies');
}
if (lock.packages?.['node_modules/@openrouter/sdk']?.version !== '1.2.80') {
  fail('lockfile @openrouter/sdk must be 1.2.80');
}

const forbidden = ['next', 'react', 'react-dom', 'vitest', 'jsdom', 'tailwindcss'];
if (fs.existsSync(modules)) {
  for (const name of forbidden) {
    if (fs.existsSync(path.join(modules, name))) fail(`forbidden package present: ${name}`);
  }
  if (!fs.existsSync(path.join(modules, '@openrouter', 'sdk'))) {
    fail('node_modules/@openrouter/sdk is missing; run npm ci --prefix legacy-runtime');
  }
  if (!fs.existsSync(path.join(modules, 'js-yaml'))) {
    fail('node_modules/js-yaml is missing; run npm ci --prefix legacy-runtime');
  }
}

process.stdout.write(`${JSON.stringify({
  version: 'ReviewYetiLegacyRuntime.v1',
  dependencies: manifest.dependencies,
  passed: true,
})}\n`);
