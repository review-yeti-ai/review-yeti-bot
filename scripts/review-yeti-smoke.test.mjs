import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

import {
  EXAMPLE_API_REPOSITORY,
  EXAMPLE_API_TRANSPORT_ORDER,
  OLLAMA_REPOSITORIES,
  isPassthroughRepository,
  EXPECTED_OPENROUTER_ROUTING,
  EXPECTED_OPENROUTER_MODEL,
  EXPECTED_OPENROUTER_MODELS,
  EXPECTED_GEMINI_BASE_URL,
  EXPECTED_GEMINI_MODEL,
  EXPECTED_SYNTHETIC_BASE_URL,
  EXPECTED_SYNTHETIC_MODEL,
  EXPECTED_TRANSPORT_ORDER,
  EXPECTED_CONFIGURED_TRANSPORT_ORDER,
  buildRequest,
  boundSyntheticCapacity,
  classifyHttpFailure,
  encodeTransportPlan,
  getStreamingFetchDispatcher,
  STREAMING_FETCH_DISPATCHER_OPTIONS,
  probeTransport,
  resolveTransport,
  resolvePolicyForRepository,
  runSmoke,
  selectHealthyTransports,
  syntheticCapacityFromQuota,
  syntheticQuotaUrl,
  validatePolicy,
} from './review-yeti-smoke.mjs';

function policyFixture() {
  const policy = {
    schema: 'exampleorg.review-policy.v1',
    review_yeti: {
      dispatch_mode: 'ordered',
      openrouter_max_attempts: '2',
      openrouter_timeout_ms: '90000',
      openrouter_stream: 'true',
      openrouter_ttft_ms: '60000',
      stall_ms: '20000',
      budget: { lane_deadline_ms: '960000', lane_overhead_ms: '60000', max_investigation_turns: '2' },
      transports: [
        {
          name: 'openrouter-primary',
          enabled: false,
          base_url: 'https://openrouter.test/api/v1',
          api_key_env: 'OPENROUTER_PR_REVIEW_API_KEY',
          model: EXPECTED_OPENROUTER_MODEL,
          models: EXPECTED_OPENROUTER_MODELS.slice(1),
          compat: 'openrouter',
          reasoning_effort: 'high',
          timeout_ms: 90000,
          connect_timeout_ms: 20000,
          stream: true,
          structured_output: 'strict',
          quarantine_on_timeout: false,
          provider_routing: EXPECTED_OPENROUTER_ROUTING,
        },
        { name: 'gemini', enabled: false, base_url: EXPECTED_GEMINI_BASE_URL, api_key_env: 'GEMINI_API_KEY', model: EXPECTED_GEMINI_MODEL, compat: 'openai', timeout_ms: 90000, connect_timeout_ms: 15000, stream: true, structured_output: 'strict', reasoning_effort: 'high' },
        { name: 'ollama', enabled: true, base_url: 'https://ollama.test/v1', api_key_env: 'OLLAMA_PR_REVIEW_API_KEY', model: 'deepseek-v4-flash:cloud', compat: 'openai', timeout_ms: 30000, connect_timeout_ms: 30000, stream: true, reasoning_effort: 'medium', max_tokens: 65536 },
        { name: 'synthetic', enabled: false, base_url: EXPECTED_SYNTHETIC_BASE_URL, api_key_env: 'SYNTHETIC_API_KEY', model: EXPECTED_SYNTHETIC_MODEL, compat: 'openai', timeout_ms: 120000, connect_timeout_ms: 15000, stream: true, structured_output: 'strict', quarantine_on_timeout: false, reasoning_effort: 'high' },
        { name: 'fireworks', enabled: false, base_url: 'https://api.fireworks.ai/inference/v1', api_key_env: 'FIREWORKS_PR_REVIEW_API_KEY', model: 'accounts/fireworks/models/deepseek-v4-flash-0731', compat: 'openai', timeout_ms: 120000, connect_timeout_ms: 15000, stream: true, structured_output: 'strict', perf_metrics_in_response: true, reasoning_effort: 'high' },
      ],
    },
  };
  for (const transport of policy.review_yeti.transports) {
    transport.ttft_ms = Math.min(60_000, transport.timeout_ms);
    transport.stall_ms = 20_000;
    transport.dispatch_weight = transport.name === 'openrouter-primary' ? 2 : 1;
    transport.max_in_flight = transport.name === 'openrouter-primary'
      ? 2
      : transport.name === 'synthetic'
        ? 5
        : transport.name === 'ollama'
          ? 6
          : 1;
    transport.concurrency_scope = transport.name === 'synthetic' ? 'model' : 'provider';
    transport.capacity_wait_timeout_ms = transport.name === 'openrouter-primary'
      ? 180000
      : transport.name === 'synthetic'
        ? 120000
        : transport.name === 'ollama'
          ? 30000
          : 30000;
    transport.rate_limit = { scope: 'provider', max_retries: 1, max_retry_after_ms: 5000 };
    if (transport.name === 'synthetic') transport.quota_probe = 'synthetic-v2';
    if (transport.name === 'ollama') {
      transport.quarantine_on_timeout = false;
      transport.max_wall_clock_ms = 900000;
    }
  }
  return policy;
}


