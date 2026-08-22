#!/usr/bin/env node
/**
 * Guarantees the compiled pipeline modules the test suite depends on.
 *
 * `.github/workflows/pipelines/review-pipeline.js` is plain CommonJS and is loaded with a bare
 * `require()` from outside Vite's module graph, so its inner requires are resolved by Node, not by
 * Vitest. That means it can never load `src/pipeline/*.ts` under test — it falls through to
 * `dist/pipeline/*`, and when `dist/` is absent it silently leaves the module `null`:
 *
 *     let diffCompactor = null;
 *     try { diffCompactor = require('../../../src/pipeline/diffCompactor'); }   // .ts — never resolves
 *     catch (_) { try { diffCompactor = require('../../src/pipeline/diffCompactor'); }
 *     catch (_) { try { diffCompactor = require('../../../dist/pipeline/diffCompactor'); }
 *     catch (_) {} } }
 *
 * With the compactor loaded, a review prompt carries the compacted patch
 * (`@@ -1,1 +1,3 @@` plus a trailing newline). Without it, the raw patch goes out
 * (`@@ -1,1 +1,2 @@`). The OpenRouter cassette replay tests assert the exact request bytes, so
 * their outcome flips on whether someone happened to run a build in this working tree — an input
 * the suite never produced for itself.
 *
 * `pretest` already guarantees `public/` via ensure-static-assets.js. This does the same job for
 * the other ambient artifact the suite reads.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const sourceDir = path.join(rootDir, 'src', 'pipeline');
const outputDir = path.join(rootDir, 'dist', 'pipeline');
const tsconfig = path.join(rootDir, 'tsconfig.server.json');

/** Every `src/pipeline/*.ts` must have a `dist/pipeline/*.js` that is at least as new. */
function staleSources() {
  if (!fs.existsSync(sourceDir)) return [];
  return fs
    .readdirSync(sourceDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .filter((file) => {
      const compiled = path.join(outputDir, file.replace(/\.ts$/, '.js'));
      if (!fs.existsSync(compiled)) return true;
      return fs.statSync(path.join(sourceDir, file)).mtimeMs > fs.statSync(compiled).mtimeMs;
    });
}

function ensurePipelineBuild() {
  const stale = staleSources();
  if (stale.length === 0) {
    console.log('[EnsurePipelineBuild] dist/pipeline is current.');
    return;
  }

  console.log(`[EnsurePipelineBuild] Compiling ${stale.length} stale pipeline module(s): ${stale.join(', ')}`);
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', tsconfig], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  const remaining = staleSources();
  if (remaining.length > 0) {
    throw new Error(
      `[EnsurePipelineBuild] dist/pipeline is still missing or stale after compiling: ${remaining.join(', ')}`,
    );
  }
  console.log('[EnsurePipelineBuild] dist/pipeline built.');
}

ensurePipelineBuild();
