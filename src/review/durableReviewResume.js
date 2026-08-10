'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'durable-review-resume-v1';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeIdentity(identity) {
  const normalized = {
    repository: String(identity?.repository || '').trim().toLowerCase(),
    prNumber: String(identity?.prNumber || '').trim().replace(/^0+(?=\d)/u, ''),
    headSha: String(identity?.headSha || '').trim().toLowerCase(),
    baseSha: String(identity?.baseSha || '').trim().toLowerCase(),
    policyDigest: String(identity?.policyDigest || '').trim().toLowerCase(),
  };
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(normalized.repository) || normalized.repository.includes('..')) throw new Error('invalid resume repository identity');
  if (!/^\d+$/u.test(normalized.prNumber) || normalized.prNumber === '0') throw new Error('invalid resume pull request identity');
  if (!/^[a-f0-9]{40,64}$/u.test(normalized.headSha) || !/^[a-f0-9]{40,64}$/u.test(normalized.baseSha)) throw new Error('invalid resume commit identity');
  if (!normalized.policyDigest || normalized.policyDigest.length > 256) throw new Error('invalid resume policy digest');
  return normalized;
}

function identityDigest(identity) {
  return sha256(normalizeIdentity(identity));
}

function artifactNameForReviewAttempt(identity, attempt) {
  const normalizedAttempt = Number(attempt);
  if (!Number.isSafeInteger(normalizedAttempt) || normalizedAttempt < 1) throw new Error('invalid review attempt');
  return `review-yeti-resume-${sha256({ schemaVersion: SCHEMA_VERSION, identityDigest: identityDigest(identity), attempt: normalizedAttempt }).slice(0, 32)}`;
}

function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (_) { /* rename owns normal cleanup */ }
  }
}

function waitForLock(milliseconds) {
  // A short synchronous wait is intentional: callers mutate one small JSON artifact and must not
  // observe the same generation concurrently from separate Action processes.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withExclusiveArtifactLock(filePath, operation, { timeoutMs = 2000, staleMs = 30000 } = {}) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  let descriptor;
  while (descriptor === undefined) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error('resume artifact is locked by another writer');
      waitForLock(10);
    }
  }
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try { fs.unlinkSync(lockPath); } catch (_) { /* stale-lock recovery owns a rare cleanup race */ }
  }
}

function createChunks(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) throw new Error('resume publication chunks are required');
  return chunks.map((chunk, index) => {
    if (!chunk || typeof chunk !== 'object') throw new Error('invalid resume publication chunk');
    const payload = clone(chunk);
    delete payload.id;
    const kind = String(payload.kind || 'publication').trim().slice(0, 64) || 'publication';
    payload.kind = kind;
    return {
      id: `chunk-${String(index + 1).padStart(4, '0')}-${sha256({ index, payload }).slice(0, 16)}`,
      kind,
      payload,
    };
  });
}

function verifyManifest(payload, expectedIdentity) {
  if (!payload || payload.schemaVersion !== SCHEMA_VERSION || !payload.manifest || typeof payload.manifest !== 'object') {
    throw new Error('unsupported durable review resume schema');
  }
  const manifest = payload.manifest;
  const computedIdentityDigest = identityDigest(manifest.identity);
  if (payload.identityDigest !== computedIdentityDigest || manifest.identityDigest !== computedIdentityDigest) {
    throw new Error('resume identity digest mismatch');
  }
  if (expectedIdentity && identityDigest(expectedIdentity) !== computedIdentityDigest) throw new Error('resume identity digest mismatch');
  if (manifest.schemaVersion !== SCHEMA_VERSION || !manifest.artifactName || !Array.isArray(manifest.chunks)) throw new Error('invalid resume manifest');
  if (manifest.artifactName !== artifactNameForReviewAttempt(manifest.identity, manifest.attempt)) throw new Error('invalid resume artifact name');
  const digestManifest = { ...manifest };
  delete digestManifest.manifestDigest;
  if (payload.manifestDigest !== sha256(digestManifest) || manifest.manifestDigest !== payload.manifestDigest) throw new Error('resume manifest digest mismatch');
  if (!payload.delivery || !Array.isArray(payload.delivery.chunks)) throw new Error('invalid resume delivery state');
  const manifestIds = manifest.chunks.map((chunk) => chunk.id);
  const deliveryIds = payload.delivery.chunks.map((chunk) => chunk?.id);
  if (new Set(manifestIds).size !== manifestIds.length
    || new Set(deliveryIds).size !== deliveryIds.length
    || manifestIds.length !== deliveryIds.length
    || manifestIds.some((id) => !deliveryIds.includes(id))) {
    throw new Error('invalid resume delivery chunks');
  }
  if (!Number.isSafeInteger(Number(payload.generation)) || Number(payload.generation) < 0) throw new Error('invalid resume generation');
  if (payload.lease && (!Number.isSafeInteger(Number(payload.lease.generation)) || payload.lease.generation !== payload.generation)) {
    throw new Error('invalid resume lease generation');
  }
  return payload;
}