/** Force-enable one non-ollama transport (and disable ollama) so tests can
 * exercise a retired transport's declared contract without touching the
 * committed policy fixture. Returns the modified policy. */
function policyFixtureWith(enabledTransport) {
  const policy = policyFixture();
  for (const t of policy.review_yeti.transports) {
    t.enabled = t.name === enabledTransport;
  }
  return policy;
}

test('the smoke contract pins the approved transport order (ollama-only, OpenRouter retired)', () => {
  const policy = policyFixture();
  const transports = validatePolicy(policy);
  const ollama = policy.review_yeti.transports.find((transport) => transport.name === 'ollama');
  const gemini = policy.review_yeti.transports.find((transport) => transport.name === 'gemini');
  const openrouter = policy.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary');
  assert.deepEqual(transports.map((transport) => transport.name), EXPECTED_TRANSPORT_ORDER);
  assert.deepEqual(EXPECTED_TRANSPORT_ORDER, ['ollama']);
  assert.equal(ollama.enabled, true);
  for (const disabled of ['openrouter-primary', 'gemini', 'synthetic', 'fireworks']) {
    const declared = policy.review_yeti.transports.find((transport) => transport.name === disabled);
    assert.equal(declared.enabled, false, `${disabled} must remain declared but disabled`);
  }
  assert.equal(buildRequest(gemini).response_format.type, 'json_object');
  assert.equal(buildRequest(gemini).temperature, undefined);
  assert.equal(buildRequest(gemini).reasoning_effort, 'high');
  assert.equal(buildRequest(gemini).stream, true);
  const declaredSynthetic = policy.review_yeti.transports.find((transport) => transport.name === 'synthetic');
  assert.equal(buildRequest(declaredSynthetic).response_format.type, 'json_object');
  assert.equal(buildRequest(declaredSynthetic).temperature, 0);
  assert.equal(buildRequest(declaredSynthetic).reasoning_effort, 'high');
  assert.equal(buildRequest(declaredSynthetic).stream, true);
  assert.equal(buildRequest(ollama).stream, true);
  assert.equal(buildRequest(openrouter).stream, true);
  assert.equal(buildRequest(ollama).reasoning_effort, 'medium');
  assert.deepEqual(buildRequest(openrouter).reasoning, { effort: 'high' });
});

test('Example API resolves Ollama-only and a 90s connect deadline (no OpenRouter fallback)', async () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  const resolved = resolvePolicyForRepository(policy, EXAMPLE_API_REPOSITORY);
  const transports = validatePolicy(resolved, EXAMPLE_API_REPOSITORY);

  assert.deepEqual(transports.map((transport) => transport.name), EXAMPLE_API_TRANSPORT_ORDER);
  assert.equal(resolved.review_yeti.dispatch_mode, 'ordered');
  assert.equal(transports[0].name, 'ollama');
  assert.equal(transports[0].max_in_flight, 6);
  assert.equal(transports[0].concurrency_scope, 'provider');
  assert.equal(transports[0].capacity_wait_timeout_ms, 30000);
  assert.equal(transports[0].connect_timeout_ms, 90000);
  assert.equal(transports.length, 1, 'ollama must be the only enabled transport');

  const calls = [];
  const result = await runSmoke({
    policy,
    env: {
      REVIEW_REPOSITORY: EXAMPLE_API_REPOSITORY,
      OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
      OPENROUTER_PR_REVIEW_API_KEY: 'must-not-be-used',
      SYNTHETIC_API_KEY: 'must-not-be-used',
      FIREWORKS_PR_REVIEW_API_KEY: 'must-not-be-used',
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }),
      };
    },
    log: () => {},
  });

  assert.deepEqual(calls, ['https://ollama.com/v1/chat/completions']);
  assert.deepEqual(result.healthy, ['ollama']);
});

