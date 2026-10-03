'use strict';

// Grounding memory budget.
//
// Zoekt grounding (materialize the exact-head tarball, then build a Zoekt
// index) runs inside the review worker container. An index build is the
// largest memory consumer in the worker, and an OOM kill is not fail-soft: it
// takes the whole review with it and the check never completes. So grounding
// must prove the container can hold it, or skip itself with an explicit
// reason instead of being enabled blindly by deployment configuration.
//
// Sizing, measured with the shipped worker image against real working trees of
// 50-230 MiB (7-42 MiB compressed), one shard builder, 8 MiB shards:
//   zoekt-index peak RSS ........ ~180-190 MiB with GOMEMLIMIT=192MiB
//   node worker (panel phase) ... ~135-230 MiB
//   tar/gzip + slack ............ ~64 MiB
// The unbounded defaults (2 builders x 100 MiB shards) peaked at 270-790 MiB.
// The floor below is the container limit under which grounding refuses to run.

const MiB = 1024 * 1024;

const GROUNDING_INDEXER_HEAP_LIMIT_BYTES = 192 * MiB;
const GROUNDING_MEMORY_FLOOR_BYTES = 512 * MiB;

// cgroup v1 reports "no limit" as a value near 2^63; anything above 1 TiB is not a real limit.
const UNLIMITED_THRESHOLD_BYTES = 1024 * 1024 * MiB;

function readInteger(fsImpl, file) {
  try {
    const raw = String(fsImpl.readFileSync(file, 'utf8')).trim();
    if (!/^\d+$/u.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
  } catch (_error) {
    return undefined;
  }
}

/**
 * The container memory limit in bytes, or undefined when it cannot be proven
 * (no cgroup, "max", or an unlimited sentinel). Callers must treat undefined as
 * "unknown", never as "large enough" for a decision that matters.
 */
function readCgroupMemoryLimitBytes(fsImpl = require('fs')) {
  const v2 = readInteger(fsImpl, '/sys/fs/cgroup/memory.max');
  if (v2 !== undefined) return v2 < UNLIMITED_THRESHOLD_BYTES ? v2 : undefined;
  const v1 = readInteger(fsImpl, '/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (v1 !== undefined) return v1 < UNLIMITED_THRESHOLD_BYTES ? v1 : undefined;
  return undefined;
}

/** cgroup high-water mark of the whole container (includes reclaimable page cache), when exposed. */
function readCgroupMemoryPeakBytes(fsImpl = require('fs')) {
  return readInteger(fsImpl, '/sys/fs/cgroup/memory.peak');
}

/**
 * Decide whether this container may run grounding.
 * - limit known and below the floor  -> skip (explicit reason, never an OOM)
 * - limit known and at/above floor   -> allow
 * - limit unknown                    -> allow, flagged unverified (local runs, no cgroup)
 */
function groundingMemoryDecision({ limitBytes, floorBytes = GROUNDING_MEMORY_FLOOR_BYTES } = {}) {
  if (limitBytes === undefined) return { allowed: true, verified: false, floorBytes };
  if (limitBytes < floorBytes) {
    return { allowed: false, verified: true, reason: 'memory_limit_below_floor', limitBytes, floorBytes };
  }
  return { allowed: true, verified: true, limitBytes, floorBytes };
}

module.exports = {
  GROUNDING_INDEXER_HEAP_LIMIT_BYTES,
  GROUNDING_MEMORY_FLOOR_BYTES,
  groundingMemoryDecision,
  readCgroupMemoryLimitBytes,
  readCgroupMemoryPeakBytes,
};
