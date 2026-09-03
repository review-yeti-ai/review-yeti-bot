#!/usr/bin/env ts-node
/**
 * Builds domains/compiled-index.json from the checked-in Layer 1 (domains/ecosystems/*.json) and
 * Layer 2 (domains/classes.json) sources — see src/pipeline/domainIndex.ts for the loader,
 * validator, and deterministic-merge implementation this script drives.
 *
 * Usage:
 *   npx ts-node scripts/build-domain-index.ts            # (re)generate domains/compiled-index.json
 *   npx ts-node scripts/build-domain-index.ts --check     # fail if the checked-in file is stale
 *
 * `--check` is wired into `test:artifacts` (see package.json), which every `npm test*` entry point
 * runs via its `pretest*` hook, so a PR that edits domains/ without regenerating the compiled index
 * fails CI instead of silently drifting.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildCompiledIndex } from '../src/pipeline/domainIndex';

const domainsDir = path.join(__dirname, '..', 'domains');
const compiledPath = path.join(domainsDir, 'compiled-index.json');

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const compiled = buildCompiledIndex(domainsDir);
  const serialized = `${JSON.stringify(compiled, null, 2)}\n`;

  if (checkOnly) {
    if (!fs.existsSync(compiledPath)) {
      console.error('[build-domain-index] domains/compiled-index.json is missing. Run: npx ts-node scripts/build-domain-index.ts');
      process.exit(1);
    }
    const onDisk = fs.readFileSync(compiledPath, 'utf8');
    if (onDisk !== serialized) {
      console.error(
        '[build-domain-index] domains/compiled-index.json is stale relative to domains/ecosystems/*.json and domains/classes.json.',
      );
      console.error('[build-domain-index] Run: npx ts-node scripts/build-domain-index.ts');
      process.exit(1);
    }
    console.log('[build-domain-index] domains/compiled-index.json is up to date.');
    return;
  }

  fs.writeFileSync(compiledPath, serialized);
  console.log(`[build-domain-index] Wrote ${compiledPath} (${compiled.indexDigest}).`);
}

main();