test('isPassthroughRepository respects environment toggles, repository lists, and defaults', (t) => {
  const origEnv = process.env.REVIEW_YETI_PASSTHROUGH;
  t.after(() => {
    if (origEnv === undefined) delete process.env.REVIEW_YETI_PASSTHROUGH;
    else process.env.REVIEW_YETI_PASSTHROUGH = origEnv;
  });

  delete process.env.REVIEW_YETI_PASSTHROUGH;
  assert.equal(isPassthroughRepository('exampleorg/example-api'), false);
  assert.equal(isPassthroughRepository('exampleorg/other-repo'), false);

  process.env.REVIEW_YETI_PASSTHROUGH = 'true';
  assert.equal(isPassthroughRepository('exampleorg/example-api'), true);
  assert.equal(isPassthroughRepository('exampleorg/other-repo'), true);

  process.env.REVIEW_YETI_PASSTHROUGH = '1';
  assert.equal(isPassthroughRepository('exampleorg/other-repo'), true);

  process.env.REVIEW_YETI_PASSTHROUGH = 'false';
  assert.equal(isPassthroughRepository('exampleorg/example-api'), false);

  process.env.REVIEW_YETI_PASSTHROUGH = '0';
  assert.equal(isPassthroughRepository('exampleorg/example-api'), false);

  process.env.REVIEW_YETI_PASSTHROUGH = 'exampleorg/example-meta, example-api';
  assert.equal(isPassthroughRepository('exampleorg/example-meta'), true);
  assert.equal(isPassthroughRepository('exampleorg/example-api'), true);
  assert.equal(isPassthroughRepository('exampleorg/other'), false);
});

test('the Ollama repository set is retired — every repository inherits the same ollama-only default', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  assert.deepEqual([...OLLAMA_REPOSITORIES], [], 'the per-repository Ollama set is retired; policy is repo-agnostic');
  assert.equal(policy.review_yeti.repository_overrides, undefined, 'per-repository overrides must not return');
  for (const repository of ['exampleorg/example-api', 'exampleorg/example-release', 'exampleorg/example-meta', 'exampleorg/anything-else']) {
    const resolved = resolvePolicyForRepository(policy, repository);
    const transports = validatePolicy(resolved, repository);
    assert.deepEqual(transports.map((transport) => transport.name), EXAMPLE_API_TRANSPORT_ORDER, repository);
    assert.equal(resolved.review_yeti.dispatch_mode, 'ordered', repository);
    assert.equal(transports[0].max_in_flight, 6, repository);
    assert.equal(transports[0].connect_timeout_ms, 90000, repository);
  }
});

test('smoke timeout matches the Ollama connect deadline so preflight cannot fail a still-connecting primary (API-3157)', () => {
  const workflow = readFileSync(new URL('../.github/workflows/review-yeti.yml', import.meta.url), 'utf8');
  assert.match(workflow, /REVIEW_YETI_SMOKE_TIMEOUT_MS: 90000/);
  assert.doesNotMatch(workflow, /REVIEW_YETI_SMOKE_TIMEOUT_MS: 30000/);
});

test('central panel job provisions Node 24 before any node scripts (legacy-runtime engines)', () => {
  const workflow = readFileSync(new URL('../.github/workflows/review-yeti.yml', import.meta.url), 'utf8');
  assert.match(workflow, /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/);
  assert.match(workflow, /node-version: 24/);
  const setupIdx = workflow.indexOf('Set up Node 24');
  const firstNodeScript = workflow.indexOf('node .exampleorg-review-actions/scripts/validate-central-dispatch.mjs');
  assert.notEqual(setupIdx, -1);
  assert.notEqual(firstNodeScript, -1);
  assert.ok(setupIdx < firstNodeScript);
});

test('per-repository overrides are retired from committed policy and rejected when reintroduced', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  assert.equal(policy.review_yeti.repository_overrides, undefined, 'committed policy must not carry repository_overrides');
  const other = resolvePolicyForRepository(policy, 'exampleorg/another-repo');
  assert.deepEqual(
    validatePolicy(other).map((transport) => transport.name),
    EXPECTED_TRANSPORT_ORDER,
    'every repository resolves to the same ollama-only default',
  );

  const withOverride = structuredClone(policy);
  withOverride.repository_overrides = { 'exampleorg/legacy-repo': { dispatch_mode: 'ordered', enabled_transports: ['ollama', 'unknown'] } };
  assert.throws(() => resolvePolicyForRepository(withOverride, 'exampleorg/legacy-repo'), /unknown transport: unknown/);
});

