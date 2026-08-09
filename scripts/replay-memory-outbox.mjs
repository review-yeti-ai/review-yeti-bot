#!/usr/bin/env node
import process from 'node:process';
import { createMemoryOutbox } from '../src/memory/memoryOutbox.js';
import { createHonchoMemoryProvider } from '../src/memory/honchoMemory.js';
import { createHonchoMemoryMcpAdapter } from '../src/mcp/honchoMemoryMcpAdapter.js';
import { createMemoryProviderRouter } from '../src/mcp/memoryProviderRouter.js';
import { DopplerSecretManagerRuntime } from '../src/mcp/dopplerSecretManagerRuntime.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const filePath = arg('--path');
const lease = arg('--lease');
const leaseTtlMs = Number(arg('--lease-ttl-ms') || 300000);
const maxAttempts = Math.max(1, Number(arg('--max-attempts') || 3));
const providerId = arg('--provider') || 'honcho';
const authorized = arg('--authorize') === 'yes' || process.env.REVIEW_YETI_REPLAY_AUTH === '1';
if (!filePath || !lease || !authorized) {
  console.error('Usage: replay-memory-outbox.mjs --path <outbox> --lease <owner> --provider <selected-provider> --authorize yes');
  process.exit(2);
}

const outbox = createMemoryOutbox({ baseDir: process.cwd() });
let payload = outbox.read(filePath);
if (!payload.identity?.repository || !payload.identity?.headSha) throw new Error('outbox identity is incomplete');
if (payload.providerId && providerId !== payload.providerId) throw new Error(`replay provider ${providerId} does not match outbox provider ${payload.providerId}`);
if (payload.state === 'dead_letter') throw new Error('memory outbox is dead-lettered; operator intervention is required');
payload = outbox.acquireLease(filePath, { owner: lease, ttlMs: leaseTtlMs });
const secretManager = new DopplerSecretManagerRuntime({
  dopplerToken: process.env.DOPPLER_TOKEN,
  project: process.env.DOPPLER_PROJECT,
  config: process.env.DOPPLER_CONFIG,
});
const honcho = createHonchoMemoryProvider({ secretManager, config: { enabled: true } });
const adapter = createHonchoMemoryMcpAdapter({ honchoProvider: honcho, transport: 'mcp' });
const router = createMemoryProviderRouter({ providers: [adapter], defaultProviderId: payload.providerId || 'honcho', transport: 'mcp', mode: 'single' });
const attemptsBefore = Number(payload.delivery?.attempts || 0);
const deliveryKey = payload.delivery?.deliveryKey || `${payload.identityDigest}:replay`;
let result;
let attempts = attemptsBefore;
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  attempts = attemptsBefore + attempt;
  try {
    result = await router.appendEvents({ providerId: payload.providerId || 'honcho', identity: payload.identity, events: payload.events, persistDomains: payload.persistDomains, deliveryKey });
  } catch (error) {
    result = { status: 'unavailable', reason: error instanceof Error ? error.message : String(error), accepted: 0, eventIds: [] };
  }
  if (result.status === 'accepted') break;
  if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 250 * (2 ** (attempt - 1)))));
}
const accepted = Array.isArray(result.eventIds) ? result.eventIds : [];
const next = outbox.update(filePath, {
  state: result.status === 'accepted' ? 'accepted' : (attempts >= maxAttempts ? 'dead_letter' : 'pending'),
  lease: null,
  delivery: {
    ...payload.delivery,
    accepted,
    pending: result.status === 'accepted' ? [] : (payload.delivery?.pending || []),
    attempts,
    deliveryKey,
    lastResult: result,
    deadLetterReason: result.status === 'accepted' ? undefined : (attempts >= maxAttempts ? result.reason || 'provider unavailable' : undefined),
  },
});
console.log(JSON.stringify({ filePath, state: next.state, provider: result.provider, accepted: result.accepted, pending: next.delivery.pending.length }));
if (result.status !== 'accepted') process.exitCode = 1;
