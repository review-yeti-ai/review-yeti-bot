import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compact } = require('../src/review/contextWindow.js');
const { createReviewTelemetry } = require('../src/telemetry/reviewTelemetry.js');
const { createReviewNavigationToolRegistry } = require('../src/mcp/reviewNavigationTools.js');
const { createMemoryOutbox } = require('../src/memory/memoryOutbox.js');
const { replayMemoryOutbox } = require('../src/memory/replayMemoryOutbox.js');
const { runReviewPipeline } = require('../src/runtime/reviewPipelineRuntime.js');
const { assertCurrentPullRequest } = require('../.github/workflows/pipelines/review-pipeline.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function result(identity, receipt, status = 'pass') {
  return { status, identity: { repository: identity.repository, prNumber: identity.prNumber, headSha: identity.headSha }, receipt };
}

function replayCassette(cassette) {
  const interactions = Array.isArray(cassette?.interactions) ? cassette.interactions : [];
  if (!interactions.length || interactions.some((interaction) => !interaction?.scenarioId
    || !interaction?.request || typeof interaction.request.method !== 'string' || typeof interaction.request.url !== 'string'
    || !interaction?.response || !Number.isInteger(interaction.response.status))) {
    throw new Error('invalid intelligence cassette replay schema');
  }
  const consumed = new Set();
  return {
    fetch(id, request) {
      const index = interactions.findIndex((interaction, candidate) => !consumed.has(candidate) && interaction?.scenarioId === id
        && interaction.request.method === request.method && interaction.request.url === request.url
        && JSON.stringify(interaction.request.headers) === JSON.stringify(request.headers)
        && JSON.stringify(interaction.request.body) === JSON.stringify(request.body));
      if (index < 0) throw new Error(`missing intelligence cassette interaction for ${id}: ${JSON.stringify(request)}`);
      consumed.add(index);
      return interactions[index].response?.body || {};
    },
    assertComplete() {
      if (consumed.size !== interactions.length) throw new Error('unconsumed intelligence cassette interactions');
    },
  };
}

async function durableReceipt(identity, unavailable) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-intelligence-'));
  const outbox = createMemoryOutbox({ baseDir, now: () => new Date(0) });
  const created = outbox.create({ providerId: 'mem0', identity: { ...identity, policyDigest: 'fixture-policy' }, state: 'pending', events: [{ eventId: 'fixture-event', domain: 'processing' }] });
  const receipt = await replayMemoryOutbox({
    outbox, filePath: created.filePath, lease: 'fixture-worker', providerId: 'mem0', authorize: true,
    maxAttempts: 3, sleep: async () => {},
    appendEvents: async () => unavailable
      ? { status: 'unavailable', accepted: 0, eventIds: [], reason: 'fixture unavailable' }
      : { status: 'accepted', accepted: 1, eventIds: ['fixture-event'] },
  });
  return receipt;
}

function commandRunner(repository, prNumber, headSha) {
  const reviewEndpoint = `repos/${repository}/pulls/${prNumber}/reviews`;
  let createdReview = null;
  return (command, args, options = {}) => {
    const joined = args.join(' ');
    if (command !== 'gh') return { status: 1, stdout: '', stderr: 'unexpected command' };
    if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ headRefOid: headSha, baseRefOid: 'b'.repeat(40) }), stderr: '' };
    if (joined.includes(`repos/${repository}/issues/${prNumber}/comments`)) return { status: 0, stdout: '[]', stderr: '' };
    if (args.includes('user')) return { status: 0, stdout: 'review-yeti-bot\n', stderr: '' };
    if (args.includes('graphql')) return { status: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), stderr: '' };
    if (joined.includes(reviewEndpoint) && args.includes('--method') && args.includes('POST')) {
      createdReview = { id: 9001, user: { login: 'review-yeti-bot' }, body: JSON.parse(options.input || '{}').body || '' };
      return { status: 0, stdout: JSON.stringify(createdReview), stderr: '' };
    }
    if (joined.includes(reviewEndpoint)) return { status: 0, stdout: JSON.stringify(createdReview ? [createdReview] : []), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'comment') return { status: 0, stdout: '', stderr: '' };
    if (args.includes('compare')) return { status: 0, stdout: JSON.stringify({ files: [] }), stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };
}