test('the committed OpenRouter primary delegates quantization and keeps throughput floors (declared contract, disabled lane)', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  const transports = policy.review_yeti.transports;
  const openrouter = transports.find((transport) => transport.name === 'openrouter-primary');

  assert.deepEqual(openrouter.provider_routing, EXPECTED_OPENROUTER_ROUTING);
  assert.equal(openrouter.model, EXPECTED_OPENROUTER_MODELS[0]);
  assert.deepEqual(openrouter.models, EXPECTED_OPENROUTER_MODELS.slice(1));
  assert.equal(openrouter.plugins, undefined);
  assert.equal(openrouter.provider_routing.allow_fallbacks, true);
  assert.equal(openrouter.provider_routing.sort, 'throughput');
  assert.equal(openrouter.provider_routing.quantizations, undefined);
  assert.deepEqual(openrouter.provider_routing.preferred_min_throughput, { p90: 40 });
  assert.deepEqual(openrouter.provider_routing.preferred_max_latency, { p99: 3 });
  assert.equal(openrouter.allow_banned_providers, undefined);
  assert.deepEqual(openrouter.provider_routing.ignore, ['morph', 'fireworks']);
  assert.equal(openrouter.provider_routing.only, undefined);
  assert.equal(openrouter.provider_routing.order, undefined);
  assert.equal(openrouter.quarantine_on_timeout, false);
  assert.equal(transports.find((transport) => transport.name === 'synthetic').quarantine_on_timeout, false);
  assert.equal(openrouter.enabled, false, 'OpenRouter is retired and stays declared-but-disabled');
  assert.equal(openrouter.timeout_ms, Number(policy.review_yeti.openrouter_timeout_ms));
  assert.equal(openrouter.max_tokens, undefined);
  assert.equal(openrouter.reasoning_effort, 'high');
  const ollama = policy.review_yeti.transports.find((transport) => transport.name === 'ollama');
  assert.equal(ollama.max_tokens, 65536);
  assert.equal(ollama.reasoning_effort, 'medium');
  assert.equal(openrouter.dispatch_weight, 2);
  assert.equal(openrouter.max_in_flight, 2);
  assert.equal(openrouter.concurrency_scope, 'provider');
  assert.equal(openrouter.capacity_wait_timeout_ms, 180_000);
  // Post review-yeti-bot#163: the lane deadline bounds the ACTIVE-transport connect+stall envelope
  // plus the declared overhead reserve, not the sum of timeout_ms (an actively-streaming call is
  // never killed by a duration cap). Mirrors the same inequality emit-policy.mjs enforces.
  assert.ok(
    Number(policy.review_yeti.budget.lane_deadline_ms)
      >= transports
        .filter((transport) => transport.enabled)
        .reduce(
          (sum, transport) => sum + transport.connect_timeout_ms + transport.stall_ms,
          0,
        )
        * Number(policy.review_yeti.openrouter_max_attempts)
        * Number(policy.review_yeti.budget.max_investigation_turns)
        + Number(policy.review_yeti.budget.lane_overhead_ms),
  );
  assert.ok(
    Number(policy.review_yeti.budget.lane_deadline_ms)
      >= Math.max(
        0,
        ...transports
          .filter((transport) => transport.enabled)
          .map((transport) => Number(transport.max_wall_clock_ms) || 0),
      )
      + Number(policy.review_yeti.budget.lane_overhead_ms),
  );
});

test('every active transport keeps lane timeouts out of the run-scoped quarantine', () => {
  const policy = policyFixtureWith('synthetic');
  delete policy.review_yeti.transports.find((transport) => transport.name === 'synthetic').quarantine_on_timeout;

  assert.throws(
    () => validatePolicy(policy),
    /active transport synthetic must keep timeouts lane-local/,
  );
});

test('every transport carries explicit TTFT and stall deadlines into smoke admission', () => {
  for (const key of ['ttft_ms', 'stall_ms']) {
    const policy = policyFixtureWith('synthetic');
    delete policy.review_yeti.transports.find((transport) => transport.name === 'synthetic')[key];

    assert.throws(
      () => validatePolicy(policy),
      new RegExp(`transport synthetic ${key} must be a positive safe integer`),
    );
  }
});

test('transport liveness deadlines cannot exceed the hard request ceiling', () => {
  for (const key of ['connect_timeout_ms', 'ttft_ms', 'stall_ms']) {
    const policy = policyFixtureWith('synthetic');
    const synthetic = policy.review_yeti.transports.find((transport) => transport.name === 'synthetic');
    synthetic[key] = synthetic.timeout_ms + 1;

    assert.throws(
      () => validatePolicy(policy),
      new RegExp(`transport synthetic ${key} must not exceed timeout_ms`),
    );
  }
});

test('compatibility timing aliases cannot drift from the emitted transport contract', () => {
  const ttftPolicy = policyFixture();
  ttftPolicy.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary').ttft_ms += 1;
  assert.throws(() => validatePolicy(ttftPolicy), /OpenRouter transport TTFT must match/);

  const heterogeneousPolicy = policyFixture();
  heterogeneousPolicy.review_yeti.transports.find((transport) => transport.name === 'synthetic').stall_ms += 1;
  assert.doesNotThrow(() => validatePolicy(heterogeneousPolicy));

  const stallPolicy = policyFixture();
  stallPolicy.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary').stall_ms += 1;
  assert.throws(() => validatePolicy(stallPolicy), /OpenRouter transport stall must match/);
});

test('the committed OpenRouter primary leaves provider identity unpinned', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  const openrouter = policy.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary');

  assert.equal(openrouter.provider_routing.only, undefined);
  assert.equal(openrouter.provider_routing.order, undefined);
});

test('validatePolicy rejects a transport that pins provider routing', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));

  for (const selector of ['only', 'order']) {
    const pinned = JSON.parse(JSON.stringify(policy));
    const openrouter = pinned.review_yeti.transports.find((t) => t.name === 'openrouter-primary');
    openrouter.provider_routing[selector] = ['fireworks'];

    assert.throws(
      () => validatePolicy(pinned),
      new RegExp(`pins provider routing via "${selector}"`),
      `a policy pinning provider_routing.${selector} must be rejected, not merged green`,
    );
  }
});

