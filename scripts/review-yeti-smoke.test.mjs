import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EXPECTED_OPENROUTER_ROUTING,
  EXPECTED_TRANSPORT_ORDER,
  buildRequest,
  classifyHttpFailure,
  encodeTransportPlan,
  probeTransport,
  resolveTransport,
  runSmoke,
  selectHealthyTransports,
  validatePolicy,
} from './review-yeti-smoke.mjs';

function policyFixture() {
  return {
    schema: 'exampleorg.review-policy.v1',
    review_yeti: {
      openrouter_max_attempts: '2',
      openrouter_timeout_ms: '90000',
      openrouter_stream: 'true',
      openrouter_ttft_ms: '30000',
      stall_ms: '20000',
      budget: { lane_deadline_ms: '600000', lane_overhead_ms: '60000', max_investigation_turns: '2' },
      transports: [
        {
          name: 'openrouter-fallback',
          base_url: 'https://openrouter.test/api/v1',
          api_key_env: 'OPENROUTER_PR_REVIEW_API_KEY',
          model: 'deepseek/deepseek-v4-flash-0731',
          compat: 'openrouter',
          reasoning_effort: 'high',
          timeout_ms: 90000,
          connect_timeout_ms: 30000,
          stream: true,
          structured_output: 'strict',
          quarantine_on_timeout: false,
          provider_routing: EXPECTED_OPENROUTER_ROUTING,
        },
        { name: 'fireworks', base_url: 'https://fireworks.test/v1', api_key_env: 'FIREWORKS_PR_REVIEW_API_KEY', model: 'fireworks-model', compat: 'openai', timeout_ms: 30000, connect_timeout_ms: 15000, stream: true, reasoning_effort: 'high', structured_output: 'strict', perf_metrics_in_response: true },
        { name: 'ollama', base_url: 'https://ollama.test/v1', api_key_env: 'OLLAMA_PR_REVIEW_API_KEY', model: 'deepseek-v4-flash:cloud', compat: 'openai', timeout_ms: 30000, connect_timeout_ms: 30000, stream: true, reasoning_effort: 'high' },
      ],
    },
  };
}

test('the smoke contract pins the approved transport order', () => {
  const transports = validatePolicy(policyFixture());
  const openrouter = transports.find((transport) => transport.name === 'openrouter-fallback');
  const fireworks = transports.find((transport) => transport.name === 'fireworks');
  const ollama = transports.find((transport) => transport.name === 'ollama');
  assert.deepEqual(transports.map((transport) => transport.name), EXPECTED_TRANSPORT_ORDER);
  assert.deepEqual(buildRequest(openrouter).provider, EXPECTED_OPENROUTER_ROUTING);
  assert.deepEqual(buildRequest(fireworks).response_format, { type: 'json_object' });
  assert.deepEqual(buildRequest(openrouter).response_format, { type: 'json_object' });
  assert.equal(buildRequest(fireworks).max_tokens, 128);
  assert.equal(buildRequest(openrouter).stream, true);
  assert.equal(buildRequest(fireworks).stream, true);
  assert.equal(buildRequest(ollama).stream, true);
  // Measured ablation: pinning `max` cost recall (0.425 vs 0.750) and tripled errors. Unset wins.
  assert.equal(buildRequest(fireworks).reasoning_effort, 'high');
  assert.equal(buildRequest(fireworks).perf_metrics_in_response, true);
  assert.equal(buildRequest(ollama).reasoning_effort, 'high');
  // Measured ablation 2026-08-20: pinning `max` scored recall 0.425 with 25/72 errors vs unset
  // at 0.750 with 7/72. The provider default wins; no reasoning override is emitted.
  assert.deepEqual(buildRequest(openrouter).reasoning, { effort: 'high' });
});

test('the committed OpenRouter fallback delegates quantization and keeps throughput floors', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  const transports = validatePolicy(policy);
  const openrouter = transports.find((transport) => transport.name === 'openrouter-fallback');

  assert.deepEqual(openrouter.provider_routing, EXPECTED_OPENROUTER_ROUTING);
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
  assert.equal(openrouter.timeout_ms, Number(policy.review_yeti.openrouter_timeout_ms));
  assert.equal(openrouter.max_tokens, 24_576);
  // Post review-yeti-bot#163: the lane deadline bounds the dead-transport connect+stall envelope
  // plus the declared overhead reserve, not the sum of timeout_ms (an actively-streaming call is
  // never killed by a duration cap). Mirrors the same inequality emit-policy.mjs enforces.
  assert.ok(
    Number(policy.review_yeti.budget.lane_deadline_ms)
      >= (transports.reduce((sum, transport) => sum + transport.connect_timeout_ms, 0)
        + transports.length * Number(policy.review_yeti.stall_ms))
      * Number(policy.review_yeti.openrouter_max_attempts)
      * Number(policy.review_yeti.budget.max_investigation_turns)
      + Number(policy.review_yeti.budget.lane_overhead_ms),
  );
});

