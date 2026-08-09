'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function identityDigest(identity) {
  const normalized = {
    repository: String(identity?.repository || '').trim().toLowerCase(),
    prNumber: String(identity?.prNumber || '').trim().replace(/^0+(?=\d)/u, '') || 'unknown',
    headSha: String(identity?.headSha || '').trim().toLowerCase(),
    baseSha: String(identity?.baseSha || '').trim().toLowerCase(),
    policyDigest: String(identity?.policyDigest || '').trim().toLowerCase(),
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized.repository) || normalized.repository.includes('..')) throw new Error('invalid repository identity');
  if (!normalized.headSha) throw new Error('missing head SHA');
  return crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

function outboxPath(baseDir, identity) {
  return path.join(baseDir, `${identityDigest(identity)}.memory-outbox.json`);
}

function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  let lockFd;
  try {
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (lockAgeMs > 15 * 60 * 1000) {
        fs.unlinkSync(lockPath);
        lockFd = fs.openSync(lockPath, 'wx', 0o600);
      } else {
        throw new Error('memory outbox is locked by another writer');
      }
    }
  } catch (error) {
    throw error;
  }
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    if (lockFd !== undefined) fs.closeSync(lockFd);
    try { fs.unlinkSync(lockPath); } catch (_) { /* another cleanup path owns it */ }
  }
}

function createMemoryOutbox({ baseDir = path.join(process.cwd(), 'sessions'), now = () => new Date() } = {}) {
  return {
    create({ identity, providerId = 'honcho', events = [], state = 'intent', persistDomains = [] }) {
      const digest = identityDigest(identity);
      const filePath = outboxPath(baseDir, identity);
      const payload = {
        schemaVersion: 'memory-outbox-v1',
        identity: { ...identity, prNumber: String(identity.prNumber) },
        identityDigest: digest,
        providerId: String(providerId || 'honcho'),
        state,
        persistDomains: Array.isArray(persistDomains) ? [...new Set(persistDomains.map((domain) => String(domain).trim()).filter(Boolean))] : [],
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        events,
        delivery: { accepted: [], pending: events.map((event) => event.eventId || event.event_id).filter(Boolean), rejected: [], attempts: 0 },
      };
      atomicWrite(filePath, payload);
      return { filePath, payload };
    },
    update(filePath, patch) {
      const current = this.read(filePath);
      const next = { ...current, ...patch, updatedAt: now().toISOString() };
      atomicWrite(filePath, next);
      return next;
    },
    acquireLease(filePath, { owner, ttlMs = 300000 } = {}) {
      if (!owner) throw new Error('lease owner is required');
      const current = this.read(filePath);
      const nowDate = now();
      const existing = current.lease;
      if (existing?.owner && existing.owner !== owner && existing.expiresAt && new Date(existing.expiresAt).getTime() > nowDate.getTime()) {
        throw new Error(`memory outbox lease is held by ${existing.owner}`);
      }
      const lease = {
        owner: String(owner).slice(0, 128),
        acquiredAt: nowDate.toISOString(),
        expiresAt: new Date(nowDate.getTime() + Math.max(1000, Number(ttlMs) || 300000)).toISOString(),
      };
      return this.update(filePath, { state: 'replaying', lease });
    },
    read(filePath) {
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (payload.schemaVersion !== 'memory-outbox-v1') throw new Error('unsupported memory outbox schema');
      const expected = identityDigest(payload.identity);
      if (expected !== payload.identityDigest) throw new Error('memory outbox identity digest mismatch');
      return payload;
    },
    identityDigest,
    outboxPath: (identity) => outboxPath(baseDir, identity),
  };
}

module.exports = { createMemoryOutbox, identityDigest, outboxPath, canonicalJson, atomicWrite };