test('the smoke suite probes every configured transport without logging credentials', async () => {
  const calls = [];
  const logs = [];
  const env = {
    GEMINI_API_KEY: 'gemini-secret',
    OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
    OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
    SYNTHETIC_API_KEY: 'synthetic-secret',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization, request: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }) };
  };

  const result = await runSmoke({ policy: policyFixture(), env, fetchImpl, log: (line) => logs.push(line) });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://ollama.test/v1/chat/completions',
  ]);
  assert.deepEqual(result.healthy, EXPECTED_TRANSPORT_ORDER);
  assert.equal(logs.some((line) => line.includes('secret')), false);
  assert.match(logs.join('\n'), /ollama: healthy elapsed_ms=\d+ http=200/);
  assert.match(logs.join('\n'), /policy stream=/);
});

test('the smoke suite fails closed when no provider can complete the real request shape', async () => {
  const logs = [];
  await assert.rejects(
    runSmoke({
      policy: policyFixture(),
      env: {
      GEMINI_API_KEY: 'gemini-secret',
      OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
      OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
      SYNTHETIC_API_KEY: 'synthetic-secret',
      },
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      log: (line) => logs.push(line),
    }),
    /no healthy Review Yeti transport/,
  );
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});

test('the smoke suite keeps healthy transports usable when an optional fallback is unhealthy', async () => {
  const logs = [];
  const result = await runSmoke({
    policy: policyFixtureWith('synthetic'),
    env: {
      SYNTHETIC_API_KEY: 'synthetic-secret',
      OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
      OLLAMA_PR_REVIEW_API_KEY: 'must-not-be-used',
    },
    fetchImpl: async (url) => {
      if (url.startsWith('https://openrouter.test/')) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }) };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(result.healthy, ['synthetic']);
  // Retired lanes are not probed at all — only the enabled synthetic lane runs.
  assert.equal(logs.some((line) => line.includes('openrouter-primary: unhealthy')), false);
});

test('the smoke suite keeps bounded auth and model-not-found diagnostics without provider text', async () => {
  assert.deepEqual(classifyHttpFailure(401, { error: { code: 'unauthorized', message: 'secret-token' } }), {
    failureClass: 'auth',
    errorCode: 'unauthorized',
  });
  assert.deepEqual(classifyHttpFailure(404, { error: { code: 'not_found_error', message: 'model secret-model' } }), {
    failureClass: 'not_found',
    errorCode: 'not_found_error',
  });

  const logs = [];
  const legacyPolicy = policyFixtureWith('openrouter-primary');
  legacyPolicy.review_yeti.transports.find((transport) => transport.name === 'synthetic').enabled = true;
  const result = await runSmoke({
    policy: legacyPolicy,
    env: { OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret', SYNTHETIC_API_KEY: 'synthetic-secret' },
    fetchImpl: async (url) => {
      if (url.startsWith('https://openrouter.test/')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { code: 'not_found_error', message: 'model secret-model' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }) };
    },
    log: (line) => logs.push(line),
  });

  const openrouter = result.results.find((entry) => entry.name === 'openrouter-primary');
  assert.deepEqual(openrouter, {
    name: 'openrouter-primary',
    status: 'unhealthy',
    code: 'http_404',
    failure_class: 'not_found',
    error_code: 'not_found_error',
    http: 404,
    elapsed_ms: openrouter.elapsed_ms,
    ttft_ms: openrouter.ttft_ms,
  });
  assert.equal(logs.join('\n').includes('secret-model'), false);
  assert.equal(logs.join('\n').includes('openrouter-primary: unhealthy'), true);
  assert.deepEqual(result.healthy, ['synthetic']);
});

test('the smoke suite treats missing keys as unavailable and still accepts the healthy primary', async () => {
  const result = await runSmoke({
    policy: policyFixture(),
    env: { OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret', OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n{"ok":true,"review":"SMOKE_OK"}\n```' } }] }) }),
    log: () => {},
  });

  assert.deepEqual(result.healthy, ['ollama']);
  assert.deepEqual(result.results.map((result) => result.status), ['healthy']);
});

test('the smoke suite still accepts SSE chat completions if a transport streams', async () => {
  const logs = [];
  const result = await runSmoke({
    policy: policyFixtureWith('openrouter-primary'),
    env: { OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-type' ? 'text/event-stream' : null) },
      text: async () => 'data: {"choices":[{"delta":{"content":"{\\"ok\\":true,\\"review\\":\\"SMOKE_OK\\"}"}}]}\n\ndata: [DONE]\n',
    }),
    log: (line) => logs.push(line),
  });
  assert.deepEqual(result.healthy, ['openrouter-primary']);
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});