test('the committed OpenRouter fallback leaves provider identity unpinned', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  const openrouter = validatePolicy(policy).find((transport) => transport.name === 'openrouter-fallback');

  assert.equal(openrouter.provider_routing.only, undefined);
  assert.equal(openrouter.provider_routing.order, undefined);
});

test('validatePolicy rejects a transport that pins provider routing', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));

  for (const selector of ['only', 'order']) {
    const pinned = JSON.parse(JSON.stringify(policy));
    const openrouter = pinned.review_yeti.transports.find((t) => t.name === 'openrouter-fallback');
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
    FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret',
    OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
    OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization, request: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }) };
  };

  const result = await runSmoke({ policy: policyFixture(), env, fetchImpl, log: (line) => logs.push(line) });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://openrouter.test/api/v1/chat/completions',
    'https://fireworks.test/v1/chat/completions',
    'https://ollama.test/v1/chat/completions',
  ]);
  assert.deepEqual(result.healthy, EXPECTED_TRANSPORT_ORDER);
  assert.equal(logs.some((line) => line.includes('secret')), false);
  assert.equal(JSON.stringify(logs).includes('fireworks-secret'), false);
  assert.match(logs.join('\n'), /openrouter-fallback: healthy elapsed_ms=\d+ http=200/);
  assert.match(logs.join('\n'), /policy stream=/);
});

