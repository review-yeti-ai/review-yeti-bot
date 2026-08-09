'use strict';

async function replayMemoryOutbox({
  outbox,
  filePath,
  lease,
  leaseTtlMs = 300000,
  maxAttempts = 3,
  providerId,
  appendEvents,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  authorize = false,
} = {}) {
  if (!filePath || !lease || !authorize) throw new Error('replay requires filePath, lease, and authorization');
  if (!outbox || typeof outbox.read !== 'function' || typeof outbox.update !== 'function') throw new Error('replay requires an outbox');
  if (typeof appendEvents !== 'function') throw new Error('replay requires an appendEvents function');
  let payload = outbox.read(filePath);
  if (!payload.identity?.repository || !payload.identity?.headSha) throw new Error('outbox identity is incomplete');
  if (payload.providerId && providerId && providerId !== payload.providerId) throw new Error(`replay provider ${providerId} does not match outbox provider ${payload.providerId}`);
  if (payload.state === 'dead_letter') throw new Error('memory outbox is dead-lettered; operator intervention is required');
  payload = outbox.acquireLease(filePath, { owner: lease, ttlMs: leaseTtlMs });
  const selectedProvider = payload.providerId || providerId || 'honcho';
  const attemptsBefore = Number(payload.delivery?.attempts || 0);
  const deliveryKey = payload.delivery?.deliveryKey || `${payload.identityDigest}:replay`;
  let result = { status: 'unavailable', accepted: 0, eventIds: [], reason: 'provider unavailable' };
  let attempts = attemptsBefore;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    attempts = attemptsBefore + attempt;
    try {
      result = await appendEvents({
        providerId: selectedProvider,
        identity: payload.identity,
        events: payload.events,
        persistDomains: payload.persistDomains,
        deliveryKey,
      });
    } catch (error) {
      result = { status: 'unavailable', reason: error instanceof Error ? error.message : String(error), accepted: 0, eventIds: [] };
    }
    if (result.status === 'accepted') break;
    if (attempt < Math.max(1, maxAttempts)) await sleep(Math.min(1000, 250 * (2 ** (attempt - 1))));
  }
  const accepted = Array.isArray(result.eventIds) ? result.eventIds : [];
  const next = outbox.update(filePath, {
    state: result.status === 'accepted' ? 'accepted' : (attempts >= Math.max(1, maxAttempts) ? 'dead_letter' : 'pending'),
    lease: null,
    delivery: {
      ...payload.delivery,
      accepted,
      pending: result.status === 'accepted' ? [] : (payload.delivery?.pending || []),
      attempts,
      deliveryKey,
      lastResult: result,
      deadLetterReason: result.status === 'accepted' ? undefined : (attempts >= Math.max(1, maxAttempts) ? result.reason || 'provider unavailable' : undefined),
    },
  });
  return { filePath, state: next.state, provider: selectedProvider, accepted: result.accepted || 0, pending: next.delivery.pending.length, attempts, result };
}

module.exports = { replayMemoryOutbox };