function createDurableReviewResumeStore({ baseDir = path.join(process.cwd(), 'sessions'), now = () => new Date() } = {}) {
  function read(filePath, expectedIdentity) {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return verifyManifest(payload, expectedIdentity);
  }

  function write(filePath, payload) {
    verifyManifest(payload);
    atomicWrite(filePath, payload);
    return payload;
  }

  return {
    create({ identity, attempt = 1, planDigest, chunks }) {
      const normalizedIdentity = normalizeIdentity(identity);
      const normalizedAttempt = Number(attempt);
      if (!Number.isSafeInteger(normalizedAttempt) || normalizedAttempt < 1) throw new Error('invalid review attempt');
      const normalizedPlanDigest = String(planDigest || '').trim();
      if (!normalizedPlanDigest || normalizedPlanDigest.length > 256) throw new Error('invalid resume plan digest');
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        artifactName: artifactNameForReviewAttempt(normalizedIdentity, normalizedAttempt),
        identity: normalizedIdentity,
        identityDigest: identityDigest(normalizedIdentity),
        attempt: normalizedAttempt,
        planDigest: normalizedPlanDigest,
        chunks: createChunks(chunks),
      };
      // The digest intentionally excludes itself; this is the immutable Action artifact boundary.
      const digestManifest = { ...manifest };
      delete digestManifest.manifestDigest;
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        identityDigest: manifest.identityDigest,
        manifestDigest: sha256(digestManifest),
        manifest,
        delivery: {
          state: 'pending',
          chunks: manifest.chunks.map((chunk) => ({ id: chunk.id, status: 'pending', attempts: 0 })),
        },
        fence: 0,
        generation: 0,
        lease: null,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      };
      manifest.manifestDigest = payload.manifestDigest;
      const filePath = path.join(baseDir, `${manifest.artifactName}.json`);
      return withExclusiveArtifactLock(filePath, () => {
        if (fs.existsSync(filePath)) throw new Error('resume artifact already exists');
        write(filePath, payload);
        return { filePath, manifest: clone(manifest) };
      });
    },

    read,

    acquireLease(filePath, { owner, ttlMs = 300000 } = {}) {
      const normalizedOwner = String(owner || '').trim().slice(0, 128);
      if (!normalizedOwner) throw new Error('resume lease owner is required');
      return withExclusiveArtifactLock(filePath, () => {
        const current = read(filePath);
        const currentTime = now().getTime();
        const currentLease = current.lease;
        if (currentLease?.owner && currentLease.owner !== normalizedOwner && new Date(currentLease.expiresAt).getTime() > currentTime) {
          throw new Error(`resume lease is held by ${currentLease.owner}`);
        }
        const fence = Number(current.fence || 0) + 1;
        const generation = Number(current.generation || 0) + 1;
        const lease = {
          owner: normalizedOwner,
          fence,
          generation,
          acquiredAt: new Date(currentTime).toISOString(),
          expiresAt: new Date(currentTime + Math.max(1000, Number(ttlMs) || 300000)).toISOString(),
        };
        current.fence = fence;
        current.generation = generation;
        current.lease = lease;
        current.updatedAt = now().toISOString();
        write(filePath, current);
        return clone(lease);
      });
    },

    update(filePath, lease, updater) {
      if (!lease?.owner || !Number.isSafeInteger(Number(lease.fence)) || !Number.isSafeInteger(Number(lease.generation))) throw new Error('resume lease token is required');
      if (typeof updater !== 'function') throw new Error('resume updater is required');
      return withExclusiveArtifactLock(filePath, () => {
        const current = read(filePath);
        const currentLease = current.lease;
        if (!currentLease || currentLease.owner !== lease.owner || currentLease.fence !== lease.fence
          || currentLease.generation !== lease.generation || current.generation !== lease.generation
          || new Date(currentLease.expiresAt).getTime() <= now().getTime()) {
          throw new Error('resume lease lost');
        }
        const next = updater(clone(current));
        if (!next || typeof next !== 'object') throw new Error('resume updater must return an object');
        // The manifest is immutable. Delivery and lease are the only replay-owned state.
        if (next.manifestDigest !== current.manifestDigest || canonicalJson(next.manifest) !== canonicalJson(current.manifest)) {
          throw new Error('resume manifest is immutable');
        }
        const generation = current.generation + 1;
        next.generation = generation;
        if (next.lease) next.lease = { ...currentLease, ...next.lease, generation };
        next.updatedAt = now().toISOString();
        write(filePath, next);
        return next;
      });
    },
  };
}