test('the smoke suite fails closed when no provider can complete the real request shape', async () => {
  const logs = [];
  await assert.rejects(
    runSmoke({
      policy: policyFixture(),
      env: {
        FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret',
        OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
        OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
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
    policy: policyFixture(),
    env: {
      FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret',
      OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
      OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
    },
    fetchImpl: async (url) => {
      if (url.startsWith('https://openrouter.test/')) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }) };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(result.healthy, ['fireworks', 'ollama']);
  assert.equal(logs.some((line) => line.includes('unhealthy optional transport(s): openrouter-fallback (http_401)')), true);
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
  const result = await runSmoke({
    policy: policyFixture(),
    env: { OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret', OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret' },
    fetchImpl: async (url) => {
      if (url.startsWith('https://ollama.test/')) {
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

  const ollama = result.results.find((entry) => entry.name === 'ollama');
  assert.deepEqual(ollama, {
    name: 'ollama',
    status: 'unhealthy',
    code: 'http_404',
    failure_class: 'not_found',
    error_code: 'not_found_error',
    http: 404,
    elapsed_ms: ollama.elapsed_ms,
    ttft_ms: ollama.ttft_ms,
  });
  assert.equal(logs.join('\n').includes('secret-model'), false);
  assert.equal(logs.join('\n').includes('ollama: unhealthy'), true);
  assert.deepEqual(result.healthy, ['openrouter-fallback']);
});

test('the smoke suite treats missing keys as unavailable and still accepts a healthy fallback', async () => {
  const result = await runSmoke({
    policy: policyFixture(),
    env: { OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n{"ok":true,"review":"SMOKE_OK"}\n```' } }] }) }),
    log: () => {},
  });

  assert.deepEqual(result.healthy, ['openrouter-fallback']);
  assert.deepEqual(result.results.map((result) => result.status), ['healthy', 'missing', 'missing']);
});

test('the smoke suite still accepts SSE chat completions if a transport streams', async () => {
  const logs = [];
  const result = await runSmoke({
    policy: policyFixture(),
    env: { FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-type' ? 'text/event-stream' : null) },
      text: async () => 'data: {"choices":[{"delta":{"content":"{\\"ok\\":true,\\"review\\":\\"SMOKE_OK\\"}"}}]}\n\ndata: [DONE]\n',
    }),
    log: (line) => logs.push(line),
  });
  assert.deepEqual(result.healthy, ['fireworks']);
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});

test('the smoke suite rejects policy drift before any network request', () => {
  const policy = policyFixture();
  policy.review_yeti.transports.reverse();
  assert.throws(() => validatePolicy(policy), /transport order/);
});

test('the smoke suite rejects weakened OpenRouter routing before any network request', () => {
  const policy = policyFixture();
  const openrouter = policy.review_yeti.transports.find((transport) => transport.name === 'openrouter-fallback');
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
  const transports = policy.review_yeti.transports;
  const stallMs = Number(policy.review_yeti.stall_ms);
  const connectSum = transports.reduce((sum, transport) => sum + transport.connect_timeout_ms, 0);
  const envelope = (connectSum + transports.length * stallMs)
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
  const openrouter = policy.review_yeti.transports.find((transport) => transport.name === 'openrouter-fallback');
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
// review panel at a hardcoded Fireworks base-url/key/model. resolveTransport() is what the
// workflow now uses to pick the transport it actually calls, so these tests pin the three
// outcomes that mattered in QA-380: healthy primary (no-op), primary down / fallback up
// (real failover, and it must be honest that this happened), and both down (still a hard fail --
// this suite never silently green-lights a run with zero working transports).

test('resolveTransport prefers OpenRouter when it is healthy', () => {
  const transports = policyFixture().review_yeti.transports;
  const resolved = resolveTransport(transports, ['fireworks', 'openrouter-fallback']);
  assert.equal(resolved.name, 'openrouter-fallback');
});

test('resolveTransport falls back to Fireworks when OpenRouter is unhealthy', () => {
  const transports = policyFixture().review_yeti.transports;
  const resolved = resolveTransport(transports, ['fireworks']);
  assert.equal(resolved.name, 'fireworks');
});

test('resolveTransport keeps OpenRouter-first order while excluding unhealthy providers', () => {
  const transports = policyFixture().review_yeti.transports;
  for (const healthy of [['openrouter-fallback'], ['fireworks', 'openrouter-fallback']]) {
    assert.equal(resolveTransport(transports, healthy).name, 'openrouter-fallback');
  }
  const openrouter = transports.find((transport) => transport.name === 'openrouter-fallback');
  assert.deepEqual(openrouter.provider_routing.ignore, ['morph', 'fireworks']);
});

test('resolveTransport returns null when nothing is healthy (caller must hard-fail, not run)', () => {
  const transports = policyFixture().review_yeti.transports;
  assert.equal(resolveTransport(transports, []), null);
});

test('selectHealthyTransports removes providers that failed preflight while preserving policy order', () => {
  const transports = policyFixture().review_yeti.transports;
  const selected = selectHealthyTransports(transports, ['openrouter-fallback', 'fireworks']);

  assert.deepEqual(selected.map((transport) => transport.name), ['openrouter-fallback', 'fireworks']);
  assert.deepEqual(
    JSON.parse(Buffer.from(encodeTransportPlan(selected), 'base64').toString('utf8')),
    selected,
  );
});

test('probe admission rejects a transport that misses the action TTFT budget', async () => {
  const transport = policyFixture().review_yeti.transports.find((entry) => entry.name === 'fireworks');
  const result = await probeTransport(
    transport,
    'fireworks-secret',
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
      env: { FIREWORKS_PR_REVIEW_API_KEY: 'a', OPENROUTER_PR_REVIEW_API_KEY: 'b' },
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      log: () => {},
    }),
    /no healthy Review Yeti transport/,
  );

  // Restore: only the fallback is healthy now -- this is the exact QA-380 shape (primary down,
  // fallback up) and must resolve to a real transport, not repeat the hard failure above.
  const { healthy } = await runSmoke({
    policy: policyFixture(),
    env: { FIREWORKS_PR_REVIEW_API_KEY: 'a', OPENROUTER_PR_REVIEW_API_KEY: 'b' },
    fetchImpl: async (url) => {
      if (url.startsWith('https://fireworks.test/')) return { ok: false, status: 504, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }) };
    },
    log: () => {},
  });
  const resolved = resolveTransport(policyFixture().review_yeti.transports, healthy);
  assert.equal(resolved.name, 'openrouter-fallback');
});

test('the committed fireworks timeout stays above the measured generation ceiling', () => {
  // Live probes 2026-08-20 (streaming, production prompt shape, no token cap, 4 reps each):
  //   fireworks  reasoning_effort=max   median 24,017ms  max 31,998ms
  //   openrouter reasoning_effort=high  median  6,313ms  max  7,205ms
  // fireworks sat at 30,000ms against a 31,998ms observed max and timed out 7-18 times per
  // production run. PR #82 raised it; PR #85 reverted it silently while changing something
  // unrelated, and the timeouts came straight back. This asserts the COMMITTED policy only --
  // synthetic fixtures elsewhere legitimately use small timeouts -- and it is a floor, not a
  // pin, so tuning upward stays free.
  const MEASURED_MAX_MS = 31998;
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  const fireworks = policy.review_yeti.transports.find((t) => t.name === 'fireworks');
  assert.ok(
    fireworks.timeout_ms > MEASURED_MAX_MS,
    `fireworks timeout_ms ${fireworks.timeout_ms}ms must exceed the measured ${MEASURED_MAX_MS}ms generation max`,
  );
});
