#!/usr/bin/env node

import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createBuildProvenance,
  verifyBuildProvenance,
  writeBuildProvenance,
} = require('../src/provenance/buildProvenance.js');

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const packageRoot = path.resolve(valueAfter('--package-root') || process.cwd());
const runtimeSourceRevision = valueAfter('--runtime-source-revision') || process.env.REVIEW_YETI_ACTION_SHA;
const output = path.resolve(valueAfter('--output') || path.join(packageRoot, 'src/provenance/generated-build-provenance.json'));
const requireNested = process.argv.includes('--require-nested');

const provenance = createBuildProvenance({ packageRoot, runtimeSourceRevision, requireNested });
verifyBuildProvenance({ packageRoot, provenance, requireNested });
writeBuildProvenance(output, provenance);
process.stdout.write(`${JSON.stringify({
  schema: provenance.schema,
  runtimeSourceRevision: provenance.runtimeSourceRevision,
  runtimeGraphDigest: provenance.runtimeGraphDigest,
  packages: provenance.packages.length,
  output,
})}\n`);