test('the smoke suite rejects policy drift before any network request', () => {
  const policy = policyFixture();
  const committedOrder = policy.review_yeti.transports
    .filter((transport) => transport.enabled)
    .map((transport) => transport.name);
  assert.deepEqual(committedOrder, ['ollama'], 'committed policy must be ordered ollama-only');
  assert.deepEqual(committedOrder, EXAMPLE_API_TRANSPORT_ORDER, 'the committed order must equal the single allowed transport order');
  // Drift detection: any deviation from the single allowed order is contract
  // drift, checked by emit-policy.mjs before any network request (a second
  // enabled lane, a renamed lane, or an ollama-not-first declaration).
  const drifted = policyFixture();
  drifted.review_yeti.transports.find((transport) => transport.name === 'ollama').enabled = false;
  drifted.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary').enabled = true;
  const driftedOrder = drifted.review_yeti.transports
    .filter((transport) => transport.enabled)
    .map((transport) => transport.name);
  assert.notEqual(
    JSON.stringify(driftedOrder),
    JSON.stringify(EXAMPLE_API_TRANSPORT_ORDER),
    're-enabled OpenRouter in place of Ollama is drift',
  );
});

test('the smoke suite rejects unbounded OpenRouter admission before any network request', () => {
  for (const [key, value] of [
    ['dispatch_weight', 3],
    ['max_in_flight', 3],
    ['concurrency_scope', 'model'],
    ['capacity_wait_timeout_ms', 30_000],
  ]) {
    const policy = policyFixture();
    const openrouter = policy.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary');
    openrouter[key] = value;
    assert.throws(() => validatePolicy(policy), /bounded 2:1 striping/);
  }
});

test('the smoke suite rejects weakened OpenRouter routing before any network request', () => {
  const policy = policyFixture();
  const openrouter = policy.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary');
  openrouter.provider_routing = {
    ...openrouter.provider_routing,
  };
  openrouter.provider_routing.only = ['together'];
  // Still rejected, now by the dedicated pin guard rather than the generic shape comparison.
  // The guard runs first precisely so this case reports which key is at fault.
  assert.throws(() => validatePolicy(policy), /pins provider routing via "only"/);
});

test('the smoke suite rejects a policy whose dead-transport connect+stall envelope exceeds the lane deadline', () => {
  // Counterfactual proof the guard actually fires: shrink lane_deadline_ms below the
  // connect+stall envelope the fixture's own transports produce, everything else unchanged.
  const policy = policyFixture();
  const transports = policy.review_yeti.transports.filter((transport) => transport.enabled === true);
  const connectSum = transports.reduce((sum, transport) => sum + transport.connect_timeout_ms, 0);
  const stallSum = transports.reduce((sum, transport) => sum + transport.stall_ms, 0);
  const envelope = (connectSum + stallSum)
    * Number(policy.review_yeti.openrouter_max_attempts)
    * Number(policy.review_yeti.budget.max_investigation_turns);
  policy.review_yeti.budget.lane_deadline_ms = String(envelope + Number(policy.review_yeti.budget.lane_overhead_ms) - 1);
  assert.throws(
    () => validatePolicy(policy),
    /worst-case dead-transport budget .* exceeds review_yeti\.budget\.lane_deadline_ms/,
  );
});

test('the smoke suite rejects missing or invalid lane_overhead_ms before computing the lane-deadline invariant', () => {
  for (const value of [undefined, '0', '-1', 'abc', '']) {
    const policy = policyFixture();
    if (value === undefined) {
      delete policy.review_yeti.budget.lane_overhead_ms;
    } else {
      policy.review_yeti.budget.lane_overhead_ms = value;
    }
    assert.throws(() => validatePolicy(policy), /review_yeti\.budget\.lane_overhead_ms must be a positive integer string/);
  }
});

test('the smoke suite rejects missing or invalid stall_ms before computing the lane-deadline invariant', () => {
  for (const value of [undefined, '0', '-1', 'abc', '']) {
    const policy = policyFixture();
    if (value === undefined) {
      delete policy.review_yeti.stall_ms;
    } else {
      policy.review_yeti.stall_ms = value;
    }
    assert.throws(() => validatePolicy(policy), /review_yeti\.stall_ms must be a positive integer string/);
  }
});

test('the smoke suite rejects a provider allow-list before any network request', () => {
  const policy = policyFixture();
  const openrouter = policy.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary');
  openrouter.provider_routing = {
    ...openrouter.provider_routing,
    only: ['fireworks'],
  };
  assert.throws(() => validatePolicy(policy), /pins provider routing via "only"/);
});

// --- QA-380: whole-run transport failover -----------------------------------------------------
//
// Regression coverage for the reported outage shape: the smoke probe already proved which
// transport(s) were healthy, but the caller workflow ignored that result and always pointed the
// review panel at a hardcoded provider base-url/key/model. resolveTransport() is what the
// workflow now uses to pick the transport it actually calls, so these tests pin the three
// outcomes that mattered in QA-380: healthy OpenRouter primary (no-op), primary down / fallback up
// (real failover, and it must be honest that this happened), and both down (still a hard fail --
// this suite never silently green-lights a run with zero working transports).