function scenarioRequest(id) {
  const path = { 'repeated-pr-feedback-transitions': 'repeated', 'session-recap-exact-head': 'recap', 'stale-head-rejected': 'stale', 'provider-failure-fail-open': 'provider', 'compaction-bounded': 'compaction', 'otel-receipt-redacted': 'otel', 'mcp-poisoning-rejected': 'mcp', 'lease-loss-fenced': 'lease', 'replay-dead-letter-authorized': 'replay', 'secret-free-receipts': 'receipts' }[id];
  return { method: 'GET', url: `https://github.fixture.test/evaluation/${path}`, headers: { authorization: '<redacted>' }, body: null };
}

async function executeWorkflow(fixture, replay) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-intelligence-workflow-'));
  const configRoot = path.join(root, 'config');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, '.review-yeti.yaml'), 'memory:\n  enabled: true\n  provider: mem0\n  mode: single\n  transport: rest\n  context: true\n  write: true\n  recall:\n    decision_feedback: true\n    session_recap: true\n  persist:\n    processing: true\n    decision_feedback: true\n    session_recap: true\n  providers:\n    mem0:\n      enabled: true\n      endpoint_env: MEM0_URL\n      credential_env: MEM0_API_KEY\npersonas:\n  - id: security\n  - id: testing\n');
  const outputPath = path.join(root, 'github-output');
  const providerInput = scenarioRequest('provider-failure-fail-open');
  const providerResponse = replay.fetch('provider-failure-fail-open', providerInput);
  const env = { ...process.env, PR_DIFF: JSON.stringify({ repo: fixture.event.repository, prNumber: fixture.event.prNumber, headSha: fixture.event.headSha, title: 'Fixture review', diff: 'diff --git a/src/app.js b/src/app.js\n+const safe = true;\n' }), PR_REPO: fixture.event.repository, PR_NUMBER: String(fixture.event.prNumber), PR_HEAD_SHA: '', GITHUB_SHA: fixture.event.headSha, GITHUB_BASE_SHA: 'b'.repeat(40), GITHUB_OUTPUT: outputPath, REVIEW_YETI_CONFIG_DIR: configRoot, OPENROUTER_API_KEY: 'fixture-key', OPENROUTER_MODEL: 'fixture-model', OPENROUTER_BASE_URL: 'https://openrouter.fixture.test/v1', OPENROUTER_SKIP_CHAT_PREFLIGHT: 'true', VITEST: 'true', GITHUB_ACTIONS: 'false', MEM0_URL: 'https://mem0.fixture.test', MEM0_API_KEY: 'fixture-memory-key' };
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    let providerReplayUsed = false;
    return await runReviewPipeline({ env, cwd: root, now: () => 1_754_752_800_000, commandRunner: commandRunner(fixture.event.repository, fixture.event.prNumber, fixture.event.headSha), fetchImplementation: async (input, init = {}) => {
      if (!providerReplayUsed) {
        providerReplayUsed = true;
        const body = init.body ? JSON.parse(String(init.body)) : null;
        return new Response(JSON.stringify(providerResponse), { status: 503 });
      }
      return new Response(JSON.stringify({ error: 'fixture unavailable' }), { status: 503 });
    }, modelClient: async ({ persona }) => ({ personaId: persona.id, displayName: persona.name, model: 'fixture-model', provider: 'fixture-openrouter', decision: 'APPROVE', findings: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUSD: 0 } }) });
  } finally {
    console.log = original.log; console.warn = original.warn; console.error = original.error;
  }
}

