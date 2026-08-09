#!/usr/bin/env node
import process from 'node:process';
import crypto from 'node:crypto';
import { createMemoryProvider } from '../src/memory/providers/index.js';
import { createHonchoMemoryProvider } from '../src/memory/honchoMemory.js';
import { createHonchoMemoryMcpAdapter } from '../src/mcp/honchoMemoryMcpAdapter.js';

const PROVIDERS = new Set(['honcho', 'mem0', 'hindsight', 'supermemory', 'retaindb']);
const providerId = process.argv[process.argv.indexOf('--provider') + 1] || 'mem0';
const allowMissing = process.argv.includes('--allow-missing');
if (!PROVIDERS.has(providerId)) throw new Error(`unsupported live canary provider: ${providerId}`);

const upper = providerId.toUpperCase();
const env = process.env;
const profile = {
  enabled: true,
  endpointEnv: `${upper}_URL`,
  credentialEnv: `${upper}_API_KEY`,
  namespaceEnv: `${upper}_NAMESPACE`,
  workspaceEnv: `${upper}_WORKSPACE`,
};
const identity = {
  repository: `canary/review-yeti-${providerId}`,
  prNumber: crypto.randomInt(1, 2_000_000_000),
  headSha: crypto.randomBytes(20).toString('hex'),
};
const configured = providerId === 'honcho'
  ? Boolean((env.HONCHO_URL || env.HONCHO_BASE_URL) && (env.HONCHO_API_KEY || env.HONCHO_WORKSPACE_JWT) && (env.HONCHO_WORKSPACE_ID || env.HONCHO_WORKSPACE || env.HONCHO_WORKSPACE_JWT))
  : Boolean(env[profile.endpointEnv] && env[profile.credentialEnv]);
if (!configured) {
  const receipt = { provider: providerId, status: 'not_configured', configured: false, identityDigest: identity.repository };
  console.log(JSON.stringify(receipt));
  if (!allowMissing) process.exitCode = 2;
  process.exit();
}

const provider = providerId === 'honcho'
  ? createHonchoMemoryMcpAdapter({
    honchoProvider: createHonchoMemoryProvider({ env }),
    transport: 'mcp',
    protocol: 'mcp-compatible-local',
    recallDomains: ['decision_feedback', 'session_recap', 'processing'],
    persistDomains: ['processing'],
  })
  : createMemoryProvider({ id: providerId, profile, env });
const startedAt = Date.now();
const health = await provider.healthCheck();
const query = await provider.queryContext({ identity, purpose: 'review-history-v1', maxEntries: 5, maxContextChars: 1000 });
const event = {
  schema_version: 'memory-event-v1', event_id: `canary-${Date.now()}`, domain: 'processing', event_type: 'canary_probe',
  repository: identity.repository, pr_number: String(identity.prNumber), head_sha: identity.headSha,
  occurred_at: new Date().toISOString(), state: 'accepted', source: 'review-yeti-canary',
};
const write = await provider.appendEvents({ identity, events: [event] });
const reread = await provider.queryContext({ identity, purpose: 'review-history-v1', maxEntries: 5, maxContextChars: 1000 });
const readinessChecks = [];
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const readiness = await provider.readiness();
  readinessChecks.push({ attempt, available: Boolean(readiness?.available), reason: readiness?.reason });
  if (readiness?.available) break;
  if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250));
}
const readiness = readinessChecks.at(-1) || { available: false, reason: 'readiness unavailable' };
const representationStatus = reread.status === 'available'
  ? 'representation_ready'
  : (reread.status === 'empty' ? 'empty_first_run' : (write.status === 'accepted' ? 'deriver_pending' : 'unavailable'));
const receipt = {
  provider: providerId,
  status: health.available && write.status === 'accepted' ? 'accepted' : 'unavailable',
  configured: true,
  contractVersion: provider.contractVersion,
  adapterVersion: provider.adapterVersion,
  capabilities: provider.capabilities,
  health: { available: Boolean(health.available), status: health.status },
  query: { status: query.status, source: query.source, stale: query.stale === true },
  write: { status: write.status, accepted: write.accepted || 0, pending: write.pending || 0 },
  reread: { status: reread.status, source: reread.source, exactHead: true },
  representationStatus,
  readiness,
  readinessChecks,
  latencyMs: Date.now() - startedAt,
  identity: { repository: identity.repository, prNumber: identity.prNumber, headSha: identity.headSha },
};
console.log(JSON.stringify(receipt));
if (receipt.status !== 'accepted') process.exitCode = 1;