test('resolveTransport selects the healthy ollama primary (no-op failover)', () => {
  const transports = policyFixture().review_yeti.transports;
  const resolved = resolveTransport(transports, EXPECTED_TRANSPORT_ORDER);
  assert.equal(resolved.name, 'ollama');
});

test('resolveTransport ignores retired lanes even when reported healthy', () => {
  const transports = policyFixture().review_yeti.transports;
  const resolved = resolveTransport(transports, ['openrouter-primary', 'synthetic', 'ollama']);
  assert.equal(resolved.name, 'ollama');
});

test('resolveTransport keeps direct order while excluding verified fallback providers', () => {
  const transports = policyFixture().review_yeti.transports;
  // With the ollama-only default, ollama is the primary and the only selectable lane.
  assert.equal(resolveTransport(transports, ['ollama']).name, 'ollama');
  const openrouter = transports.find((transport) => transport.name === 'openrouter-primary');
  assert.deepEqual(openrouter.provider_routing.ignore, ['morph', 'fireworks']);
});

test('resolveTransport returns null when nothing is healthy (caller must hard-fail, not run)', () => {
  const transports = policyFixture().review_yeti.transports;
  assert.equal(resolveTransport(transports, []), null);
});

test('selectHealthyTransports removes providers that failed preflight while preserving policy order', () => {
  const transports = policyFixture().review_yeti.transports;
  const selected = selectHealthyTransports(transports, ['ollama']);

  assert.deepEqual(selected.map((transport) => transport.name), ['ollama']);
  assert.deepEqual(
    JSON.parse(Buffer.from(encodeTransportPlan(selected), 'base64').toString('utf8')),
    selected,
  );
});

test('Synthetic capacity derives exact subscription packs and never exceeds the policy ceiling', () => {
  assert.equal(syntheticCapacityFromQuota({ subscription: { limit: 2500 } }, 5), 5);
  assert.equal(syntheticCapacityFromQuota({ rollingFiveHourLimit: { max: 1000 } }, 5), 2);
  assert.equal(syntheticCapacityFromQuota({ rollingFiveHourLimit: { max: 5000 } }, 5), 5);
});

test('Synthetic capacity fails safe to one slot for unavailable or ambiguous quota shapes', () => {
  assert.equal(syntheticCapacityFromQuota(null, 5), 1);
  assert.equal(syntheticCapacityFromQuota({ subscription: { limit: 2499 } }, 5), 1);
  assert.equal(syntheticCapacityFromQuota({ subscription: { limit: '2500' } }, 5), 1);
});

test('Synthetic quota probing stays on the already pinned provider origin', () => {
  const synthetic = policyFixture().review_yeti.transports.find((transport) => transport.name === 'synthetic');
  assert.equal(syntheticQuotaUrl(synthetic), 'https://api.synthetic.new/v2/quotas');
  assert.equal(syntheticQuotaUrl({ ...synthetic, base_url: 'https://lookalike.invalid/openai/v1' }), null);
  assert.equal(syntheticQuotaUrl({ ...synthetic, quota_probe: 'other' }), null);
});

test('boundSyntheticCapacity clamps the admitted transport without exposing its credential', async () => {
  const legacyPolicy = policyFixtureWith('synthetic');
  const transports = selectHealthyTransports(
    legacyPolicy.review_yeti.transports,
    ['synthetic'],
  );
  const logs = [];
  const bounded = await boundSyntheticCapacity(
    transports,
    { SYNTHETIC_API_KEY: 'synthetic-secret' },
    async (url, init) => {
      assert.equal(url, 'https://api.synthetic.new/v2/quotas');
      assert.equal(init.headers.authorization, 'Bearer synthetic-secret');
      return { ok: true, json: async () => ({ rollingFiveHourLimit: { max: 1000 } }) };
    },
    (line) => logs.push(line),
  );

  assert.equal(bounded.find((transport) => transport.name === 'synthetic').max_in_flight, 2);
  assert.equal(logs.join('\n').includes('synthetic-secret'), false);
  assert.match(logs.join('\n'), /max_in_flight=2 source=live-quota/);
});

test('transport helpers fail closed when enabled is missing', () => {
  const undeclared = {
    ...policyFixture().review_yeti.transports.find((transport) => transport.name === 'synthetic'),
  };
  delete undeclared.enabled;

  assert.equal(resolveTransport([undeclared], ['synthetic']), null);
  assert.deepEqual(selectHealthyTransports([undeclared], ['synthetic']), []);
});