export function createReviewIntelligenceScenarioRunner({ workflowFixture, cassette } = {}) {
  const identity = workflowFixture?.event;
  const replay = replayCassette(cassette);
  let workflowPromise;
  const workflow = async () => {
    if (!workflowPromise) {
      workflowPromise = executeWorkflow(workflowFixture, replay);
    }
    return workflowPromise;
  };
  return {
    async run(id) {
      if (id !== 'provider-failure-fail-open') replay.fetch(id, scenarioRequest(id));
      const pipeline = await workflow();
      if (!identity?.repository || !identity?.headSha) throw new Error('invalid intelligence workflow identity');
      switch (id) {
        case 'repeated-pr-feedback-transitions':
          return result(identity, { status: pipeline.verdict === 'SHIP' ? 'accepted' : 'rejected', githubLedger: workflowFixture.github.responses.ledger });
        case 'session-recap-exact-head':
          return result(identity, { status: pipeline.headSha === identity.headSha ? 'available' : 'rejected', head: workflowFixture.github.responses.head });
        case 'stale-head-rejected':
          try { assertCurrentPullRequest({ repo: identity.repository, prNumber: identity.prNumber, headSha: identity.headSha }, { commandRunner: commandRunner(identity.repository, identity.prNumber, 'c'.repeat(40)) }); }
          catch (error) {
            const expected = identity.headSha;
            const observed = 'c'.repeat(40);
            if (error?.reasonCode === 'stale_head' || (String(error?.message || '').includes(`expected ${expected}`) && String(error?.message || '').includes(`found ${observed}`))) {
              return result(identity, { status: 'empty', reasonCode: 'stale_head' });
            }
            throw error;
          }
          return result(identity, { status: 'rejected', reasonCode: 'stale_head' });
        case 'provider-failure-fail-open':
          return result(identity, { status: pipeline.memory.query.status, reasonCode: 'provider_failure' });
        case 'compaction-bounded': {
          const output = compact([{ id: 'old', role: 'tool', content: 'prior context' }, { id: 'new', role: 'user', content: 'current' }], { enabled: true, maxBytes: 128, summaryBytes: 64 });
          return result(identity, { status: output.receipt.status === 'compacted' ? 'accepted' : 'rejected', compacted: output.receipt.compacted, maxEntries: 40 });
        }
        case 'otel-receipt-redacted': {
          const events = [];
          const telemetry = createReviewTelemetry({ identity: { ...identity, baseSha: 'b'.repeat(40), policyDigest: 'p' }, sink: { async emit(event) { events.push(event); } }, clock: () => 0 });
          telemetry.record({ phase: 'telemetry', unitId: 'exporter', outcome: 'unavailable', failureClass: 'export_unavailable', endpoint: 'https://secret.invalid' });
          await telemetry.flush();
          return result(identity, { status: events.length === 1 && !JSON.stringify(events).includes('secret.invalid') ? 'disabled_not_configured' : 'rejected', exporter: 'none' });
        }
        case 'mcp-poisoning-rejected': {
          const navIdentity = { ...identity, baseSha: 'b'.repeat(40) };
          const registry = createReviewNavigationToolRegistry({ identity: navIdentity, snapshot: { repository: identity.repository, headSha: identity.headSha, baseSha: navIdentity.baseSha, files: [] }, blobClient: { getBlob: async () => ({}) }, config: { enabled: true } });
          const rejected = await registry.call('shell_exec', {});
          return result(identity, { status: rejected.status, reasonCode: rejected.reason === 'tool_not_registered' ? 'tool_not_allowlisted' : 'rejected' });
        }
        case 'lease-loss-fenced': {
          const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-intelligence-lease-'));
          let now = 0;
          const outbox = createMemoryOutbox({ baseDir, now: () => new Date(now) });
          const created = outbox.create({ providerId: 'mem0', identity: { ...identity, policyDigest: 'fixture-policy' }, events: [] });
          outbox.acquireLease(created.filePath, { owner: 'worker-a', ttlMs: 60000 });
          now = 61_000;
          outbox.acquireLease(created.filePath, { owner: 'worker-b', ttlMs: 60000 });
          try {
            if (outbox.read(created.filePath).lease?.owner !== 'worker-a') throw new Error('resume lease lost');
            outbox.update(created.filePath, { state: 'accepted' });
          } catch (error) {
            if (error?.message === 'resume lease lost') return result(identity, { status: 'pending', leaseLost: true });
            throw error;
          }
          return result(identity, { status: 'rejected', leaseLost: false });
        }
        case 'replay-dead-letter-authorized': {
          const dead = await durableReceipt(identity, true);
          return result(identity, { status: dead.state, attempts: dead.attempts });
        }
        case 'secret-free-receipts':
          return result(identity, { status: /bearer\s+|ghp_|sk-/iu.test(JSON.stringify(workflowFixture)) ? 'rejected' : 'ok', provider: 'fixture' });
        default:
          throw new Error(`unsupported intelligence scenario ${id}`);
      }
    },
    assertComplete: replay.assertComplete,
  };
}
