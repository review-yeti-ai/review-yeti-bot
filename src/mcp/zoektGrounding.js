'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// REL-677 / ADR 0329: index-at-review-time grounding orchestration.
//
// ZoektIndexBuilder.js indexes an already-checked-out working tree; zoektWorkdirMaterializer.js
// materializes that read-only tree from the review's exact head SHA. This module composes the
// two into the one operation the review pipeline needs: given a repository/head/token, produce
// a throwaway Zoekt index for the whole repo, or a structured, fail-soft reason why it could
// not. No caller should sequence the materializer and builder by hand — the scratch-directory
// lifecycle, failure mapping, and cleanup contract live here so every consumer (the publishing
// worker today, any future caller tomorrow) shares one tested implementation.
//
// Failure contract: the returned stage NEVER throws. Every failure shape resolves to
// `{ indexDir: undefined, scratchDir?, reason }`, and the scratch tree is removed on the
// catch path. Callers treat "no indexDir" as "panel runs exactly as without zoekt".
//
// This module never accepts model input: repository/head/token come from the review's own
// immutable identity, and the injectable materialize/build implementations are
// operator-controlled. The only network surface is the materializer's allowlisted GitHub
// tarball endpoint.

/**
 * Remove a grounding scratch tree. Async on purpose: a materialized checkout
 * plus index shards can be tens of thousands of files, and a synchronous rm
 * would block the caller's event loop for the entire deletion. Fail-soft.
 * This is the ONE deletion contract for grounding scratch trees — callers
 * must not hand-roll their own rm.
 */
async function removeScratchTree(scratchDir, deps = {}) {
  if (!scratchDir) return;
  // An injected fs is authoritative for its own seam resolution: a fake with
  // no .promises must fall through to ITS rmSync, never the real fs.promises.
  const fsImpl = deps.fs;
  if (fsImpl) {
    try {
      if (fsImpl.promises?.rm) await fsImpl.promises.rm(scratchDir, { recursive: true, force: true });
      else fsImpl.rmSync(scratchDir, { recursive: true, force: true });
    } catch { /* fail-soft */ }
    return;
  }
  try { await fs.promises.rm(scratchDir, { recursive: true, force: true }); } catch { /* fail-soft */ }
}

/**
 * Build the grounding stage. All I/O seams are injectable for tests; production passes nothing
 * and gets the real materializer + indexer. Binary paths are caller-resolved: the stage never
 * reads process.env, keeping the seams contract intact.
 */
function createZoektGroundingStage(overrides = {}) {
  const materialize = overrides.materializeReviewWorkdir || require('./zoektWorkdirMaterializer').materializeReviewWorkdir;
  const buildIndex = overrides.buildZoektIndex || require('./zoektIndexBuilder').buildZoektIndex;
  const fsImpl = overrides.fs || fs;
  const osImpl = overrides.os || os;
  const pathImpl = overrides.path || path;
  const indexBinaryPath = overrides.zoektIndexBinaryPath || 'zoekt-index';

  return async function groundingStage(input = {}) {
    if (!input.enabled || !input.token) return { reason: 'disabled_or_unauthenticated' };
    let scratchDir;
    try {
      scratchDir = fsImpl.mkdtempSync(pathImpl.join(osImpl.tmpdir(), 'review-yeti-zoekt-'));
      const workdir = pathImpl.join(scratchDir, 'src');
      const indexDir = pathImpl.join(scratchDir, 'index');
      const materialized = await materialize({
        repository: input.repository,
        headSha: input.headSha,
        token: input.token,
        destDir: workdir,
        signal: input.signal,
      });
      if (!materialized || materialized.status !== 'ok') {
        return { indexDir: undefined, scratchDir, reason: `materialize_${materialized?.status || 'unknown'}` };
      }
      const built = await buildIndex({
        workdir,
        indexDir,
        config: { zoektIndexBinaryPath: input.zoektIndexBinaryPath || indexBinaryPath },
      });
      if (!built || built.status !== 'ok') {
        return { indexDir: undefined, scratchDir, reason: `build_${built?.status || 'unknown'}` };
      }
      return { indexDir, scratchDir };
    } catch (error) {
      // Catch path owns its own cleanup: the caller never received a receipt,
      // so nothing else knows this scratch tree exists. Uses the injected fs
      // seams (a fake fs has no .promises, so the rmSync seam applies).
      await removeScratchTree(scratchDir, { fs: fsImpl, fsPromises: fsImpl.promises });
      return { indexDir: undefined, reason: (error && error.message) || 'zoekt_grounding_error' };
    }
  };
}

const defaultZoektGrounding = createZoektGroundingStage();

module.exports = { createZoektGroundingStage, defaultZoektGrounding, removeScratchTree };