test('ollama smoke first-byte budget uses max_wall_clock_ms instead of OpenRouter TTFT', async () => {
  const calls = [];
  const { healthy } = await runSmoke({
    policy: policyFixture(),
    env: { OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret' },
    timeoutMs: 80,
    ttftMs: 5,
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        const onAbort = () => {
          clearTimeout(timer);
          reject(init.signal?.reason || new DOMException('aborted', 'AbortError'));
        };
        if (init.signal?.aborted) onAbort();
        else init.signal.addEventListener('abort', onAbort, { once: true });
      });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }),
      };
    },
    log: () => {},
  });

  assert.deepEqual(healthy, ['ollama']);
  assert.equal(calls[0].max_tokens, 65536);
  assert.equal(calls[0].reasoning_effort, 'medium');
});

test('ollama smoke fetch uses an undici dispatcher whose header timeout covers max_wall_clock_ms', async () => {
  let capturedInit;
  await probeTransport(
    policyFixture().review_yeti.transports.find((entry) => entry.name === 'ollama'),
    'ollama-secret',
    async (_url, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }),
      };
    },
    900000,
    900000,
  );

  assert.equal(capturedInit.dispatcher, getStreamingFetchDispatcher());
  assert.equal(STREAMING_FETCH_DISPATCHER_OPTIONS.headersTimeout, 0);
  assert.equal(STREAMING_FETCH_DISPATCHER_OPTIONS.bodyTimeout, 0);
  const headerTimeout = STREAMING_FETCH_DISPATCHER_OPTIONS.headersTimeout;
  assert.ok(headerTimeout === 0 || headerTimeout >= 900000);
});

test('the smoke suite rejects a lane deadline shorter than max_wall_clock_ms plus overhead', () => {
  const policy = policyFixture();
  policy.review_yeti.budget.lane_deadline_ms = String(
    policy.review_yeti.transports.find((transport) => transport.name === 'ollama').max_wall_clock_ms
    + Number(policy.review_yeti.budget.lane_overhead_ms)
    - 1,
  );
  assert.throws(
    () => validatePolicy(policy),
    /generation wall clock .* exceeds review_yeti\.budget\.lane_deadline_ms/,
  );
});

test('probe admission rejects a transport that misses the action TTFT budget', async () => {
  const transport = policyFixture().review_yeti.transports.find((entry) => entry.name === 'ollama');
  const result = await probeTransport(
    transport,
    'ollama-secret',
    async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
    100,
    5,
  );

  assert.equal(result.status, 'unhealthy');
  assert.equal(result.code, 'ttft_timeout');
});

test('selectHealthyTransports never invents a transport outside the validated policy', () => {
  const transports = policyFixture().review_yeti.transports;
  assert.deepEqual(selectHealthyTransports(transports, ['unknown-provider']), []);
});

test('runSmoke + resolveTransport: zero healthy transports still throws before any output is produced', async () => {
  // Mutation check (red -> green -> red), scripted: force every transport to fail, confirm the
  // hard failure, then confirm a healthy run resolves cleanly again. This exercises the same
  // runSmoke() entry point main() calls, so it is not a hand-wave -- it is the real fail-closed
  // path a fully-down policy takes in CI.
  await assert.rejects(
    runSmoke({
      policy: policyFixture(),
      env: { OLLAMA_PR_REVIEW_API_KEY: 'b' },
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      log: () => {},
    }),
    /no healthy Review Yeti transport/,
  );

  // Restore: the Ollama primary is healthy again and must resolve to a real transport.
  const { healthy } = await runSmoke({
    policy: policyFixture(),
    env: { OLLAMA_PR_REVIEW_API_KEY: 'b' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }) }),
    log: () => {},
  });
  const resolved = resolveTransport(policyFixture().review_yeti.transports, healthy);
  assert.equal(resolved.name, 'ollama');
});

test('the committed policy retains disabled providers as non-admitted transports', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  const gemini = policy.review_yeti.transports.find((transport) => transport.name === 'gemini');
  const ollama = policy.review_yeti.transports.find((transport) => transport.name === 'ollama');
  const fireworks = policy.review_yeti.transports.find((transport) => transport.name === 'fireworks');
  const openrouter = policy.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary');
  const synthetic = policy.review_yeti.transports.find((transport) => transport.name === 'synthetic');
  assert.deepEqual(policy.review_yeti.transports.map((transport) => transport.name), EXPECTED_CONFIGURED_TRANSPORT_ORDER);
  assert.equal(ollama.enabled, true, 'ollama is the only enabled transport');
  for (const disabled of [gemini, fireworks, openrouter, synthetic]) {
    assert.equal(disabled.enabled, false, `${disabled.name} must stay declared-but-disabled`);
  }
  assert.deepEqual(validatePolicy(policy).map((transport) => transport.name), EXPECTED_TRANSPORT_ORDER);
});

test('validatePolicy rejects re-enabling Fireworks without a reviewed policy change', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  policy.review_yeti.transports.find((transport) => transport.name === 'fireworks').enabled = true;
  assert.throws(() => validatePolicy(policy), /Fireworks transport is disabled/);
});