function isRetryable(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /temporary|timeout|timed?\s*out|rate|429|5\d\d|network|unavailable|econn/i.test(message);
}

function countDelivery(payload, status) {
  return payload.delivery.chunks.filter((chunk) => chunk.status === status).length;
}

async function replayDurableReviewPublication({
  store,
  filePath,
  expectedIdentity,
  owner,
  authorizeReplay,
  ledger,
  publishChunk,
  signal,
  batchSize = 10,
  maxAttempts = 3,
  leaseTtlMs = 300000,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.acquireLease !== 'function' || typeof store.update !== 'function') throw new Error('replay requires a durable resume store');
  if (!filePath || !expectedIdentity || !owner) throw new Error('replay requires filePath, expectedIdentity, and owner');
  if (!ledger || typeof ledger.getPublishedChunkIds !== 'function') throw new Error('replay requires a GitHub publication ledger');
  if (typeof publishChunk !== 'function') throw new Error('replay requires a publishChunk function');

  // Verify the artifact and exact PR identity before authorizing any network replay.
  let payload = store.read(filePath, expectedIdentity);
  const allowed = typeof authorizeReplay === 'function' ? await authorizeReplay({ identity: payload.manifest.identity, manifestDigest: payload.manifestDigest }) : authorizeReplay;
  if (allowed !== true) throw new Error('replay is not authorized');
  if (signal?.aborted) return { status: 'cancelled', filePath, published: 0, skipped: 0, deadLettered: 0 };

  let lease = store.acquireLease(filePath, { owner, ttlMs: leaseTtlMs });
  let published = 0;
  let skipped = 0;
  let deadLettered = 0;
  const boundedBatchSize = Math.max(1, Math.min(100, Number(batchSize) || 10));
  const boundedMaxAttempts = Math.max(1, Math.min(10, Number(maxAttempts) || 3));

  const persist = (mutate) => {
    payload = store.update(filePath, lease, mutate);
    if (payload.lease) lease = clone(payload.lease);
    return payload;
  };
  const release = (state) => {
    persist((current) => ({
      ...current,
      lease: null,
      delivery: { ...current.delivery, state: state || current.delivery.state },
    }));
  };
  const cancelled = () => ({ status: 'cancelled', filePath, published, skipped, deadLettered });
  const releaseAfterCancellation = () => {
    // Cancellation is the authoritative outcome. Lease cleanup is best effort so a lost lease
    // cannot turn a requested stop into an unrelated persistence failure.
    try { release('pending'); } catch (_) { /* a later fenced worker can recover after TTL */ }
    return cancelled();
  };

  const reconcileLedger = async () => {
    if (signal?.aborted) return false;
    const ledgerIds = await ledger.getPublishedChunkIds({
      identity: payload.manifest.identity,
      identityDigest: payload.identityDigest,
      manifestDigest: payload.manifestDigest,
      signal,
    });
    if (signal?.aborted) return false;
    if (!Array.isArray(ledgerIds) && !(ledgerIds instanceof Set)) throw new Error('GitHub publication ledger returned invalid chunk IDs');
    const knownPublished = new Set(ledgerIds);
    let changed = false;
    const reconciled = payload.delivery.chunks.map((chunk) => {
      if (knownPublished.has(chunk.id)) {
        if (chunk.status !== 'published') skipped += 1;
        const next = { ...chunk, status: 'published', source: 'github_ledger', publicationId: undefined };
        if (canonicalJson(next) !== canonicalJson(chunk)) changed = true;
        return next;
      }
      // A local "published" record is only a delivery hint. A fresh authenticated ledger read
      // is required before terminal acceptance, including after a worker was interrupted.
      if (chunk.status === 'published') {
        changed = true;
        return { ...chunk, status: 'pending', source: undefined, publicationId: undefined };
      }
      return chunk;
    });
    if (changed) {
      persist((current) => ({
        ...current,
        delivery: { ...current.delivery, chunks: reconciled },
      }));
    }
    return true;
  };

  try {
    while (true) {
      if (signal?.aborted) {
        release('pending');
        return cancelled();
      }
      payload = store.read(filePath, expectedIdentity);
      // Read all manifest chunks, not just local pending work. GitHub remains the source of truth
      // when a previous process was cancelled between its external write and local persistence.
      if (!await reconcileLedger()) {
        release('pending');
        return cancelled();
      }
      payload = store.read(filePath, expectedIdentity);
      const pending = payload.delivery.chunks.filter((chunk) => chunk.status === 'pending').slice(0, boundedBatchSize);
      if (!pending.length) break;

      for (const deliveryChunk of pending) {
        if (signal?.aborted) {
          release('pending');
          return cancelled();
        }
        const manifestChunk = payload.manifest.chunks.find((chunk) => chunk.id === deliveryChunk.id);
        if (!manifestChunk) throw new Error('resume manifest/delivery chunk mismatch');

        let completed = false;
        for (let attempt = 1; attempt <= boundedMaxAttempts; attempt += 1) {
          if (signal?.aborted) {
            release('pending');
            return cancelled();
          }
          persist((current) => ({
            ...current,
            delivery: {
              ...current.delivery,
              chunks: current.delivery.chunks.map((chunk) => chunk.id === manifestChunk.id
                ? { ...chunk, attempts: Number(chunk.attempts || 0) + 1 }
                : chunk),
            },
          }));
          try {
            const result = await publishChunk({
              chunk: clone(manifestChunk),
              identity: clone(payload.manifest.identity),
              attempt: payload.manifest.attempt,
              fence: lease.fence,
              signal,
            });
            persist((current) => ({
              ...current,
              delivery: {
                ...current.delivery,
                chunks: current.delivery.chunks.map((chunk) => chunk.id === manifestChunk.id
                  ? { ...chunk, status: 'published', source: 'publisher', publicationId: String(result?.publicationId || '').slice(0, 128) || undefined }
                  : chunk),
              },
            }));
            published += 1;
            completed = true;
            break;
          } catch (error) {
            if (signal?.aborted) return releaseAfterCancellation();
            if (attempt < boundedMaxAttempts && isRetryable(error)) {
              await sleep(Math.min(4000, 250 * (2 ** (attempt - 1))));
              // Do not issue a second GitHub write after cancellation arrives during backoff.
              // Clear the fenced lease so a separately authorized worker may resume immediately.
              if (signal?.aborted) return releaseAfterCancellation();
              continue;
            }
            persist((current) => ({
              ...current,
              delivery: {
                ...current.delivery,
                chunks: current.delivery.chunks.map((chunk) => chunk.id === manifestChunk.id
                  ? { ...chunk, status: 'dead_letter', reasonCode: isRetryable(error) ? 'retry_exhausted' : 'publish_rejected' }
                  : chunk),
              },
            }));
            deadLettered += 1;
            completed = true;
            break;
          }
        }
        if (!completed) throw new Error('resume publication attempt did not complete');
      }
    }
    payload = store.read(filePath, expectedIdentity);
    const status = countDelivery(payload, 'dead_letter') ? 'dead_letter' : 'accepted';
    release(status);
    return { status, filePath, published, skipped, deadLettered };
  } catch (error) {
    // Preserve the durable record for a separately authorized replay. Do not mask a fencing loss.
    try {
      const current = store.read(filePath, expectedIdentity);
      if (current.lease?.owner === lease.owner && current.lease?.fence === lease.fence) release('pending');
    } catch (_) { /* original replay error is authoritative */ }
    throw error;
  }
}

module.exports = {
  SCHEMA_VERSION,
  artifactNameForReviewAttempt,
  createDurableReviewResumeStore,
  replayDurableReviewPublication,
  identityDigest,
  canonicalJson,
};
