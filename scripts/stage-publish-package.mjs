#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createBuildProvenance,
  verifyBuildProvenance,
  writeBuildProvenance,
} = require('../src/provenance/buildProvenance.js');

const packageRoot = process.cwd();
const generatedPath = path.join(packageRoot, 'src/provenance/generated-build-provenance.json');

function git(...args) {
  return execFileSync('git', args, { cwd: packageRoot, encoding: 'utf8' }).trim();
}

function exactCleanReleaseRevision() {
  let branch;
  try {
    branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  } catch {
    throw new Error('npm packaging requires an attached release branch; detached HEAD is unidentified');
  }
  if (!branch) throw new Error('npm packaging requires an attached release branch');
  const status = git('status', '--porcelain=v1', '--untracked-files=all');
  if (status) throw new Error(`npm packaging requires an exact clean release commit; dirty paths:\n${status}`);
  const revision = git('rev-parse', '--verify', 'HEAD').toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error('npm packaging could not resolve an exact 40-hex source revision');
  return revision;
}

if (process.argv.includes('--clean-current')) {
  fs.rmSync(generatedPath, { force: true });
  process.exit(0);
}

if (!process.argv.includes('--prepare-current')) {
  throw new Error('usage: stage-publish-package.mjs --prepare-current|--clean-current');
}

const revision = exactCleanReleaseRevision();
const provenance = createBuildProvenance({
  packageRoot,
  runtimeSourceRevision: revision,
  requireNested: true,
});
verifyBuildProvenance({ packageRoot, provenance, requireNested: true });
writeBuildProvenance(generatedPath, provenance);
process.stdout.write(`Staged ${provenance.schema} for ${revision} graph ${provenance.runtimeGraphDigest}\n`);
