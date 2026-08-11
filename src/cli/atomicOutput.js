'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function cancelled(signal) {
  if (signal?.aborted) throw new Error('cancelled');
}

async function writeAtomicOutput(targetPath, bytes, dependencies = {}) {
  const target = path.resolve(String(targetPath));
  const directory = path.dirname(target);
  const base = path.basename(target);
  const id = dependencies.randomUUID ? dependencies.randomUUID() : crypto.randomUUID();
  const temporary = path.join(directory, `.${base}.${id}.tmp`);
  const fileSystem = dependencies.fs || fs.promises;
  const signal = dependencies.signal;
  let handle;
  try {
    cancelled(signal);
    if (fileSystem.mkdir) await fileSystem.mkdir(directory, { recursive: true });
    handle = await fileSystem.open(temporary, 'wx', 0o600);
    cancelled(signal);
    if (typeof handle.writeFile === 'function') await handle.writeFile(bytes);
    else throw new Error('atomic output filesystem handle lacks writeFile');
    cancelled(signal);
    if (typeof handle.sync === 'function') await handle.sync();
    if (typeof handle.close === 'function') await handle.close();
    handle = undefined;
    cancelled(signal);
    await fileSystem.rename(temporary, target);
  } catch (error) {
    try { if (handle?.close) await handle.close(); } catch (_) {}
    try { if (fileSystem.unlink) await fileSystem.unlink(temporary); } catch (_) {}
    throw error;
  }
}

function exitCodeForReview(result) {
  if (result?.cancelled) return 130;
  if (!result || result.error) return 1;
  const status = String(result.status || result.reviewStatus || result.coverage?.status || '').toUpperCase();
  if (['FIX_FIRST', 'BLOCK', 'BLOCKED'].includes(String(result.verdict || '').toUpperCase())) return 3;
  if (status === 'INCOMPLETE_REVIEW' || status === 'PARTIAL_REVIEW') return 2;
  if (result.coverage?.mergeEligible === false) return 2;
  if (String(result.verdict || '').toUpperCase() === 'SHIP' || status === 'SHIP' || status === 'COMPLETE') return 0;
  return 1;
}

module.exports = { writeAtomicOutput, exitCodeForReview };
