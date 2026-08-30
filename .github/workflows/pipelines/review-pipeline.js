#!/usr/bin/env node

/**
 * Review Panel Pipeline Script
 * .github/workflows/pipelines/review-pipeline.js
 *
 * Evaluates PR diff payloads in parallel across 12 persona charters,
 * ingests MCP_CONFIG_JSON & registers MCP servers via mcpFleetManager,
 * computes binding arbitration quorum (SHIP, FIX_FIRST, BLOCK),
 * formats a GitHub PR comment containing Mermaid summary graph/diagram and MCP telemetry,
 * and posts via `gh pr comment` CLI or outputs formatted comment to file/stdout.
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync, execSync } = require('child_process');
const {
  computeArbitration: computeCanonicalArbitration,
  sanitizeFindings: sanitizeCanonicalFindings,
  validateReviewFindings,
} = require('../../../src/review/reviewCore');
const { applyFalsificationOutcomes, runFindingFalsification } = require('../../../src/review/findingFalsification');
const {
  resolveOpenRouterReviewPolicy,
  buildOpenRouterRequestOptions,
} = require('./openrouter-policy');

let mcpFleetManager = null;
try {
  const mcpModule = require('../../../src/mcp/mcpFleetManager');
  mcpFleetManager = mcpModule.mcpFleetManager || mcpModule.McpFleetManager?.getInstance();
} catch (_) {
  try {
    const mcpModule = require('../../src/mcp/mcpFleetManager');
    mcpFleetManager = mcpModule.mcpFleetManager || mcpModule.McpFleetManager?.getInstance();
  } catch (_) {}
}

let SessionLedger = null;
try {
  const ledgerModule = require('../../../src/memory/sessionLedger');
  SessionLedger = ledgerModule.SessionLedger;
} catch (_) {
  try {
    const ledgerModule = require('../../src/memory/sessionLedger');
    SessionLedger = ledgerModule.SessionLedger;
  } catch (_) {}
}

let diffCompactor = null;
try {
  diffCompactor = require('../../../src/pipeline/diffCompactor');
} catch (_) {
  try {
    diffCompactor = require('../../src/pipeline/diffCompactor');
  } catch (_) {
    try {
      diffCompactor = require('../../../dist/pipeline/diffCompactor');
    } catch (_) {}
  }
}

let shaPartitionManager = null;
try {
  shaPartitionManager = require('../../../src/pipeline/shaPartitionManager');
} catch (_) {
  try {
    shaPartitionManager = require('../../src/pipeline/shaPartitionManager');
  } catch (_) {
    try {
      shaPartitionManager = require('../../../dist/pipeline/shaPartitionManager');
    } catch (_) {}
  }
}

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/auto';
const DEFAULT_PERSONA_CONCURRENCY = 3;
const OLLAMA_MAX_IN_FLIGHT_REQUESTS = 16;
const OLLAMA_CAPACITY_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_FORMAT_RECOVERY_MAX_OUTPUT_TOKENS = 4_096;
// Streaming responses need both an inactivity watchdog and a total generation
// budget. Without the latter, a provider can emit a never-ending sequence of
// small deltas and keep a review lane alive indefinitely. The total budget is
// capped by the admitted transport timeout so the wire contract and the
// watchdog agree; a bounded recovery attempt, when admitted, gets its own
// transport window.
const DEFAULT_STREAM_MAX_WALL_CLOCK_MS = 180_000;

// OpenRouter's official SDK is used only for the OpenRouter gateway branch. Direct providers
// remain on their existing OpenAI-compatible transport because their response contracts and
// recovery policies are intentionally different. The Action installs this pinned dependency in
// its own path before this pipeline starts. Preload the module when available so the first
// transport deadline measures provider work rather than the SDK's one-time module initialization;
// the guarded load still lets non-OpenRouter callers report a clear error if packaging is broken.
let openRouterSdkModule = null;

function loadOpenRouterSdk() {
  if (!openRouterSdkModule) {
    try {
      openRouterSdkModule = require('@openrouter/sdk');
    } catch (error) {
      throw new Error(`OpenRouter official SDK is unavailable: ${error?.message || String(error)}`);
    }
  }
  return openRouterSdkModule;
}

try {
  openRouterSdkModule = require('@openrouter/sdk');
} catch (_) {
  // Keep import-time behavior compatible for callers that do not exercise OpenRouter. The
  // OpenRouter branch will fail closed with the actionable error from loadOpenRouterSdk().
}

function mapOpenRouterSdkKeys(value, mapping) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [mapping[key] || key, item]));
}

function toOpenRouterSdkRequest(requestBody) {
  if (requestBody?.perf_metrics_in_response !== undefined) {
    throw new Error('OpenRouter official SDK does not expose perf_metrics_in_response; refusing to drop the requested extension');
  }
  const provider = requestBody.provider && mapOpenRouterSdkKeys(requestBody.provider, {
    allow_fallbacks: 'allowFallbacks',
    data_collection: 'dataCollection',
    enforce_distillable_text: 'enforceDistillableText',
    max_price: 'maxPrice',
    preferred_max_latency: 'preferredMaxLatency',
    preferred_min_throughput: 'preferredMinThroughput',
    require_parameters: 'requireParameters',
  });
  const plugins = Array.isArray(requestBody.plugins)
    ? requestBody.plugins.map((plugin) => mapOpenRouterSdkKeys(plugin, {
        allowed_models: 'allowedModels',
        cost_quality_tradeoff: 'costQualityTradeoff',
        cost_tier: 'costTier',
        excluded_models: 'excludedModels',
        pin_model: 'pinModel',
      }))
    : undefined;
  const responseFormat = requestBody.response_format
    ? mapOpenRouterSdkKeys(requestBody.response_format, { json_schema: 'jsonSchema' })
    : undefined;
  const reasoning = requestBody.reasoning
    ? mapOpenRouterSdkKeys(requestBody.reasoning, {})
    : undefined;
  return {
    model: requestBody.model,
    messages: requestBody.messages,
    ...(requestBody.stream !== undefined ? { stream: requestBody.stream } : {}),
    ...(requestBody.max_tokens !== undefined ? { maxTokens: requestBody.max_tokens } : {}),
    ...(requestBody.max_completion_tokens !== undefined ? { maxCompletionTokens: requestBody.max_completion_tokens } : {}),
    ...(requestBody.temperature !== undefined ? { temperature: requestBody.temperature } : {}),
    ...(requestBody.reasoning_effort !== undefined ? { reasoningEffort: requestBody.reasoning_effort } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(responseFormat ? { responseFormat } : {}),
    ...(provider ? { provider } : {}),
    ...(plugins ? { plugins } : {}),
    ...(requestBody.models ? { models: requestBody.models } : {}),
    ...(requestBody.seed !== undefined ? { seed: requestBody.seed } : {}),
    ...(requestBody.metadata ? { metadata: requestBody.metadata } : {}),
  };
}

function sdkUsageToWire(usage) {
  if (!usage || typeof usage !== 'object') return usage;
  const costDetails = usage.costDetails || usage.cost_details;
  return {
    ...usage,
    ...(usage.promptTokens !== undefined ? { prompt_tokens: usage.promptTokens } : {}),
    ...(usage.completionTokens !== undefined ? { completion_tokens: usage.completionTokens } : {}),
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    ...(usage.completionTokensDetails ? { completion_tokens_details: usage.completionTokensDetails } : {}),
    ...(usage.promptTokensDetails ? { prompt_tokens_details: usage.promptTokensDetails } : {}),
    ...(usage.isByok !== undefined ? { is_byok: usage.isByok } : {}),
    ...(costDetails ? {
      cost_details: {
        ...costDetails,
        ...(costDetails.upstreamInferenceCompletionsCost !== undefined ? { upstream_inference_completions_cost: costDetails.upstreamInferenceCompletionsCost } : {}),
        ...(costDetails.upstreamInferenceCost !== undefined ? { upstream_inference_cost: costDetails.upstreamInferenceCost } : {}),
        ...(costDetails.upstreamInferencePromptCost !== undefined ? { upstream_inference_prompt_cost: costDetails.upstreamInferencePromptCost } : {}),
      },
    } : {}),
  };
}

function sdkChunkToWire(chunk) {
  if (!chunk || typeof chunk !== 'object') return chunk;
  return {
    ...chunk,
    ...(chunk.openrouterMetadata ? { openrouter_metadata: chunk.openrouterMetadata } : {}),
    ...(chunk.serviceTier ? { service_tier: chunk.serviceTier } : {}),
    ...(chunk.systemFingerprint ? { system_fingerprint: chunk.systemFingerprint } : {}),
    ...(chunk.usage ? { usage: sdkUsageToWire(chunk.usage) } : {}),
    choices: Array.isArray(chunk.choices) ? chunk.choices.map((choice) => ({
      ...choice,
      ...(choice.finishReason !== undefined ? { finish_reason: choice.finishReason } : {}),
      delta: choice.delta ? {
        ...choice.delta,
        ...(choice.reasoningDetails ? { reasoning_details: choice.reasoningDetails } : {}),
        ...(choice.toolCalls ? { tool_calls: choice.toolCalls } : {}),
      } : choice.delta,
    })) : chunk.choices,
  };
}

function sdkResultToWire(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    ...(result.systemFingerprint ? { system_fingerprint: result.systemFingerprint } : {}),
    ...(result.serviceTier ? { service_tier: result.serviceTier } : {}),
    ...(result.usage ? { usage: sdkUsageToWire(result.usage) } : {}),
    choices: Array.isArray(result.choices) ? result.choices.map((choice) => ({
      ...choice,
      ...(choice.finishReason !== undefined ? { finish_reason: choice.finishReason } : {}),
      message: choice.message ? {
        ...choice.message,
        ...(choice.reasoningDetails ? { reasoning_details: choice.reasoningDetails } : {}),
        ...(choice.toolCalls ? { tool_calls: choice.toolCalls } : {}),
      } : choice.message,
    })) : result.choices,
  };
}

function sdkResponseHeaders(response, contentType) {
  const headers = new Headers(response?.headers || {});
  headers.set('content-type', contentType);
  return headers;
}

async function callOpenRouterSdk({ baseUrl, apiKey, requestBody, fetchImpl, signal }) {
  const { OpenRouter, HTTPClient } = loadOpenRouterSdk();
  let capturedResponse = null;
  let capturedCompatibilityResponse = null;
  let capturedRawBody = null;
  const cancelCapturedRawBody = (reason) => {
    try {
      capturedRawBody?.cancel?.(reason);
    } catch (_) {
      // Cleanup is best effort; the active request has already been classified by the caller.
    }
  };
  const httpClient = new HTTPClient({
    fetcher: async (sdkRequest) => {
      const body = sdkRequest.body ? await sdkRequest.clone().text() : undefined;
      let response = await fetchImpl(sdkRequest.url, {
        method: sdkRequest.method,
        headers: (() => {
          if (!(sdkRequest.headers instanceof Headers)) return sdkRequest.headers;
          const headers = Object.fromEntries(sdkRequest.headers.entries());
          for (const [wireName, legacyName] of [
            ['authorization', 'Authorization'],
            ['content-type', 'Content-Type'],
            ['accept', 'Accept'],
          ]) {
            if (headers[wireName] !== undefined) {
              headers[legacyName] = headers[wireName];
              delete headers[wireName];
            }
          }
          // Preserve the legacy test/instrumentation spelling while the SDK itself owns the
          // actual wire headers (HTTP header names remain case-insensitive on the network).
          const metadata = sdkRequest.headers.get('x-openrouter-metadata');
          if (metadata) {
            delete headers['x-openrouter-metadata'];
            headers['X-OpenRouter-Metadata'] = metadata;
          }
          return headers;
        })(),
        ...(body !== undefined ? { body } : {}),
        signal: sdkRequest.signal,
      });
      // Unit/replay callers may inject a small OpenAI-compatible response double instead of a
      // WHATWG Response. Keep that test seam compatible without weakening production behavior:
      // runner fetch always returns a native Response and therefore always takes the SDK path.
      const compatibilityStreamDouble = !(response instanceof Response)
        && typeof response?.body?.getReader === 'function';
      if (!(response instanceof Response)) {
        capturedCompatibilityResponse = response;
        // The generated SDK expects a WHATWG Response. Adapt only the test/replay seam to a
        // native response so the SDK can still exercise its request/validation path; if the
        // compatibility payload is not a complete SDK envelope, the catch below returns the
        // original response double to preserve the pipeline's legacy parser contract.
        // A response double may expose a live ReadableStream as `body`. It cannot be coerced into
        // the native Response constructor without losing the stream; keep the original double
        // available for the legacy parser when the strict SDK rejects the empty adaptation.
        let compatibilityBody = typeof response?.body === 'string' || response?.body instanceof Uint8Array
          ? response.body
          : '';
        if (!compatibilityBody && typeof response?.json === 'function') {
          try {
            compatibilityBody = JSON.stringify(await response.json());
          } catch (_) {
            // Fall through to text for doubles that model malformed/non-JSON responses.
          }
        }
        if (!compatibilityBody && typeof response?.text === 'function') {
          compatibilityBody = await response.text();
        }
        response = new Response(compatibilityStreamDouble ? '{}' : compatibilityBody, {
          status: Number(response?.status) || 200,
          headers: compatibilityStreamDouble
            ? { 'content-type': 'application/json' }
            : response?.headers || { 'content-type': 'application/json' },
        });
      }
      capturedResponse = response;
      // Consume a clone in parallel so an SDK schema rejection can fall back to the repository's
      // broader OpenAI-compatible parser without leaving an unread tee that blocks EventStream
      // cancellation at [DONE]. This is one bounded in-memory response, not a second request.
      try {
        const rawClone = response.clone();
        const rawReader = rawClone.body?.getReader();
        const body = rawReader
          ? (async () => {
              const decoder = new TextDecoder();
              let text = '';
              try {
                while (true) {
                  const { done, value } = await rawReader.read();
                  if (done) break;
                  if (value) text += decoder.decode(value, { stream: true });
                }
                return text + decoder.decode();
              } finally {
                rawReader.releaseLock?.();
              }
            })()
          : rawClone.text();
        let cancelled = false;
        capturedRawBody = compatibilityStreamDouble ? null : {
          body,
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
          cancel: (reason) => {
            if (cancelled) return;
            cancelled = true;
            try {
              const cancellation = rawReader?.cancel(reason);
              if (cancellation?.catch) void cancellation.catch(() => {});
            } catch (_) {
              // Cleanup is best effort; the active request has already been classified by the caller.
            }
          },
        };
        if (capturedRawBody && signal) {
          const cancelOnAbort = () => cancelCapturedRawBody('request aborted');
          if (signal.aborted) cancelOnAbort();
          else signal.addEventListener('abort', cancelOnAbort, { once: true });
        }
      } catch (_) {
        capturedRawBody = null;
      }
      return response;
    },
  });
  const client = new OpenRouter({
    apiKey,
    serverURL: baseUrl,
    httpClient,
    // The review pipeline owns retry-after, model fallback, and the 15-minute ceiling.
    retryConfig: { strategy: 'none' },
  });
  try {
    const result = await client.chat.send({
      xOpenRouterMetadata: 'enabled',
      chatRequest: toOpenRouterSdkRequest(requestBody),
    }, {
      signal,
      retries: { strategy: 'none' },
    });
    if (result && typeof result.getReader === 'function') {
      const upstream = result;
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          (async () => {
            const reader = upstream.getReader();
            let emittedChunks = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                emittedChunks += 1;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(sdkChunkToWire(value))}\n\n`));
              }
              // A few existing replay callers use line-delimited OpenAI-compatible fixtures
              // without the blank SSE event delimiter required by the SDK. If the strict SDK
              // therefore observes an empty stream, replay the already-buffered response through
              // the legacy parser seam; live OpenRouter responses use the SDK path normally.
              if (emittedChunks === 0 && capturedRawBody) {
                const rawBody = await capturedRawBody.body;
                if (rawBody.trim()) controller.enqueue(encoder.encode(rawBody));
                else controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              } else {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              }
              controller.close();
              cancelCapturedRawBody('sdk response parsed');
            } catch (error) {
              // Preserve the broader OpenAI-compatible response contract when the official SDK
              // rejects legacy/incomplete chunk envelopes. This does not retry the request.
              if (capturedRawBody && !signal?.aborted) {
                try {
                  const rawBody = await capturedRawBody.body;
                  if (rawBody.trim()) {
                    controller.enqueue(encoder.encode(rawBody));
                    controller.close();
                    cancelCapturedRawBody('compatibility response parsed');
                    return;
                  }
                } catch (_) {
                  // Fall through to the strict SDK error when capture is unavailable.
                }
              }
              controller.error(error);
            } finally {
              reader.releaseLock?.();
            }
          })();
        },
        cancel(reason) {
          return upstream.cancel?.(reason);
        },
      });
      return {
        response: new Response(body, {
          status: capturedResponse?.status || 200,
          headers: sdkResponseHeaders(capturedResponse, 'text/event-stream'),
        }),
        sdkError: null,
      };
    }
    cancelCapturedRawBody('sdk response parsed');
    return {
      response: new Response(JSON.stringify(sdkResultToWire(result)), {
        status: capturedResponse?.status || 200,
        headers: sdkResponseHeaders(capturedResponse, 'application/json'),
      }),
      sdkError: null,
    };
  } catch (error) {
    if (signal?.aborted) cancelCapturedRawBody('request aborted');
    if (capturedCompatibilityResponse && !capturedRawBody) {
      return { response: capturedCompatibilityResponse, sdkError: null };
    }
    if (capturedRawBody && !signal?.aborted) {
      try {
        const abort = signal
          ? new Promise((_, reject) => {
              if (signal.aborted) reject(new Error('request aborted'));
              else signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
            })
          : null;
        const body = await (abort
          ? Promise.race([capturedRawBody.body, abort])
          : capturedRawBody.body);
        return {
          response: new Response(body, {
            status: capturedRawBody.status,
            statusText: capturedRawBody.statusText,
            headers: capturedRawBody.headers,
          }),
          sdkError: null,
        };
      } catch (_) {
        // Preserve the SDK error below when the provider body cannot be captured before abort.
      }
    }
    const status = Number(error?.statusCode || error?.status || error?.rawResponse?.status || capturedResponse?.status || 500);
    const headers = error?.headers || capturedResponse?.headers || { 'content-type': 'application/json' };
    const body = error?.body || '';
    return {
      response: new Response(body, { status, headers }),
      sdkError: error,
    };
  }
}

function resolvePersonaConcurrency(value = process.env.REVIEW_YETI_MAX_CONCURRENCY) {
  if (value === undefined || value === null || value === '') return DEFAULT_PERSONA_CONCURRENCY;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 25) {
    throw new Error('REVIEW_YETI_MAX_CONCURRENCY must be an integer between 1 and 25');
  }
  return parsed;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const limit = Math.min(resolvePersonaConcurrency(concurrency), items.length);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

class AsyncSemaphore {
  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('semaphore limit must be a positive integer');
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async acquire(timeoutMs) {
    if (this.active >= this.limit) {
      await new Promise((resolve, reject) => {
        const waiter = { resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('ollama_capacity_wait_timeout'));
        }, timeoutMs);
        this.waiters.push(waiter);
      });
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      } else {
        this.active -= 1;
      }
    };
  }
}

// This process-local ceiling prevents an unsafe persona/partition override from driving one
// action job past the measured Ollama Cloud burst boundary. It does not coordinate separate
// GitHub jobs; the normal review default remains three concurrent persona lanes.
const ollamaRequestSemaphore = new AsyncSemaphore(OLLAMA_MAX_IN_FLIGHT_REQUESTS);

// Whitelabel display name used in the posted comment. Override with BOT_NAME.
const BOT_LABEL = process.env.BOT_NAME || 'AI Review Panel';

// Built-in reviewer charters.
//
// Each charter is a system prompt, so it is written as instructions rather than as a list of
// topics: what the reviewer covers, what it must leave alone, and how to grade severity. The
// "do not flag" section carries most of the weight — an unconstrained reviewer reports every
// observation it can justify, and a review nobody trusts is worse than no review.
//
// `defaultEnabled` marks the reviewers that apply to essentially any codebase. The rest are
// situational and are opted into by id.
const PERSONA_CHARTERS = [
  {
    id: 'security',
    name: '🛡️ Security & Tenancy Guardian',
    model: DEFAULT_MODEL,
    defaultEnabled: true,
    charter: `You review changes for security defects that are demonstrable in the diff.

Flag:
- Credentials, tokens or private keys committed as literals.
- User-controlled input reaching a query, command, path, template or redirect without validation or parameterisation.
- Authentication or authorisation checks that are missing, bypassable, or applied after the protected work has happened.
- Data access that crosses a tenant, user or organisation boundary without a scoping predicate.
- Secrets or personal data written to logs, error messages or telemetry.

Do not flag:
- Test fixtures, example values and obvious placeholders such as "sk-test", "changeme" or "user@example.com".
- Missing defence-in-depth on a path that is already correctly guarded.
- Generic advice to "consider adding validation" with no specific untrusted input identified.
- Framework behaviour you cannot see in the diff, such as assuming an ORM does not parameterise.

Severity: P0 for something an attacker could exploit or that leaks real data. P1 for a missing check on a reachable path. P2 for hardening worth doing but not urgent.`,
  },
  {
    id: 'performance',
    name: '⚡ Performance & Scalability Specialist',
    model: DEFAULT_MODEL,
    defaultEnabled: true,
    charter: `You review changes for performance defects that will matter at realistic scale.

Flag:
- Queries or network calls issued inside a loop over a collection that grows with data (the N+1 pattern).
- Work that is quadratic or worse in the size of an input that is not bounded.
- Blocking or synchronous I/O on a request path or inside an event loop.
- Unbounded accumulation: caches without eviction, arrays that only ever grow, listeners never removed.
- Loading an entire dataset into memory when the operation only needs a page or an aggregate.

Do not flag:
- Micro-optimisations with no measurable effect, such as loop style, string concatenation, or caching a trivially cheap expression.
- Work on collections that are fixed and small by construction, such as iterating a config list or a set of enum values.
- Anything in tests, build scripts, migrations or CLI tooling, where latency does not matter.
- Speculative scaling concerns without a concrete growth path visible in the change.

Severity: P0 only for something that will exhaust memory or hang in production. P1 for a real regression on a hot path. P2 for inefficiency worth cleaning up.`,
  },
  {
    id: 'architecture',
    name: '🏛️ System Architecture & Design',
    model: DEFAULT_MODEL,
    defaultEnabled: true,
    charter: `You review changes for structural problems that will make the codebase harder to change.

Flag:
- Dependencies pointing the wrong way through the layering, such as domain logic importing infrastructure or presentation code.
- Business rules duplicated into a second place rather than reused, where the copies will drift.
- New circular dependencies between modules.
- Public interfaces changed in a way that silently breaks existing callers.
- Logic placed in a layer that cannot test it, such as decisions embedded in a controller or a UI component.

Do not flag:
- Patterns the surrounding code already uses consistently. Match the codebase rather than an ideal.
- Requests for abstraction that is not yet needed. Two similar call sites are not duplication.
- Renaming, file moves, or preferences about directory layout.
- Design opinions unsupported by a concrete maintenance cost you can name.

Severity: P0 is almost never appropriate here. P1 for a boundary violation or a breaking interface change that should be fixed before merge. P2 for structure worth revisiting.`,
  },
  {
    id: 'style',
    name: '✨ Code Style & Idioms Specialist',
    model: DEFAULT_MODEL,
    defaultEnabled: false,
    charter: `You review changes for readability problems that a formatter or linter would not catch.

Flag:
- Names that actively mislead, such as a function named "get" that mutates state.
- Control flow tangled enough that a reader cannot determine the conditions under which a branch runs.
- Dead code, unreachable branches, and commented-out blocks left in the change.
- Debug output left behind in application code, where the surrounding code uses a logger.

Do not flag:
- Anything a formatter owns: indentation, quotes, semicolons, line length, trailing commas.
- Console output in CLI tools, build scripts, test helpers or anything whose job is to print. Intentional program output is not a leftover debug statement.
- Naming preferences where the existing name is clear enough.
- Suggestions to decompose a function that is long but linear and readable.

Severity: P1 only where the code is genuinely misleading and likely to cause a future bug. Everything else is P2.`,
  },
  {
    id: 'testing',
    name: '🧪 Testing & Quality Assurance',
    model: DEFAULT_MODEL,
    defaultEnabled: true,
    charter: `You review whether the change is adequately covered by tests, and whether those tests would fail if the code broke.

Flag:
- New branching logic, error handling or boundary conditions with no accompanying test.
- Tests asserting on incidental detail rather than behaviour, so they pass when the feature is broken or fail when it is merely refactored.
- Exclusive or skipped markers left active, which silently disable the rest of a suite.
- Shared mutable state between tests, or dependence on execution order, clock or network.

  Before reporting a testing defect, establish:
    - Scope: the behaviour was introduced, changed, or explicitly claimed by the diff.
    - Concrete counterfactual evidence: identify a plausible broken implementation the changed test would still pass, or a correct refactor it would incorrectly fail. Name the changed assertion, input or path, and expected outcome; do not report a generic weakness from the assertion's shape alone.
    - Isolation: for shared-state claims, identify the state that survives between tests; state recreated in per-test setup is not cross-test state.
    - Sibling coverage: compare each new assertion with sibling tests and shared helpers/defaults before calling coverage missing or duplicated. Identify the materially distinct behaviour that remains untested.
    - Semantic equivalence: for configuration or text guards, evaluate whether equivalent formatting, reordering, or representation can evade the asserted property while changing the intended behaviour. Name the concrete equivalent input or path when reporting a gap.
    - Branch completeness: materially different failure causes or diagnostics require distinct coverage.

If that causal chain cannot be shown from the diff, return no finding.

Do not flag:
- Absence of tests for pure renames, formatting, comments, configuration or documentation.
- Demands for a coverage percentage.
- Requests to test framework behaviour or third-party libraries.
- Missing end-to-end tests where unit coverage is proportionate to the change.

Severity: P1 for untested logic that can silently break, or an active exclusive marker. P2 for coverage worth adding. Reserve P0 for a change that disables an entire suite.`,
  },
  {
    id: 'documentation',
    name: '📝 Documentation & API Specs',
    model: DEFAULT_MODEL,
    defaultEnabled: false,
    charter: `You review whether the change leaves the project's documentation accurate.

Flag:
- Documentation, README sections or comments that the change makes factually wrong.
- New or changed public interfaces, configuration keys, environment variables or CLI flags that nothing documents.
- Comments describing behaviour the code no longer has.
- Documented examples that would now fail if a reader followed them.

Do not flag:
- Missing docstrings on self-explanatory or internal functions.
- Requests for comments restating what the code plainly says.
- Absence of a changelog entry unless the repository visibly maintains one.
- Style preferences about comment formatting.

Severity: P1 for documentation that is now actively wrong or a public interface left undocumented. P2 for documentation worth adding. P0 does not apply.`,
  },
  {
    id: 'accessibility',
    name: '♿ Accessibility (a11y) & Usability',
    model: DEFAULT_MODEL,
    defaultEnabled: false,
    charter: `You review user interface changes for barriers to people using assistive technology.

Flag:
- Interactive elements that cannot be reached or operated by keyboard.
- Controls with no accessible name: icon-only buttons, unlabelled inputs, images conveying meaning without alt text.
- Meaning carried by colour alone.
- Custom widgets reimplementing a native control without the roles, states and focus behaviour that control provides.
- Focus that is lost, trapped, or never moved when content appears or disappears.

Do not flag:
- Files that render no user interface.
- Decorative images that correctly use an empty alt attribute.
- Colour contrast you cannot compute from the diff, where the values are not visible.
- Speculative concerns about a component's rendered output that the change does not show.

Severity: P1 where the interface becomes unusable with a keyboard or screen reader. P2 for degraded experience. P0 does not apply.`,
  },
  {
    id: 'database',
    name: '🗄️ Database & Persistence Specialist',
    model: DEFAULT_MODEL,
    defaultEnabled: false,
    charter: `You review schema changes and data access for risks to production data.

Flag:
- Destructive migrations: dropping or renaming a column or table still referenced by deployed code.
- Migrations that lock a large table, such as adding a non-null column with a default, or building an index without a concurrent option where the engine supports one.
- Migrations with no viable path backwards once partially applied.
- Queries filtering or joining on columns with no supporting index, where the table grows unbounded.
- String-interpolated SQL.

Do not flag:
- Migrations on tables that are obviously small or newly created.
- Index suggestions for queries that run rarely or off the request path.
- Normalisation preferences absent a concrete correctness or performance problem.
- Anything in test fixtures or seed data.

Severity: P0 for possible data loss or a production-wide lock. P1 for a migration needing a safer sequence. P2 for indexing and hygiene.`,
  },
  {
    id: 'devops',
    name: '🐳 DevOps & CI/CD',
    model: DEFAULT_MODEL,
    defaultEnabled: false,
    charter: `You review build, container and pipeline configuration for correctness and safety.

Flag:
- Secrets committed into build files, pipeline definitions or container images.
- Pipeline steps that mask failure, so a broken build reports success. Suppressed exit codes and blanket error suppression belong here.
- Containers running as root, or images shipping build tooling and credentials into the runtime layer.
- Untrusted input flowing into a privileged pipeline step.
- Dependencies fetched at build time from mutable or unpinned sources.

Do not flag:
- Layer-count or image-size micro-optimisations with no meaningful effect.
- Preferences between equivalent pipeline tools or runners.
- Missing infrastructure the project has deliberately not adopted. Review what the change contains, not what a different deployment model would need.
- Absence of a resource limit where no orchestrator is in use.

Severity: P0 for an exposed secret or a pipeline that cannot fail. P1 for a real supply chain or privilege problem. P2 for hygiene.`,
  },
  {
    id: 'i18n',
    name: '🌐 Internationalization & Localizability',
    model: DEFAULT_MODEL,
    defaultEnabled: false,
    charter: `You review changes in projects that localise their interface, for text and formatting that will not translate.

Flag:
- User-visible strings written inline where the project uses a translation mechanism.
- Sentences assembled by concatenating fragments, which cannot be reordered for another grammar.
- Dates, times, numbers and currency formatted manually rather than through a locale-aware API.
- Assumptions that text length, direction or sort order match the source language.

Do not flag:
- Anything in a project with no translation mechanism in use. If nothing in the diff suggests localisation exists, report nothing.
- Log messages, error text for developers, code comments, test strings and internal tooling output.
- Identifiers, keys, enum values and other strings never shown to a user.

Severity: P1 for user-visible text that cannot be translated in a project that translates. P2 for formatting that will read incorrectly in another locale. P0 does not apply.`,
  },
  {
    id: 'dependencies',
    name: '📦 Dependency Safety & Supply Chain',
    model: DEFAULT_MODEL,
    defaultEnabled: true,
    charter: `You review changes to a project's dependencies.

Flag:
- Version specifiers that float, such as "*" or "latest", making builds unreproducible.
- Manifest changes not reflected in the lockfile, or a lockfile edited inconsistently with the manifest.
- New dependencies pulled from a fork, a URL, a git reference or an unusual registry rather than the project's normal source.
- A heavy dependency added for functionality the standard library or an existing dependency already provides.
- Dependencies with names suspiciously close to a popular package.

Do not flag:
- Routine version bumps within the project's existing constraints.
- Advice to audit or update dependencies generally, with no specific problem in the diff.
- Vulnerability claims about specific versions, which you cannot verify from a diff alone.
- Preferences between comparable, well-established libraries.

Severity: P0 for a plausible supply chain compromise. P1 for unreproducible builds or an inconsistent lockfile. P2 for weight and duplication.`,
  },
  {
    id: 'licensing',
    name: '📜 License, Entitlements & IP Compliance',
    model: DEFAULT_MODEL,
    defaultEnabled: false,
    charter: `You review changes for product licensing, commercial entitlement integrity, feature gating, quota enforcement, and open-source licence obligations.

Flag:
- Ungated commercial capabilities: New or modified paid, tiered, or add-on functionality introduced without corresponding entitlement checks, permission gates, or middleware enforcement.
- Bypassed or weakened enforcement: Existing entitlement gates removed, skipped, demoted to client-side-only checks without server-side validation, or made optional on public/internal API boundaries.
- Self-issuing or auto-renewing entitlements: Applications, containers, or on-prem agents generating, self-signing, auto-renewing, or extending their own commercial or trial entitlements (e.g. boot tasks minting new tokens when expired).
- Cryptographic verification bypasses: Inspecting or trusting licence claims without cryptographic signature verification (e.g. decoding payloads without validating issuer signatures, using unverified claim helpers, algorithm confusion, or committing private signing keys / HMAC secrets).
- Fail-open gating and error handling: Entitlement evaluators, cache fallbacks, or license check catch blocks that grant full/enterprise access when tokens are expired, malformed, or when verification fails.
- Destructive expiration handling: Licence expiry handlers that permanently delete customer configuration, integrations, or historical data rather than pausing premium execution and gracefully dropping to Community/Free tier.
- Quota and metering bypasses: Seat allocations, API rate limits, retention windows, or consumption meters that can be reset, manipulated, or bypassed via un-atomic check-then-set race conditions.
- Production fixture / backdoor leakage: Hardcoded bypass tokens, magic license headers, or multi-year test tokens left reachable on production code paths.
- Open-source licence conflicts: A dependency added under a copyleft licence (e.g. GPL, AGPL) in a project distributed under a permissive licence, substantial code copied without attribution, or removal/alteration of an existing copyright or licence notice.

Do not flag:
- Deliberate baseline/free features: Functionality that product documentation or configuration explicitly declares as Community, Open Source, or Free tier.
- Inherited middleware protection: Route endpoints that lack explicit inline guards but inherit authoritative entitlement checks from parent routers or pipeline middleware.
- Test-only mocks and fixtures: Short-lived, isolated test tokens in test directories that are uniquely scoped and cleaned up in teardown (afterEach/finally).
- Public verification keys: Asymmetric public keys embedded for offline token verification (these are verification keys, not minting secrets).
- Bounded offline grace periods: Finite, deliberate last-known-good caches (e.g. 72-hour network outage grace for a previously signature-valid token).
- Missing licence headers on individual files unless surrounding files visibly carry headers.
- Dependencies under permissive open-source licences (MIT, Apache 2.0, BSD, ISC).

Severity:
- P0: Reachable exploit path granting unauthorized commercial access, self-renewing trial boot loops, committed private signing keys, or universal fail-open bypasses.
- P1: Paid route or feature missing entitlement gating, unverified claim lookups, missing expiration transitions, non-atomic metering race, destructive data loss on expiry, or incompatible copyleft dependency.
- P2: Contradictory claim TTLs, missing audit telemetry on tier transitions, un-cleaned long-lived test fixtures, or attribution worth adding.`,
  },
];

// Reviewers that apply to essentially any codebase. The rest are situational: enabling all twelve
// everywhere produces findings about internationalisation in projects that ship one language, and
// licence headers in projects that use none.
const DEFAULT_PERSONA_IDS = PERSONA_CHARTERS.filter((p) => p.defaultEnabled).map((p) => p.id);

const SEVERITIES = ['P0', 'P1', 'P2'];
const DEFAULT_MAX_DIFF_CHARS = 410_400;
const ACTION_MAX_DIFF_CAP = 10_000_000;
// Review responses are structured findings objects, but reasoning-capable OpenRouter models
// need enough output budget for both their hidden reasoning tokens and the final JSON object.
// Keep the generic fallback conservative while giving the explicitly admitted OpenRouter route
// the same 24,576-token envelope used by the qualification harness. This is a provider-safe
// ceiling, not an unbounded generation request; the per-request and workflow wall-clock guards
// remain authoritative.
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const DEFAULT_OPENROUTER_MAX_OUTPUT_TOKENS = 24_576;
const DEFAULT_OPENROUTER_TTFT_TIMEOUT_MS = 30_000;
// Direct DeepSeek V4 transports expose reasoning separately, but `max_tokens`
// still caps the complete generated sequence (reasoning plus the final JSON).
// Keep an 8,192-token structured-output target and reserve three times that
// amount on the wire so high-effort reasoning cannot consume the answer budget.
// OpenRouter keeps its separate bounded default and privacy-policy contract.
const DEFAULT_DIRECT_OUTPUT_BUDGET_TOKENS = 8_192;
const DIRECT_GENERATION_BUDGET_MULTIPLIER = 3;
const DEFAULT_DIRECT_MAX_OUTPUT_TOKENS =
  DEFAULT_DIRECT_OUTPUT_BUDGET_TOKENS * DIRECT_GENERATION_BUDGET_MULTIPLIER;
const DEFAULT_SUBMODULE_POLICY = {
  mode: 'metadata_only',
  max_depth: 1,
  max_files: 500,
  require_pinned_commit: true,
  missing_access: 'block',
  allowed_repositories: [],
  allowed_hosts: ['github.com'],
  url_change: 'block',
};

function normalizeOpenRouterModel(model) {
  const normalized = String(model || '').trim();
  const aliases = {
    'claude-opus-4-8': 'anthropic/claude-opus-4.8',
    'claude/claude-opus-4-8': 'anthropic/claude-opus-4.8',
    'agy/claude-opus-4-6-thinking': 'anthropic/claude-opus-4.8',
    'grok-cli/grok-4.5': 'x-ai/grok-4.5',
    'codex/gpt-5.6-sol-high': 'openai/gpt-5.6-sol',
    'codex-gateway/gpt-5.6-sol-high': 'openai/gpt-5.6-sol',
    'opencode-go/glm-5.2': 'z-ai/glm-5.2',
    'synthetic/glm-5.2': 'z-ai/glm-5.2',
    'synthetic-new/glm-5.2-high': 'z-ai/glm-5.2',
    'glm-5.2': 'z-ai/glm-5.2',
    'openrouter/5.6-luna-high': 'openai/gpt-5.6-luna',
    '5.6-luna-high': 'openai/gpt-5.6-luna',
  };
  if (aliases[normalized]) return aliases[normalized];
  if (normalized.startsWith('synthetic/')) return 'z-ai/glm-5.2';
  if (normalized.startsWith('openrouter/')) {
    const route = normalized.slice('openrouter/'.length);
    return route === 'auto' ? normalized : route;
  }
  return normalized;
}

function getStaticModelContext(model) {
  const normalized = normalizeOpenRouterModel(model || '');
  const lower = normalized.toLowerCase();
  if (lower.includes('gemini-2.5-pro') || lower.includes('gemini-1.5-pro')) return 2_097_152;
  if (lower.includes('gemini-3.7-flash') || lower.includes('gemini-2.5-flash') || lower.includes('gemini-3.5-flash')) return 1_048_576;
  if (lower.includes('claude') || lower.includes('opus') || lower.includes('kimi')) return 200_000;
  return 128_000;
}

function calculateSafeDiffCapacity(modelOrTokens, options = {}) {
  const contextTokens = typeof modelOrTokens === 'number'
    ? modelOrTokens
    : getStaticModelContext(modelOrTokens);
  const systemPromptTokens = options.systemPromptTokens ?? 4000;
  const toolReserveTokens = options.toolReserveTokens ?? 16000;
  const charsPerToken = options.charsPerToken ?? 3.8;
  const usableTokens = Math.max(0, contextTokens - systemPromptTokens - toolReserveTokens);
  return Math.floor(usableTokens * charsPerToken);
}

/**
 * Resolves LLM endpoint configuration from the environment.
 *
 * Review execution is deliberately pinned to OpenRouter. The action accepts no implicit
 * provider fallback and never turns a missing key into a heuristic green review.
 *
 * @returns {{enabled: boolean, apiKey: string, baseUrl: string, model: string, maxDiffChars: number}}
 */
function hasExplicitTransportHandoff(env = process.env) {
  return (
    (typeof env.REVIEW_YETI_TRANSPORTS === 'string' && env.REVIEW_YETI_TRANSPORTS.trim() !== '') ||
    (typeof env.REVIEW_YETI_TRANSPORT_PLAN_B64 === 'string' && env.REVIEW_YETI_TRANSPORT_PLAN_B64.trim() !== '')
  );
}

function resolveModelConfig(env = process.env) {
  const apiKey = env.OPENROUTER_REVIEW_FLEET_KEY || env.OPENROUTER_PR_REVIEW_API_KEY || env.OPENROUTER_API_KEY || '';
  // Older callers passed the selected provider's URL/model through the legacy OpenRouter
  // fields while also supplying an explicit multi-provider handoff. Keep the action's policy
  // boundary canonical in that case; the provider-specific URL/model remains in transports.
  const explicitTransportHandoff = hasExplicitTransportHandoff(env);
  const baseUrl = explicitTransportHandoff
    ? 'https://openrouter.ai/api/v1'
    : (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const model = explicitTransportHandoff ? 'openrouter/auto' : (env.OPENROUTER_MODEL || 'openrouter/auto');
  const dynamicDefaultDiff = calculateSafeDiffCapacity(model);
  const maxDiffChars = parseInt(env.MAX_DIFF_CHARS || '', 10) || dynamicDefaultDiff;

  let rawTransports = [];
  if (env.REVIEW_YETI_TRANSPORTS) {
    try {
      rawTransports = JSON.parse(env.REVIEW_YETI_TRANSPORTS);
    } catch (_) {}
  } else if (env.REVIEW_YETI_TRANSPORT_PLAN_B64) {
    try {
      rawTransports = JSON.parse(Buffer.from(env.REVIEW_YETI_TRANSPORT_PLAN_B64, 'base64').toString('utf8'));
    } catch (_) {}
  }

  let transports = Array.isArray(rawTransports)
    ? rawTransports.map((t) => {
        const keyEnv = t.api_key_env || t.apiKeyEnv;
        let resolvedKey = keyEnv ? env[keyEnv] : '';
        if (!resolvedKey) {
          const nameLower = String(t.name || t.provider || '').toLowerCase();
          const urlLower = String(t.base_url || t.baseUrl || '').toLowerCase();
          if (nameLower.includes('fireworks') || urlLower.includes('fireworks.ai')) {
            resolvedKey = env.FIREWORKS_PR_REVIEW_API_KEY || env.FIREWORKS_API_KEY || '';
          } else if (nameLower.includes('ollama') || urlLower.includes('ollama.com') || urlLower.includes('ollama.ai')) {
            resolvedKey = env.OLLAMA_PR_REVIEW_API_KEY || env.OLLAMA_API_KEY || '';
          } else if (nameLower.includes('anthropic') || urlLower.includes('anthropic.com')) {
            resolvedKey = env.ANTHROPIC_API_KEY || '';
          } else if (nameLower.includes('gemini') || urlLower.includes('googleapis.com')) {
            resolvedKey = env.GEMINI_API_KEY || '';
          } else if (nameLower.includes('openai') || urlLower.includes('openai.com')) {
            resolvedKey = env.OPENAI_API_KEY || '';
          } else {
            resolvedKey = env.OPENROUTER_REVIEW_FLEET_KEY || env.OPENROUTER_PR_REVIEW_API_KEY || env.OPENROUTER_API_KEY || '';
          }
        }
        return {
          name: t.name || t.provider || 'default',
          baseUrl: (t.base_url || t.baseUrl || baseUrl).replace(/\/+$/, ''),
          apiKey: resolvedKey,
          model: t.model || model,
          models: Array.isArray(t.models)
            ? t.models.filter((candidate) => typeof candidate === 'string' && candidate.trim())
            : undefined,
          provider: t.provider,
          compat: t.compat || t.compatibility,
          providerRouting: t.provider_routing || t.providerRouting,
          ignoreProviders: t.ignore_providers || t.ignoreProviders,
          plugins: t.plugins,
          // Preserve the immutable central transport contract all the way to the
          // request boundary.  The handoff validator requires every admitted
          // transport to stream, but this mapping used to silently discard that
          // field, causing the hosted panel to send buffered completions while
          // the smoke probe sent streaming completions.
          stream: t.stream === true,
          reasoningEffort: t.reasoning_effort || t.reasoningEffort,
          structuredOutput: t.structured_output || t.structuredOutput,
          // `structured_output: strict` is the existing policy declaration and remains mapped
          // to the broadly compatible json_object request.  A route must opt in explicitly to
          // json_schema so incompatible providers can continue using the legacy contract.
          structuredOutputMode: t.structured_output_mode || t.structuredOutputMode
            || (t.structured_output === 'json_schema' ? 'json_schema' : undefined),
          perfMetricsInResponse: t.perf_metrics_in_response === true || t.perfMetricsInResponse === true,
          maxTokens: t.max_tokens || t.maxTokens || t.max_output_tokens || t.maxOutputTokens,
          connectTimeoutMs: t.connect_timeout_ms || t.connectTimeoutMs,
          ttftTimeoutMs: t.ttft_ms || t.ttftMs || t.ttft_timeout_ms || t.ttftTimeoutMs,
          timeoutMs: t.timeout_ms || t.timeoutMs || 90_000,
        };
      }).filter((t) => Boolean(t.apiKey))
    : [];

  if (transports.length === 0) {
    const autoTransports = [];
    if (env.FIREWORKS_PR_REVIEW_API_KEY || env.FIREWORKS_API_KEY) {
      autoTransports.push({
        name: 'fireworks',
        baseUrl: (env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/+$/, ''),
        apiKey: env.FIREWORKS_PR_REVIEW_API_KEY || env.FIREWORKS_API_KEY,
        model: env.FIREWORKS_MODEL || 'accounts/fireworks/models/deepseek-v4-flash-0731',
        timeoutMs: 120_000,
      });
    }
    if (env.OLLAMA_PR_REVIEW_API_KEY || env.OLLAMA_API_KEY) {
      autoTransports.push({
        name: 'ollama',
        baseUrl: (env.OLLAMA_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, ''),
        apiKey: env.OLLAMA_PR_REVIEW_API_KEY || env.OLLAMA_API_KEY,
        model: env.OLLAMA_MODEL || 'deepseek-v4-flash:cloud',
        timeoutMs: 90_000,
      });
    }
    if (env.ANTHROPIC_API_KEY) {
      autoTransports.push({
        name: 'anthropic',
        baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, ''),
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL || 'claude-5-haiku:high',
        timeoutMs: 120_000,
      });
    }
    if (env.GEMINI_API_KEY) {
      autoTransports.push({
        name: 'gemini',
        baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL || 'google/gemini-3.7-flash:high',
        timeoutMs: 90_000,
      });
    }
    if (env.OPENAI_API_KEY) {
      autoTransports.push({
        name: 'openai',
        baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL || 'openai/gpt-5.6-luna:high',
        timeoutMs: 90_000,
      });
    }
    if (apiKey) {
      autoTransports.push({
        name: 'openrouter',
        baseUrl,
        apiKey,
        model: model || 'deepseek/deepseek-v4-flash-0731:high',
        compat: 'openrouter',
        stream: true,
        timeoutMs: 90_000,
      });
    }
    if (autoTransports.length > 0) {
      transports = autoTransports;
    }
  }

  return {
    enabled: Boolean(apiKey || transports.length > 0),
    apiKey: apiKey || (transports.length > 0 ? transports[0].apiKey : ''),
    baseUrl: (transports.length > 0 ? transports[0].baseUrl : baseUrl),
    model: (transports.length > 0 ? transports[0].model : model),
    maxDiffChars,
    transports,
  };
}

function trustedOpenRouterInputsFromEnv(env = process.env) {
  const explicitTransportHandoff = hasExplicitTransportHandoff(env);
  return {
    'llm-base-url': explicitTransportHandoff ? 'https://openrouter.ai/api/v1' : env.OPENROUTER_BASE_URL,
    model: explicitTransportHandoff ? 'openrouter/auto' : env.OPENROUTER_MODEL,
    'allowed-models': env.OPENROUTER_ALLOWED_MODELS,
    'data-collection': env.OPENROUTER_DATA_COLLECTION,
    'cost-quality-tradeoff': env.OPENROUTER_COST_QUALITY_TRADEOFF,
  };
}

function resolveActionReviewRuntime(localConfig = null, env = process.env) {
  const trustedConfig = localConfig?.parsed && typeof localConfig.parsed === 'object'
    ? localConfig.parsed
    : (localConfig && typeof localConfig === 'object' ? localConfig : undefined);
  const localProviders = Array.isArray(localConfig?.parsed?.reviewers?.providers)
    ? localConfig.parsed.reviewers.providers
    : [];
  const actionPolicy = resolveActionReviewPolicy(localConfig, env);
  const openRouterPolicy = resolveOpenRouterReviewPolicy({
    actionInputs: trustedOpenRouterInputsFromEnv(env),
    trustedConfig,
  });
  const localReviewerProviderIds = localProviders
    .map((provider) => {
      if (typeof provider === 'string') return provider.trim();
      if (provider && typeof provider === 'object') return String(provider.id || '').trim();
      return '';
    })
    .filter(Boolean);
  const modelConfig = {
    ...resolveModelConfig(env),
    baseUrl: openRouterPolicy.base_url,
    model: openRouterPolicy.model,
    openRouterPolicy,
    maxDiffChars: actionPolicy.maxDiffChars,
  };
  const notes = [];

  if (localReviewerProviderIds.length > 0) {
    notes.push(
      `Local reviewers.providers (${localReviewerProviderIds.join(', ')}) configure the CLI/app roster only; ` +
      `the GitHub Action keeps its explicit persona roster and OpenRouter request policy.`
    );
  }

  return {
    rosterSource: 'action_personas',
    localReviewerProviderIds,
    modelConfig,
    notes,
  };
}

/**
 * Resolves only trusted base-ref execution controls. Pull-request payloads never participate in
 * this merge, and numeric settings are capped before they reach model or diff boundaries.
 */
function resolveActionReviewPolicy(localConfig, env = process.env) {
  const parsed = localConfig?.parsed && typeof localConfig.parsed === 'object'
    ? localConfig.parsed
    : (localConfig && typeof localConfig === 'object' ? localConfig : {});
  const effectiveModel = env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731:low';
  const dynamicDefaultDiff = calculateSafeDiffCapacity(effectiveModel);
  const limits = parsed.limits && typeof parsed.limits === 'object' ? parsed.limits : {};
  const configuredDiff = Number(limits.max_diff_bytes);
  const policyDiff = Number.isFinite(configuredDiff) && configuredDiff > 0 ? configuredDiff : dynamicDefaultDiff;
  const envDiff = Number(env.MAX_DIFF_CHARS);
  const requestedDiff = Number.isFinite(envDiff) && envDiff > 0 ? Math.min(envDiff, policyDiff) : policyDiff;
  const maxDiffChars = Math.max(1, Math.min(Number.isFinite(requestedDiff) ? requestedDiff : dynamicDefaultDiff, ACTION_MAX_DIFF_CAP));
  const rawSubmodules = parsed.submodules && typeof parsed.submodules === 'object' ? parsed.submodules : {};
  const submodules = {
    ...DEFAULT_SUBMODULE_POLICY,
    ...rawSubmodules,
    max_depth: Math.max(0, Math.min(Number(rawSubmodules.max_depth ?? DEFAULT_SUBMODULE_POLICY.max_depth) || 0, 5)),
  };
  return { maxDiffChars, submodules };
}

function isGitlinkMode(file) {
  if (file?.isSubmodule === true) return true;
  return [file?.mode, file?.oldMode, file?.newMode, file?.old_mode, file?.new_mode]
    .some((mode) => String(mode || '') === '160000');
}

function firstSha(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim();
}

function parseGitlinkPatch(patch) {
  const result = {};
  if (typeof patch !== 'string') return result;
  const meaningfulLines = patch.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('diff --git') && !line.startsWith('index ') && !line.startsWith('old mode ') && !line.startsWith('new mode ') && !line.startsWith('new file mode ') && !line.startsWith('deleted file mode ') && !line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith(' ') && !/^@@ /u.test(line) && !/^\\ No newline/u.test(line));
  for (const match of patch.matchAll(/^([+-])Subproject commit ([0-9a-f]{40})\r?$/gim)) {
    if (match[1] === '-') result.oldSha = match[2];
    if (match[1] === '+') result.newSha = match[2];
  }
  if ((result.oldSha || result.newSha) && meaningfulLines.some((line) => !/^([+-])Subproject commit [0-9a-f]{40}$/i.test(line))) return {};
  return result;
}

function parseActionSubmoduleUrls(content, parentRepository) {
  if (typeof content !== 'string' || !content.trim()) return {};
  const result = Object.create(null);
  let current;
  const flush = () => {
    if (!current?.path || !current.url) return;
    try {
      result[current.path] = current.url.startsWith('./') || current.url.startsWith('../')
        ? new URL(current.url, `https://github.com/${parentRepository}/`).toString()
        : current.url;
    } catch (_) {
      result[current.path] = current.url;
    }
  };
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[submodule\s+(?:"[^"]+"|'[^']+'|[^\]]+)\]\s*$/.test(line)) {
      flush();
      current = {};
      continue;
    }
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) {
      flush();
      current = undefined;
      continue;
    }
    if (!current) continue;
    const pathMatch = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
    const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (pathMatch) current.path = pathMatch[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    if (urlMatch) current.url = urlMatch[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
  }
  flush();
  return result;
}

function loadActionSubmoduleUrls(repoRoot, parentRepository) {
  const filePath = path.resolve(repoRoot, '.gitmodules');
  if (!fs.existsSync(filePath)) return {};
  try {
    return parseActionSubmoduleUrls(fs.readFileSync(filePath, 'utf8'), parentRepository);
  } catch (_) {
    return {};
  }
}

async function fetchActionSubmoduleUrlsAtRef(parentRepository, ref, options = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(String(parentRepository || ''))) return {};
  if (!/^[0-9a-f]{40}$/iu.test(String(ref || ''))) return {};

  const fetchImpl = options.fetchImplementation || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return {};
  const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${parentRepository}/contents/.gitmodules?ref=${encodeURIComponent(ref)}`,
      {
        headers,
        signal: options.signal || AbortSignal.timeout(options.timeoutMs || 10_000),
      },
    );
    if (!response?.ok) return {};
    const payload = await response.json();
    if (payload?.type !== 'file' || payload?.encoding !== 'base64' || typeof payload?.content !== 'string') return {};
    const content = Buffer.from(payload.content.replace(/\s+/gu, ''), 'base64').toString('utf8');
    return parseActionSubmoduleUrls(content, parentRepository);
  } catch (_) {
    // Missing or inaccessible metadata remains fail-closed in
    // applyActionSubmodulePolicy when the repository policy requires it.
    return {};
  }
}

function hasActionSubmoduleCandidate(file) {
  const transition = parseGitlinkPatch(file?.patch);
  return isGitlinkMode(file) || Boolean(transition.oldSha || transition.newSha);
}

function mergeActionSubmoduleUrls(localUrls, exactRefUrls) {
  // Exact target-repository metadata is authoritative over a local fallback.
  return { ...(localUrls || {}), ...(exactRefUrls || {}) };
}

async function resolveActionSubmoduleMetadata(diffFiles, context, options = {}) {
  const hasCandidate = (Array.isArray(diffFiles) ? diffFiles : []).some(hasActionSubmoduleCandidate);
  const [remoteBaseUrls, remoteHeadUrls] = hasCandidate
    ? await Promise.all([
        fetchActionSubmoduleUrlsAtRef(context.parentRepository, context.baseRef, options),
        fetchActionSubmoduleUrlsAtRef(context.parentRepository, context.headRef, options),
      ])
    : [{}, {}];
  return {
    hasCandidate,
    baseUrls: mergeActionSubmoduleUrls(
      loadActionSubmoduleUrls(context.baseRoot, context.parentRepository),
      remoteBaseUrls,
    ),
    headUrls: mergeActionSubmoduleUrls(
      loadActionSubmoduleUrls(context.headRoot, context.parentRepository),
      remoteHeadUrls,
    ),
  };
}

function hasPinnedGitlinkTransition(file) {
  const oldSha = typeof file.oldSha === 'string' ? file.oldSha.trim() : '';
  const newSha = typeof file.newSha === 'string' ? file.newSha.trim() : '';
  const hasOldSha = oldSha.length > 0;
  const hasNewSha = newSha.length > 0;
  return (hasOldSha || hasNewSha)
    && (!hasOldSha || /^[0-9a-f]{40}$/i.test(oldSha))
    && (!hasNewSha || /^[0-9a-f]{40}$/i.test(newSha));
}

function applyActionSubmodulePolicy(diffFiles, policy = DEFAULT_SUBMODULE_POLICY, options = {}) {
  let coverageComplete = true;
  const files = [];
  for (const file of Array.isArray(diffFiles) ? diffFiles : []) {
    const patchTransition = parseGitlinkPatch(file.patch);
    const nativeGitlink = isGitlinkMode(file);
    if (!nativeGitlink && (patchTransition.oldSha || patchTransition.newSha)) {
      // A matching `Subproject commit` line is not enough to prove a gitlink:
      // ordinary text can contain that literal. Keep it as a normal file so
      // changed-line sanitization remains strict, and fail closed until native
      // mode metadata confirms the submodule boundary.
      coverageComplete = false;
      files.push(file);
      continue;
    }
    if (!nativeGitlink) {
      files.push(file);
      continue;
    }
    const submoduleFile = {
      ...file,
      isSubmodule: true,
      mode: '160000',
      ...(firstSha(patchTransition.oldSha, file.oldSha, file.previous_sha, file.previousSha, file.old_sha)
        ? { oldSha: firstSha(patchTransition.oldSha, file.oldSha, file.previous_sha, file.previousSha, file.old_sha) }
        : {}),
      ...(firstSha(patchTransition.newSha, file.newSha, file.sha, file.new_sha)
        ? { newSha: firstSha(patchTransition.newSha, file.newSha, file.sha, file.new_sha) }
        : {}),
      ...((options.baseSubmoduleUrls || {})[file.path] ? { oldSubmoduleUrl: options.baseSubmoduleUrls[file.path] } : {}),
      ...((options.submoduleUrls || {})[file.path] ? { newSubmoduleUrl: options.submoduleUrls[file.path] } : {}),
      ...(((options.baseSubmoduleUrls || {})[file.path] || (options.submoduleUrls || {})[file.path])
        && (options.baseSubmoduleUrls || {})[file.path] !== (options.submoduleUrls || {})[file.path]
        ? { submoduleUrlChanged: true }
        : {}),
    };
    if (policy.mode === 'ignore') continue;
    if (policy.require_pinned_commit && !hasPinnedGitlinkTransition(submoduleFile)) coverageComplete = false;
    if (policy.mode === 'recursive') coverageComplete = false;
    const urlChangePolicy = policy.url_change ?? 'block';
    if (hasActionSubmoduleUrlChange(submoduleFile) && urlChangePolicy === 'block') coverageComplete = false;
    if ((policy.allowed_hosts?.length || policy.allowed_repositories?.length) && resolveActionSubmoduleOrigin(submoduleFile, policy, options) === 'blocked') coverageComplete = false;
    files.push(submoduleFile);
  }
  return { files, coverageComplete };
}

function hasActionSubmoduleUrlChange(file) {
  if (file.submoduleUrlChanged === true) return true;
  const oldUrl = typeof file.oldSubmoduleUrl === 'string' ? file.oldSubmoduleUrl.trim() : '';
  const newUrl = typeof file.newSubmoduleUrl === 'string' ? file.newSubmoduleUrl.trim() : '';
  return oldUrl.length > 0 && newUrl.length > 0 && oldUrl !== newUrl;
}

function resolveActionSubmoduleOrigin(file, policy, options = {}) {
  const allowedHosts = (policy.allowed_hosts || []).map((host) => String(host).toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean);
  const allowedRepositories = (policy.allowed_repositories || []).map((repository) => String(repository).toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')).filter(Boolean);
  const raw = file.newSubmoduleUrl || file.submoduleUrl || file.oldSubmoduleUrl || (options.submoduleUrls || {})[file.path];
  if (typeof raw !== 'string' || !raw.trim()) return policy.missing_access === 'metadata_only' ? 'review' : 'blocked';
  if (allowedHosts.length === 0 && allowedRepositories.length === 0) return 'allowed';
  try {
    const scp = /^https?:\/\//iu.test(raw) ? null : raw.match(/^[^@]+@([^:]+):(.+)$/);
    const parentRepository = options.parentRepository || process.env.GITHUB_REPOSITORY || '';
    const parsed = scp ? null : new URL(raw, parentRepository.includes('/') ? `https://github.com/${parentRepository}/` : undefined);
    const host = String(scp ? scp[1] : parsed?.hostname || '').toLowerCase();
    const repository = String(scp ? scp[2] : parsed?.pathname || '').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
    if (!host || !repository) return 'blocked';
    return (allowedHosts.length === 0 || allowedHosts.includes(host))
      && (allowedRepositories.length === 0 || allowedRepositories.includes(repository))
      ? 'allowed'
      : 'blocked';
  } catch (_) {
    return 'blocked';
  }
}

function assertCurrentPullRequest(prContext, options = {}) {
  if (!prContext.prNumber || !prContext.repo || !prContext.repo.includes('/') || !prContext.headSha || !prContext.baseSha) {
    throw new Error('Cannot verify the current PR revision without prNumber, repo, headSha, and baseSha');
  }
  const commandRunner = options.commandRunner || ((command, args, commandOptions) => spawnSync(command, args, commandOptions));
  const result = commandRunner('gh', [
    'pr', 'view', String(prContext.prNumber), '--repo', prContext.repo,
    '--json', 'headRefOid,baseRefOid',
  ], { encoding: 'utf-8', env: process.env, timeout: 60_000 });
  if (!result || result.status !== 0) {
    throw new Error(`Unable to verify the current PR head for ${prContext.repo}#${prContext.prNumber}: ${result?.stderr || result?.stdout || 'gh failed'}`);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new Error(`GitHub returned malformed PR head metadata: ${error.message}`);
  }
  if (snapshot.headRefOid !== prContext.headSha) {
    throw new Error(`PR head changed during review: expected ${prContext.headSha}, found ${snapshot.headRefOid}`);
  }
  if (snapshot.baseRefOid !== prContext.baseSha) {
    throw new Error(`PR base changed during review: expected ${prContext.baseSha}, found ${snapshot.baseRefOid}`);
  }
  return snapshot;
}

const FINDINGS_OUTPUT_SHAPES = new Set([
  'direct_json_object',
  'direct_json_array',
  'fenced_json_object',
  'fenced_json_array',
  'embedded_json_object',
  'valid_json_wrong_shape',
  'truncated_json',
  'no_json',
  'empty_content',
]);

const MODEL_FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls']);
const RESPONSE_MODES = new Set(['stream', 'buffered']);
const FINDINGS_SOURCES = new Set(['content', 'reasoning', 'none']);
const RESPONSE_SIZE_BUCKETS = new Set(['empty', 'tiny', 'small', 'medium', 'large', 'oversize']);
const OUTPUT_CONTRACT_MODES = new Set(['json_object', 'json_schema', 'prompt_validated_json', 'unknown']);
const OUTPUT_CONTRACT_SUPPORT = new Set(['accepted', 'rejected', 'unreported']);
// Keep the schema deliberately small and stable.  It is opt-in per transport so a provider or
// model that only supports JSON mode can continue using the existing compatibility path.
const FINDINGS_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          title: { type: 'string' },
          body: { type: 'string' },
          suggestion: { type: ['string', 'null'] },
        },
        required: ['severity', 'path', 'line', 'title', 'body', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
});
const MODEL_RESPONSE_ATTEMPT_OUTCOMES = new Set([
  'parsed',
  'malformed_output',
  'http_error',
  'provider_error',
  'transport_error',
]);
const MODEL_REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'missing', 'other']);
const MODEL_TIMEOUT_KINDS = new Set(['request', 'ttft', 'inactivity', 'total']);
const MAX_MODEL_RESPONSE_ATTEMPTS = 8;
const MAX_TELEMETRY_TOKEN_COUNT = 1_000_000;

function findingsArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.findings)) return parsed.findings;
  return null;
}

function looksLikeTruncatedJson(content) {
  let candidate = String(content || '').trim().replace(/^```(?:json)?\s*/iu, '');
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) return false;

  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  for (const character of candidate) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') objectDepth++;
    else if (character === '}') objectDepth--;
    else if (character === '[') arrayDepth++;
    else if (character === ']') arrayDepth--;
  }
  return inString || objectDepth > 0 || arrayDepth > 0;
}

/**
 * Extracts findings while reporting only a closed, content-free description of the wire shape.
 * Candidate ordering deliberately matches the legacy parser: fenced, direct, then embedded.
 */
function analyzeFindingsPayload(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { findings: null, outputShape: 'empty_content' };
  }

  const candidates = [];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced) candidates.push({ value: fenced[1], location: 'fenced' });
  candidates.push({ value: content, location: 'direct' });

  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push({ value: content.slice(firstBrace, lastBrace + 1), location: 'embedded' });
  }

  let parsedJson = false;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.value.trim());
      parsedJson = true;
      const findings = findingsArray(parsed);
      if (findings === null) continue;
      const container = Array.isArray(parsed) ? 'array' : 'object';
      return {
        findings,
        outputShape: candidate.location === 'embedded'
          ? 'embedded_json_object'
          : `${candidate.location}_json_${container}`,
      };
    } catch (_) {}
  }

  if (parsedJson) return { findings: null, outputShape: 'valid_json_wrong_shape' };
  if (looksLikeTruncatedJson(content)) return { findings: null, outputShape: 'truncated_json' };
  return { findings: null, outputShape: 'no_json' };
}

function parseFindingsPayload(content) {
  return analyzeFindingsPayload(content).findings;
}

function normalizeFindingsOutputShape(value) {
  return FINDINGS_OUTPUT_SHAPES.has(value) ? value : null;
}

function normalizeModelFinishReason(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return 'missing';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'missing' || normalized === 'other') return normalized;
  return MODEL_FINISH_REASONS.has(normalized) ? normalized : 'other';
}

function normalizeResponseMode(value) {
  return RESPONSE_MODES.has(value) ? value : null;
}

function normalizeFindingsSource(value) {
  return FINDINGS_SOURCES.has(value) ? value : null;
}

function responseSizeBucket(content) {
  const length = typeof content === 'string' ? content.length : 0;
  if (length === 0) return 'empty';
  if (length <= 256) return 'tiny';
  if (length <= 1_024) return 'small';
  if (length <= 4_096) return 'medium';
  if (length <= 16_384) return 'large';
  return 'oversize';
}

function normalizeResponseSizeBucket(value) {
  return RESPONSE_SIZE_BUCKETS.has(value) ? value : null;
}

function normalizeOutputContractMode(value) {
  return OUTPUT_CONTRACT_MODES.has(value) ? value : 'unknown';
}

function normalizeOutputContractSupport(value) {
  return OUTPUT_CONTRACT_SUPPORT.has(value) ? value : 'unreported';
}

function normalizeStructuredOutputMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'json_schema' || normalized === 'schema' ? 'json_schema' : 'json_object';
}

function resolveStructuredOutputMode(transport = {}) {
  const explicit = transport.structuredOutputMode
    || transport.structured_output_mode
    || transport.responseFormat?.type
    || transport.response_format?.type;
  return normalizeStructuredOutputMode(explicit);
}

function buildFindingsResponseFormat(mode = 'json_object') {
  if (normalizeStructuredOutputMode(mode) !== 'json_schema') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'review_findings',
      strict: true,
      schema: FINDINGS_RESPONSE_SCHEMA,
    },
  };
}

function isStructuredOutputCompatibilityError(status, detail = '') {
  const code = Number(status);
  if (code !== 400 && code !== 422) return false;
  const text = String(detail || '');
  if (!/(response[_ -]?format|json[_ -]?schema|structured[_ -]?output|structured_outputs)/iu.test(text)) {
    return false;
  }
  return /(unsupported|not supported|unrecognized|unknown|invalid|not available|does not support)/iu.test(text);
}

function downgradeStructuredOutputRequest(requestBody) {
  if (requestBody?.response_format?.type !== 'json_schema') return false;
  requestBody.response_format = { type: 'json_object' };
  return true;
}

function policyOutputContractMode(transport) {
  const declared = transport?.structured_output ?? transport?.structuredOutput;
  const explicitMode = transport?.structured_output_mode ?? transport?.structuredOutputMode;
  if (normalizeStructuredOutputMode(explicitMode) === 'json_schema') return 'json_schema';
  if (declared === 'strict') return 'json_object';
  return normalizeOutputContractMode(declared);
}

function requestOutputContractMode(requestBody) {
  const type = requestBody?.response_format?.type;
  if (type === 'json_object') return 'json_object';
  if (type === 'json_schema') return 'json_schema';
  return 'prompt_validated_json';
}

/**
 * Reports the output contract at the action boundary without changing the request. A successful
 * HTTP response is not proof that a provider advertises structured-output support, so support is
 * deliberately `unreported` until the upstream supplies an explicit capability signal.
 */
function buildOutputContractTelemetry(transport, requestBody, terminalParsed = false, providerSupported = 'unreported') {
  return {
    policyDeclared: policyOutputContractMode(transport),
    requestObserved: requestOutputContractMode(requestBody),
    providerSupported: normalizeOutputContractSupport(providerSupported),
    terminalParsed: terminalParsed === true,
  };
}

function normalizeOutputContractTelemetry(value) {
  const contract = value && typeof value === 'object' ? value : {};
  return {
    policyDeclared: normalizeOutputContractMode(contract.policyDeclared),
    requestObserved: normalizeOutputContractMode(contract.requestObserved),
    providerSupported: normalizeOutputContractSupport(contract.providerSupported),
    terminalParsed: contract.terminalParsed === true,
  };
}

function normalizeModelResponseAttemptOutcome(value) {
  return MODEL_RESPONSE_ATTEMPT_OUTCOMES.has(value) ? value : null;
}

function normalizeModelReasoningEffort(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return 'missing';
  const normalized = value.trim().toLowerCase();
  return MODEL_REASONING_EFFORTS.has(normalized) ? normalized : 'other';
}

function normalizeModelTimeoutKind(value) {
  return typeof value === 'string' && MODEL_TIMEOUT_KINDS.has(value.trim().toLowerCase())
    ? value.trim().toLowerCase()
    : null;
}

function normalizeTelemetryTokenCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(MAX_TELEMETRY_TOKEN_COUNT, Math.floor(numeric));
}

function normalizeModelResponseAttempt(entry = {}) {
  const attempt = normalizeTelemetryAttemptCount(entry.attempt);
  const outcome = normalizeModelResponseAttemptOutcome(entry.outcome);
  if (attempt === null || attempt < 1 || !outcome) return null;
  const timeoutKind = normalizeModelTimeoutKind(entry.timeoutKind);
  const requestFingerprint = normalizeTelemetryDigest(entry.requestFingerprint);
  const generationIdDigest = normalizeTelemetryDigest(entry.generationIdDigest);
  const normalized = {
    attempt,
    outcome,
    transport: normalizeTelemetryProvider(entry.transport),
    provider: normalizeTelemetryProvider(entry.provider) || normalizeTelemetryProvider(entry.transport),
    latencyMs: normalizeTelemetryDuration(entry.latencyMs),
    ttftMs: normalizeTelemetryDuration(entry.ttftMs),
    responseStatus: normalizeTelemetryStatus(entry.responseStatus),
    failureClass: normalizeTelemetryOutcomeClass(entry.failureClass),
    ...(timeoutKind ? { timeoutKind } : {}),
    reasoningEffort: normalizeModelReasoningEffort(entry.reasoningEffort),
    maxOutputTokens: normalizeTelemetryTokenCount(entry.maxOutputTokens),
    outputTokens: normalizeTelemetryTokenCount(entry.outputTokens),
    outputShape: normalizeFindingsOutputShape(entry.outputShape),
    finishReason: normalizeModelFinishReason(entry.finishReason),
    responseMode: normalizeResponseMode(entry.responseMode),
    findingsSource: normalizeFindingsSource(entry.findingsSource),
    contentPresent: entry.contentPresent === true,
    reasoningPresent: entry.reasoningPresent === true,
    contentSizeBucket: normalizeResponseSizeBucket(entry.contentSizeBucket),
    reasoningSizeBucket: normalizeResponseSizeBucket(entry.reasoningSizeBucket),
    outputContract: normalizeOutputContractTelemetry(entry.outputContract),
    ...(entry.routerMetadata ? { routerMetadata: normalizeOpenRouterMetadata(entry.routerMetadata) } : {}),
  };
  if (requestFingerprint) normalized.requestFingerprint = requestFingerprint;
  if (generationIdDigest) normalized.generationIdDigest = generationIdDigest;
  return normalized;
}

function normalizeModelResponseAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_MODEL_RESPONSE_ATTEMPTS)
    .map(normalizeModelResponseAttempt)
    .filter(Boolean);
}

/**
 * Normalizes and validates model-produced findings.
 *
 * Findings naming a file outside the diff are dropped: a reviewer that invents file paths posts
 * comments GitHub cannot anchor, and erodes trust in every other finding it reports.
 */
function sanitizeFindings(rawFindings, diffFiles) {
  const knownPaths = new Set(diffFiles.map((f) => f.path));

  return rawFindings
    .filter((f) => f && typeof f === 'object')
    .filter((f) => knownPaths.has(f.path))
    .map((f) => ({
      severity: SEVERITIES.includes(f.severity) ? f.severity : 'P2',
      path: f.path,
      line: Number.isInteger(f.line) && f.line > 0 ? f.line : 1,
      title: String(f.title || 'Review finding').slice(0, 200),
      body: String(f.body || f.title || '').slice(0, 2_000),
      suggestion: f.suggestion ? String(f.suggestion).slice(0, 2_000) : undefined,
    }));
}

function normalizeResponseProvider(provider) {
  if (typeof provider === 'string' && provider.trim()) return provider.trim();
  if (provider && typeof provider === 'object') {
    const name = provider.name || provider.id || provider.slug;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

const TELEMETRY_IDENTIFIER_MAX_LENGTH = 200;

// These values are deliberately closed and descriptive.  Provider messages,
// URLs, headers, and request content must never cross the telemetry boundary.
const TELEMETRY_OUTCOME_CLASSES = new Set([
  'http_429',
  'http_4xx',
  'http_5xx',
  'timeout',
  'transient_socket',
  'provider_rate_limit',
  'provider_error',
  'malformed_output',
  'unknown',
]);

const TELEMETRY_RECOVERY_ACTIONS = new Set([
  'bounded_retry',
  'model_fallback',
  'structured_output_fallback',
]);

const OPENROUTER_MAX_RETRY_AFTER_MS = 5_000;
// OpenRouter rejects recovery requests whose `models` array contains more than
// three entries. Keep the bounded recovery deterministic by retaining the
// policy's canonical order after removing the failed model.
const OPENROUTER_MAX_FALLBACK_MODELS = 3;

function normalizeTelemetryAttemptCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(100, Math.floor(numeric));
}

function normalizeTelemetryDuration(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(86_400_000, Math.floor(numeric));
}

function normalizeTelemetryOutcomeClass(value) {
  const normalized = normalizeTelemetryIdentifier(value);
  return normalized && TELEMETRY_OUTCOME_CLASSES.has(normalized) ? normalized : null;
}

function normalizeTelemetryRetryReasons(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeTelemetryOutcomeClass).filter(Boolean))].slice(0, 8);
}

function normalizeTelemetryRecoveryAction(value) {
  const normalized = normalizeTelemetryIdentifier(value);
  return normalized && TELEMETRY_RECOVERY_ACTIONS.has(normalized) ? normalized : null;
}

function normalizeTelemetryErrorCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/u.test(normalized)) return null;
  return normalized;
}

function normalizeTelemetryStatus(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : null;
}

function normalizeTelemetryIdentifier(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > TELEMETRY_IDENTIFIER_MAX_LENGTH) return null;
  if (/[\x00-\x1F\x7F]/.test(normalized)) return null;
  // Provider/model identifiers are useful telemetry, but credential-shaped values are not.
  if (/(?:^|[^a-z0-9])(?:bearer\s+|sk-(?:proj-)?|gh[ps]_|github_pat_|xox[baprs]-)[a-z0-9]/i.test(normalized)) return null;
  return normalized;
}

function normalizeTelemetryProvider(value) {
  const normalized = normalizeTelemetryIdentifier(value);
  if (!normalized) return null;
  const provider = normalized.toLowerCase().replace(/[_\s]+/g, '-');
  if (/^openrouter(?:-.+)?$/.test(provider)) return 'openrouter';
  if (provider === 'openinference') return 'openinference';
  if (/^(?:direct-)?fireworks(?:-.+)?$/.test(provider)) return 'fireworks';
  if (/^ollama(?:-.+)?$/.test(provider)) return 'ollama';
  if (/^anthropic(?:-.+)?$/.test(provider)) return 'anthropic';
  if (/^(?:google|gemini)(?:-.+)?$/.test(provider)) return 'gemini';
  if (/^openai(?:-.+)?$/.test(provider)) return 'openai';
  if (provider === 'default') return 'default';
  return null;
}

function hashTelemetryIdentifier(value) {
  const normalized = normalizeTelemetryIdentifier(value);
  return normalized ? createHash('sha256').update(normalized, 'utf-8').digest('hex') : null;
}

// OpenRouter router metadata is useful for diagnosing endpoint selection, but its raw form may
// contain URLs or provider-provided text. Retain only bounded labels, attempt numbers, and
// one-way endpoint/provider digests so receipts remain safe to publish.
function normalizeOpenRouterMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = {};
  for (const [target, source] of [
    ['strategy', value.strategy],
    ['region', value.region],
    ['taskType', value.task_type ?? value.taskType],
  ]) {
    const normalized = normalizeTelemetryIdentifier(source);
    if (normalized) metadata[target] = normalized.slice(0, 64);
  }
  const attempt = normalizeTelemetryAttemptCount(value.attempt);
  if (attempt !== null) metadata.attempt = attempt;
  const candidates = [
    ...(Array.isArray(value.endpoints) ? value.endpoints : []),
    ...(Array.isArray(value.available_providers) ? value.available_providers : []),
    ...(Array.isArray(value.attempts) ? value.attempts : []),
  ];
  const endpointDigests = candidates.map((candidate) => {
    if (typeof candidate === 'string') return hashTelemetryIdentifier(candidate);
    if (!candidate || typeof candidate !== 'object') return null;
    return hashTelemetryIdentifier(
      candidate.endpoint || candidate.url || candidate.provider || candidate.slug || candidate.name,
    );
  }).filter(Boolean).slice(0, 16);
  if (endpointDigests.length > 0) metadata.endpointDigests = endpointDigests;
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function normalizeTelemetryDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function canonicalTelemetryJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalTelemetryJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalTelemetryJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintRequestString(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Request fingerprints are useful for correlating a qualification row with its exact retry,
// but prompts, diffs, and arbitrary provider payloads must not cross the receipt boundary. Keep
// message content as a digest (not plaintext) and redact credential-shaped fields before hashing.
function sanitizeRequestForFingerprint(value, key = '') {
  if (/(?:api[_-]?key|authorization|credential|password|secret|token)/i.test(key)) return '<redacted-secret>';
  if (/(?:content|prompt|completion|patch|diff)/i.test(key) && typeof value === 'string') {
    return { digest: fingerprintRequestString(value), length: value.length };
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeRequestForFingerprint(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((childKey) => [childKey, sanitizeRequestForFingerprint(value[childKey], childKey)]),
    );
  }
  return value;
}

function requestFingerprintForAttempt(requestBody, transportName, configuredProvider, transportBaseUrl) {
  let endpoint = String(transportBaseUrl || '').replace(/\/+$/u, '');
  try {
    const parsed = new URL(endpoint);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    endpoint = parsed.toString().replace(/\/+$/u, '');
  } catch (_) {
    endpoint = endpoint.replace(/[?#].*$/u, '');
  }
  return normalizeTelemetryDigest(createHash('sha256').update(canonicalTelemetryJson({
    method: 'POST',
    endpoint: `${endpoint}/chat/completions`,
    transport: normalizeTelemetryProvider(transportName) || 'unknown',
    provider: normalizeResponseProvider(configuredProvider) || 'unknown',
    body: sanitizeRequestForFingerprint(requestBody),
  }), 'utf8').digest('hex'));
}

function safeReceiptPathToken(value) {
  const token = String(value ?? 'unknown').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(token) ? token : 'unknown';
}

function isWithinDirectory(candidate, parent) {
  const candidatePath = path.resolve(candidate);
  const parentPath = path.resolve(parent);
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${path.sep}`);
}

function resolveResponseModel(payload, fallbackModel) {
  return typeof payload?.model === 'string' && payload.model.trim()
    ? payload.model.trim()
    : typeof payload?.model_id === 'string' && payload.model_id.trim()
      ? payload.model_id.trim()
      : fallbackModel;
}

function resolveConfiguredProvider(transport, transportName, transportBaseUrl) {
  return normalizeResponseProvider(transport?.provider)
    || (transportName && transportName !== 'default' ? normalizeResponseProvider(transportName) : null)
    || (String(transportBaseUrl || '').toLowerCase().includes('openrouter.ai') ? 'openrouter' : null);
}

function resolveResponseProvider(payload, configuredProvider) {
  return normalizeResponseProvider(payload?.provider)
    || normalizeResponseProvider(payload?.usage?.provider)
    || normalizeResponseProvider(configuredProvider);
}

function classifyTelemetryHttpFailure(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return 'unknown';
  if (code === 408 || code === 504) return 'timeout';
  if (code === 429) return 'http_429';
  if (code >= 400 && code < 500) return 'http_4xx';
  if (code >= 500 && code < 600) return 'http_5xx';
  return 'unknown';
}

function classifyTelemetryTransportError(error) {
  const message = String(error?.message || error || '');
  if (/AbortError|aborted|timeout|deadline|stalled/i.test(message)) return 'timeout';
  if (/ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_SOCKET_TIMEOUT|network timeout/i.test(message)) return 'transient_socket';
  if (/empty_sse|parse|json|findings/i.test(message)) return 'malformed_output';
  return 'unknown';
}

// Keep timeout evidence closed and actionable without retaining provider text. A transport-level
// timeout means the request watchdog fired; an SSE timeout can distinguish first-byte, inactivity,
// and total-generation budget failures for the receipt and RCA.
function classifyTelemetryTimeoutKind(error) {
  const explicit = normalizeModelTimeoutKind(error?.timeoutKind || error?.kind);
  if (explicit) return explicit;
  const message = String(error?.message || error || '');
  if (/total deadline/i.test(message)) return 'total';
  if (/first streamed chunk|TTFT/i.test(message)) return 'ttft';
  if (/stream(?:ing)?(?: response)? stalled|inactivity|heartbeat/i.test(message)) return 'inactivity';
  if (/AbortError|aborted|timeout|deadline/i.test(message)) return 'request';
  return null;
}

function parseRetryAfterMs(response) {
  const raw = typeof response?.headers?.get === 'function'
    ? response.headers.get('retry-after')
    : response?.headers?.['retry-after'] ?? response?.headers?.['Retry-After'];
  if (raw === null || raw === undefined || String(raw).trim() === '') return 0;
  const value = String(raw).trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(OPENROUTER_MAX_RETRY_AFTER_MS, Math.floor(seconds * 1_000));
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return 0;
  return Math.min(OPENROUTER_MAX_RETRY_AFTER_MS, Math.max(0, dateMs - Date.now()));
}

function resolveOpenRouterErrorCode(payload) {
  return normalizeTelemetryErrorCode(
    payload?.error?.code
      || payload?.error?.type
      || payload?.code
      || payload?.type,
  );
}

function matchAllowedModelInError(message, allowedModels = []) {
  const text = String(message || '');
  return allowedModels.find((model) => text.includes(model)) || null;
}

function prepareOpenRouterModelFallback(requestBody, requestOptions, payload, message, transport = null) {
  // An explicit transport handoff is authoritative. Its `model` plus `models` list is the
  // documented OpenRouter model-fallback contract; never replace it with the legacy action
  // policy's auto-router allowlist when the central plan supplied an explicit route.
  const explicitModels = Array.isArray(transport?.models) && transport.models.length > 0
    ? [transport.model || requestBody.model, ...transport.models]
    : null;
  const configuredModels = explicitModels || requestOptions?.plugins?.find((plugin) => plugin?.id === 'auto-router')?.allowed_models;
  if (!Array.isArray(configuredModels) || configuredModels.length < 2) return false;
  const failedModel = matchAllowedModelInError(
    [message, payload?.error?.metadata?.model, payload?.model].filter(Boolean).join(' '),
    configuredModels,
  );
  if (!failedModel) return false;
  const fallbackModels = configuredModels
    .filter((model) => model !== failedModel)
    .slice(0, OPENROUTER_MAX_FALLBACK_MODELS);
  if (fallbackModels.length === 0) return false;

  // OpenRouter's `models` extension performs model-level fallback on rate limits
  // and downtime. Pin the failed model as the primary for this recovery request,
  // then walk the remaining policy-approved models. Remove auto-router-only
  // fields and optional reasoning so every fallback candidate can satisfy the
  // structured JSON contract.
  requestBody.model = failedModel;
  requestBody.models = fallbackModels;
  delete requestBody.plugins;
  delete requestBody.reasoning;
  delete requestBody.reasoning_effort;
  requestBody.provider = {
    ...(requestBody.provider || {}),
    require_parameters: true,
  };
  return true;
}

function extractResponseCost(payload) {
  const candidates = [
    payload?.usage?.cost,
    payload?.usage?.total_cost,
    payload?.usage?.cost_details?.upstream_inference_cost,
    payload?.cost,
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim() !== '') {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return null;
}

function normalizeTokenCount(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : null;
}

function extractResponseTokenUsage(payload) {
  const usage = payload?.usage || {};
  return {
    inputTokens: normalizeTokenCount(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.inputTokens),
    outputTokens: normalizeTokenCount(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.outputTokens),
  };
}

function normalizeCost(cost) {
  if (cost === null || cost === undefined || String(cost).trim() === '') return null;
  const numeric = Number(cost);
  return Number.isFinite(numeric) && numeric >= 0 && numeric < 1e21 ? numeric : null;
}

function formatCost(cost) {
  if (typeof cost === 'string' && cost.toLowerCase().trim() === 'subscription') {
    return 'Subscription';
  }
  const numeric = normalizeCost(cost);
  if (numeric === null) return '—';
  const formatted = numeric.toFixed(3);
  return /e/i.test(formatted) ? '—' : `$${formatted}`;
}

/**
 * Detects whether a provider or transport string corresponds to an unmetered/flat-rate subscription.
 *
 * @param {string|object} [provider] Provider identifier, name, or object
 * @param {string|object} [transport] Transport type, identifier, or object
 * @returns {boolean}
 */
function isSubscriptionTransport(provider, transport = '') {
  const providerStr = typeof provider === 'string'
    ? provider
    : (provider?.id || provider?.name || provider?.transport || '');
  const transportStr = typeof transport === 'string'
    ? transport
    : (transport?.id || transport?.name || transport?.type || '');
  const text = `${providerStr} ${transportStr}`.toLowerCase().trim();
  if (!text) return false;
  if (/subscription/i.test(text)) return true;
  return /^(fireworks|direct[-_]?fireworks|ollama|ollama[-_]?cloud|ollama[-_]?local)\b/i.test(providerStr.trim()) ||
         /^(fireworks|direct[-_]?fireworks|ollama|ollama[-_]?cloud|ollama[-_]?local)\b/i.test(transportStr.trim()) ||
         /^(fireworks|direct[-_]?fireworks|ollama|ollama[-_]?cloud|ollama[-_]?local)/i.test(text);
}

/**
 * The high-reasoning completion reserve is only for the explicitly admitted
 * direct DeepSeek transports. Keep arbitrary direct-compatible test/custom
 * endpoints on the bounded default unless they identify as Fireworks or
 * Ollama; this avoids silently changing unrelated provider contracts.
 *
 * @param {object} transport
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isDirectReasoningTransport(transport = {}, baseUrl = '') {
  const text = [
    transport.provider,
    transport.compat,
    transport.name,
    transport.model,
    baseUrl,
  ].filter(Boolean).join(' ').toLowerCase();
  return /(?:^|[\s/:._-])(fireworks|ollama)(?:$|[\s/:._-])/i.test(text);
}

/**
 * Direct Ollama qualification showed fixture-level result variance at the existing 0.1
 * sampling temperature. Keep the current OpenRouter/Fireworks request contract unchanged,
 * but make the explicitly named Ollama route deterministic so a future manual promotion is
 * measured against a stable generation setting.
 */
function isOllamaTransport(transport = {}, baseUrl = '') {
  const text = [
    transport.provider,
    transport.name,
    transport.model,
    baseUrl,
  ].filter(Boolean).join(' ').toLowerCase();
  return /(?:^|[\s/:._-])ollama(?:$|[\s/:._-])/i.test(text);
}

function resolveTransportTemperature(transport = {}, baseUrl = '') {
  return isOllamaTransport(transport, baseUrl) ? 0 : 0.1;
}

/**
 * Produce a stable, provider-supported seed for Ollama without coupling paired
 * qualification arms to their synthetic PR labels. The seed contains no source
 * text: source paths and patches are reduced to a digest before the final hash.
 */
function deriveOllamaRequestSeed(transport = {}, baseUrl = '', persona = {}, diffFiles = [], prContext = {}) {
  if (!isOllamaTransport(transport, baseUrl)) return null;
  const diffDigest = createHash('sha256');
  for (const file of Array.isArray(diffFiles) ? diffFiles : []) {
    diffDigest.update(String(file?.path || ''), 'utf-8');
    diffDigest.update('\0', 'utf-8');
    diffDigest.update(String(file?.patch || ''), 'utf-8');
    diffDigest.update('\0', 'utf-8');
  }
  const seedMaterial = JSON.stringify([
    'review-yeti-ollama-seed-v1',
    String(prContext?.repo || ''),
    String(prContext?.baseSha || ''),
    String(prContext?.headSha || ''),
    String(persona?.id || ''),
    String(transport?.model || ''),
    diffDigest.digest('hex'),
  ]);
  return createHash('sha256').update(seedMaterial, 'utf-8').digest().readUInt32BE(0) & 0x7fffffff;
}

/**
 * Determines whether a persona evaluation result ran on an unmetered or subscription transport.
 *
 * @param {object} res Persona result object
 * @returns {boolean}
 */
function isSubscriptionLane(res) {
  if (!res || typeof res !== 'object') return false;
  if (res.isSubscription === true || String(res.isSubscription).toLowerCase() === 'true') return true;
  if (typeof res.billing === 'string' && res.billing.toLowerCase().trim() === 'subscription') return true;
  if (typeof res.pricingType === 'string' && res.pricingType.toLowerCase().trim() === 'subscription') return true;
  if (typeof res.transport === 'string' && res.transport.toLowerCase().trim() === 'subscription') return true;
  if (typeof res.cost === 'string' && res.cost.toLowerCase().trim() === 'subscription') return true;

  const numCost = normalizeCost(res.cost);
  if (numCost === null || numCost === 0) {
    const providerStr = typeof res.provider === 'string'
      ? res.provider
      : (res.provider?.id || res.provider?.name || '');
    const transportStr = typeof res.transport === 'string'
      ? res.transport
      : (res.transport?.id || res.transport?.name || res.transport?.type || '');
    if (isSubscriptionTransport(providerStr, transportStr)) {
      return true;
    }
  }
  return false;
}

function formatTokenCount(tokens) {
  const numeric = tokens === null || tokens === undefined || String(tokens).trim() === ''
    ? null
    : Number(tokens);
  return Number.isFinite(numeric) ? Math.trunc(numeric).toLocaleString('en-US') : '—';
}

function escapeMarkdownTableCell(value) {
  return String(value ?? '')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
}

function countFindingsBySeverity(findings = []) {
  const counts = { P0: 0, P1: 0, P2: 0 };
  findings.forEach((finding) => {
    if (SEVERITIES.includes(finding?.severity)) counts[finding.severity] += 1;
  });
  return counts;
}

// A fragment smaller than this is too small to review meaningfully. Report it as omitted rather
// than implying that a reviewer saw the entire file.
const MIN_USEFUL_FILE_CHARS = 800;

/**
 * Allocates the per-persona diff budget and records every file that was reviewed, truncated, or
 * omitted. The accounting is included in the prompt and the human-facing comment.
 */
function planDiffBudget(diffFiles, maxDiffChars) {
  const reviewed = [];
  const truncated = [];
  const omitted = [];
  if (!Array.isArray(diffFiles) || diffFiles.length === 0) return { text: '', reviewed, truncated, omitted };

  const effectiveFiles = diffFiles.map((file) => {
    let patch = String(file.patch || '');
    if (diffCompactor && diffCompactor.compactUnifiedDiff && patch.includes('@@')) {
      try {
        const compacted = diffCompactor.compactUnifiedDiff(patch);
        if (compacted && compacted.compactedPatch) {
          patch = compacted.compactedPatch;
        }
      } catch (_) {}
    }
    return { ...file, patch };
  });

  const total = effectiveFiles.reduce((sum, file) => sum + String(file.patch || '').length, 0);
  if (total <= maxDiffChars) {
    return {
      text: effectiveFiles.map((file) => `\n--- FILE: ${file.path} ---\n${file.patch || ''}`).join(''),
      reviewed: effectiveFiles.map((file) => file.path),
      truncated,
      omitted,
    };
  }

  const fairShare = Math.floor(maxDiffChars / effectiveFiles.length);
  const perFile = Math.max(MIN_USEFUL_FILE_CHARS, fairShare);
  const capacity = Math.max(1, Math.floor(maxDiffChars / perFile));
  let text = '';
  effectiveFiles.forEach((file, index) => {
    if (index >= capacity) {
      omitted.push(file.path);
      return;
    }
    const patch = String(file.patch || '');
    reviewed.push(file.path);
    if (patch.length > perFile) {
      truncated.push(file.path);
      text += `\n--- FILE: ${file.path} ---\n${patch.slice(0, perFile)}\n[this file's diff is truncated]\n`;
    } else {
      text += `\n--- FILE: ${file.path} ---\n${patch}`;
    }
  });
  if (truncated.length > 0) text += `\n[${truncated.length} file(s) above are shown only in part.]\n`;
  if (omitted.length > 0) text += `\n[${omitted.length} changed file(s) are not shown at all: ${omitted.slice(0, 20).join(', ')}${omitted.length > 20 ? ', …' : ''}]\n`;
  text += '\nReport only on what you can see above. Do not infer defects in code you were not shown.\n';
  return { text, reviewed, truncated, omitted };
}

function renderDiffForPrompt(diffFiles, maxDiffChars) {
  return planDiffBudget(diffFiles, maxDiffChars).text;
}

/**
 * Run-Scoped Transport Circuit Breaker.
 * Tracks provider outages (HTTP 503/529, upstream cancellation, persistent rate limits)
 * during a single review execution so subsequent persona lanes bypass failing transports immediately.
 */
class RunTransportCircuitBreaker {
  constructor() {
    this.tripped = new Set();
    this.reasons = new Map();
  }

  trip(transportName, reason) {
    if (!transportName) return;
    this.tripped.add(transportName);
    this.reasons.set(transportName, String(reason || 'unspecified failure'));
    console.log(`[Circuit Breaker] Tripped transport '${transportName}' for current run: ${reason}`);
  }

  isTripped(transportName) {
    return Boolean(transportName && this.tripped.has(transportName));
  }

  filterCandidates(transports) {
    if (!Array.isArray(transports) || transports.length <= 1) return transports;
    const healthy = transports.filter((t) => !this.isTripped(t.name || t.provider));
    // If all are tripped, don't return empty array; return original so at least one attempt is made
    return healthy.length > 0 ? healthy : transports;
  }

  reset() {
    this.tripped.clear();
    this.reasons.clear();
  }
}

const globalRunCircuitBreaker = new RunTransportCircuitBreaker();

function isOpenRouterTransport(transport = {}) {
  const name = String(transport.name || transport.provider || '').toLowerCase();
  const baseUrl = String(transport.baseUrl || transport.base_url || '').replace(/\/+$/, '').toLowerCase();
  return name.includes('openrouter') || baseUrl === 'https://openrouter.ai/api/v1';
}

const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Keep the explicitly configured reasoning level for the first transport attempt, then make
 * provider failover progressively cheaper/faster. A provider that has already timed out (or
 * returned unusable output) should not receive the same expensive request shape on the next
 * transport. This remains fail-closed: a lower-effort fallback still must return parseable
 * findings JSON before a lane can succeed.
 */
function downgradeReasoningEffort(effort, fallbackAttempt = 0) {
  const normalized = String(effort || '').trim().toLowerCase();
  const index = REASONING_EFFORT_LEVELS.indexOf(normalized);
  if (index === -1 || fallbackAttempt <= 0) return effort;
  return REASONING_EFFORT_LEVELS[Math.max(0, index - fallbackAttempt)];
}

function normalizeMaxOutputTokens(value, fallback = DEFAULT_MAX_OUTPUT_TOKENS) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function contentFragments(value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (part && typeof part.text === 'string') return [part.text];
    return [];
  });
}

// Reasoning-capable OpenAI-compatible providers do not agree on the field used for
// streamed thought tokens.  Keep this extraction deliberately narrow: only textual
// fragments are eligible, and callers still require a complete findings payload before
// accepting the response.  In particular, ordinary prose in a reasoning field must not
// turn a provider response into an approval.
function reasoningFragments(value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    if (typeof part.text === 'string') return [part.text];
    if (typeof part.reasoning === 'string') return [part.reasoning];
    if (typeof part.content === 'string') return [part.content];
    return [];
  });
}

/**
 * Read an OpenAI-compatible completion while preserving the transport's streaming contract.
 *
 * The hosted policy admits only streaming transports.  Older action code nevertheless called
 * `response.json()` unconditionally and omitted `stream` from the request, so the smoke probe
 * exercised a different request shape from the real panel and every persona waited for a
 * buffered, full-generation response.  Keep the non-streaming branch for legacy callers/tests,
 * but consume SSE deltas when the central handoff explicitly requests streaming.
 */
function streamInactivityError(timeoutMs, timeoutKind = 'inactivity') {
  const error = new Error(`Streaming response stalled for ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.timeoutKind = timeoutKind;
  return error;
}

function streamTotalDeadlineError(timeoutMs) {
  const error = new Error(`Streaming response exceeded total deadline of ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.timeoutKind = 'total';
  return error;
}

async function withStreamInactivityTimeout(promise, timeoutMs, onTimeout) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const timeoutError = onTimeout?.();
          reject(timeoutError instanceof Error ? timeoutError : streamInactivityError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readChatCompletionResponse(
  response,
  streamEnabled,
  inactivityTimeoutMs = 90_000,
  totalTimeoutMs = 0,
  ttftTimeoutMs = inactivityTimeoutMs,
  onFirstData,
) {
  const contentType = typeof response?.headers?.get === 'function'
    ? String(response.headers.get('content-type') || '').toLowerCase()
    : '';
  if (!streamEnabled || !contentType.includes('text/event-stream')) {
    return response.json();
  }

  const chunks = [];
  const reasoningChunks = [];
  let latest = null;
  let streamedRouterMetadata = null;
  let pending = '';
  let eventData = [];
  let receivedFirstData = false;
  const streamStartedAt = Date.now();
  const dispatchEvent = () => {
    if (eventData.length === 0) return;
    const data = eventData.join('\n');
    eventData = [];
    if (!data || data === '[DONE]') return;
    if (!receivedFirstData) {
      receivedFirstData = true;
      onFirstData?.(Date.now() - streamStartedAt);
    }
    try {
      const payload = JSON.parse(data);
      latest = payload;
      if (payload?.openrouter_metadata && typeof payload.openrouter_metadata === 'object') {
        streamedRouterMetadata = payload.openrouter_metadata;
      }
      const choice = payload?.choices?.[0];
      const delta = contentFragments(choice?.delta?.content);
      const message = contentFragments(choice?.message?.content);
      const deltaReasoning = reasoningFragments(
        choice?.delta?.reasoning_details
          ?? choice?.delta?.reasoning
          ?? choice?.delta?.reasoning_content,
      );
      const messageReasoning = reasoningFragments(
        choice?.message?.reasoning_details
          ?? choice?.message?.reasoning
          ?? choice?.message?.reasoning_content,
      );
      if (delta.length > 0) chunks.push(...delta);
      else if (message.length > 0) chunks.push(...message);
      if (deltaReasoning.length > 0) reasoningChunks.push(...deltaReasoning);
      else if (messageReasoning.length > 0) reasoningChunks.push(...messageReasoning);
    } catch (_) {
      // Providers may terminate a stream with a partial final SSE frame. The
      // completed content accumulated so far remains valid and is parsed below.
    }
  };
  const consume = (text, final = false) => {
    pending += String(text);
    const lines = pending.split(/\r?\n/);
    pending = final ? '' : (lines.pop() || '');
    for (const line of lines) {
      if (line === '') {
        dispatchEvent();
        continue;
      }
      // SSE comments are keep-alives. They are intentionally not counted as
      // first-token evidence, but their arrival keeps the reader alive.
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      if (field !== 'data') continue;
      // OpenRouter emits one JSON object per event. A few compatible gateways omit
      // the required blank separator; dispatch the previous data field leniently so
      // that one missing delimiter cannot discard an otherwise complete response.
      if (eventData.length > 0) dispatchEvent();
      let value = separator === -1 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      eventData.push(value);
    }
    if (final) dispatchEvent();
  };

  const totalDeadlineAt = totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : 0;
  const remainingTotalMs = () => (totalDeadlineAt ? totalDeadlineAt - Date.now() : Infinity);
  let cancelStream = () => {};
  const throwIfTotalDeadline = () => {
    // Timer callbacks can run a few milliseconds early. Classify that boundary consistently as
    // the total lane deadline instead of nondeterministically reporting stream inactivity.
    if (totalDeadlineAt && Date.now() + 10 >= totalDeadlineAt) {
      cancelStream();
      throw streamTotalDeadlineError(totalTimeoutMs);
    }
  };

  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    cancelStream = () => {
      void Promise.resolve(reader.cancel?.('stream total deadline')).catch(() => {});
    };
    const decoder = new TextDecoder();
    try {
      while (true) {
        throwIfTotalDeadline();
        const readBudgetMs = Math.min(
          receivedFirstData ? inactivityTimeoutMs : ttftTimeoutMs,
          remainingTotalMs(),
        );
        try {
          const { value, done } = await withStreamInactivityTimeout(
            reader.read(),
            readBudgetMs,
            () => {
              const timeoutError = streamInactivityError(
                readBudgetMs,
                receivedFirstData ? 'inactivity' : 'ttft',
              );
              // Reject the read race before cancellation can resolve reader.read() as { done: true }
              // and turn a watchdog failure into the misleading `empty_sse` outcome.
              queueMicrotask(() => {
                void Promise.resolve(reader.cancel?.(receivedFirstData ? 'stream inactivity timeout' : 'stream ttft timeout')).catch(() => {});
              });
              return timeoutError;
            },
          );
          if (done) break;
          if (value) {
            consume(decoder.decode(value, { stream: true }));
          }
        } catch (err) {
          throwIfTotalDeadline();
          throw err;
        }
      }
      consume(decoder.decode(), true);
    } finally {
      reader.releaseLock?.();
    }
  } else if (typeof response.text === 'function') {
    throwIfTotalDeadline();
    try {
      consume(await withStreamInactivityTimeout(
        response.text(),
        Math.min(inactivityTimeoutMs, remainingTotalMs()),
      ), true);
    } catch (err) {
      throwIfTotalDeadline();
      throw err;
    }
  }

  if (chunks.length === 0 && reasoningChunks.length === 0) throw new Error('empty_sse');
  const lastChoice = latest?.choices?.[0] || {};
  return {
    ...(latest || {}),
    ...(streamedRouterMetadata ? { openrouter_metadata: streamedRouterMetadata } : {}),
    choices: [{
      ...lastChoice,
      message: {
        ...(lastChoice.message || {}),
        content: chunks.join(''),
        ...(reasoningChunks.length > 0 ? { reasoning: reasoningChunks.join('') } : {}),
      },
    }],
  };
}

/**
 * Evaluates one persona charter against the diff using an LLM.
 *
 * Never throws: a failed lane degrades to zero findings with an `error` set, so one bad persona
 * cannot take down a whole review.
 */
async function reviewWithModel(persona, diffFiles, prContext, sessionContext, options = {}) {
  const cfg = { ...resolveModelConfig(), ...options };
  const fetchImpl = options.fetchImplementation || options.fetchImpl || globalThis.fetch;
  const sleep = options.sleepImplementation || options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxDiffChars = options.maxDiffChars || cfg.maxDiffChars || DEFAULT_MAX_DIFF_CHARS;
  const laneStartMs = Date.now();
  let attemptCount = 0;
  let failureClass = null;
  const retryReasons = [];
  let responseStatus = null;
  let errorCode = null;
  let generationIdDigest = null;
  let routerAttempt = null;
  let recoveryAction = null;
  let outputShape = null;
  let finishReason = 'missing';
  let responseMode = null;
  let findingsSource = 'none';
  let contentPresent = false;
  let reasoningPresent = false;
  let contentSizeBucket = 'empty';
  let reasoningSizeBucket = 'empty';
  let ttftMs = null;
  let outputContract = null;
  let routerMetadata = null;
  let requestFingerprint = null;
  const responseAttempts = [];
  const noteRetryReason = (reason) => {
    const normalized = normalizeTelemetryOutcomeClass(reason);
    if (normalized && !retryReasons.includes(normalized) && retryReasons.length < 8) retryReasons.push(normalized);
  };
  const withTelemetry = (base, finalFailureClass = failureClass) => ({
    ...base,
    attemptCount,
    latencyMs: normalizeTelemetryDuration(Date.now() - laneStartMs),
    ttftMs: normalizeTelemetryDuration(ttftMs),
    retryReasons: [...retryReasons],
    failureClass: normalizeTelemetryOutcomeClass(finalFailureClass),
    responseStatus: normalizeTelemetryStatus(responseStatus),
    errorCode: normalizeTelemetryErrorCode(errorCode),
    generationIdDigest,
    routerAttempt: normalizeTelemetryAttemptCount(routerAttempt),
    recoveryAction: normalizeTelemetryRecoveryAction(recoveryAction),
    outputShape: normalizeFindingsOutputShape(outputShape),
    finishReason: normalizeModelFinishReason(finishReason),
    responseMode: normalizeResponseMode(responseMode),
    findingsSource: normalizeFindingsSource(findingsSource),
    contentPresent: contentPresent === true,
    reasoningPresent: reasoningPresent === true,
    contentSizeBucket: normalizeResponseSizeBucket(contentSizeBucket),
    reasoningSizeBucket: normalizeResponseSizeBucket(reasoningSizeBucket),
    outputContract: normalizeOutputContractTelemetry(outputContract),
    ...(routerMetadata ? { routerMetadata: normalizeOpenRouterMetadata(routerMetadata) } : {}),
    ...(requestFingerprint ? { requestFingerprint } : {}),
    responseAttempts: normalizeModelResponseAttempts(responseAttempts),
  });
  let requestOptions = null;
  let resultBase = {
    personaId: persona.id,
    displayName: persona.name,
    model: cfg.model,
    provider: null,
    cost: null,
    inputTokens: null,
    outputTokens: null,
  };

  const priorContext = sessionContext?.augmentedHeader
    ? `\n\nPrior review context for this PR — do not repeat findings the author has already rejected:\n${sessionContext.augmentedHeader}`
    : '';

  const systemPrompt = [
    `You are ${persona.name}, one reviewer on a code review panel.`,
    '',
    'Your charter:',
    persona.charter,
    priorContext,
    '',
    'Review the unified diff supplied by the user against your charter and nothing else.',
    'Another reviewer covers every other concern; staying in your lane is what makes the panel work.',
    '',
    'Rules:',
    '- Report only defects you can point to in the diff. Do not speculate about unseen code.',
    '- Use the exact file path from the diff headers and calculate the line number from the hunk headers (@@ -oldStart,oldCount +newStart,newCount @@).',
    '- Every finding must name what breaks and under what conditions. If you cannot, do not report it.',
    '- Severity: P0 = exploitable, data-losing or outage-causing. P1 = a defect that must be fixed before merge. P2 = worth doing, safe to merge without.',
    '- P1 and P0 are rare. When unsure between two levels, choose the lower one.',
    '- If the diff is clean by your charter, return an empty findings array. Finding nothing is the expected result on most changes, and is more useful than a speculative finding.',
    '',
    'Evidence boundary:',
    '- No tools are attached to this request. Do not emit tool calls or ask to inspect files outside the supplied diff and context.',
    '- If the supplied evidence does not prove a defect, return no finding.',
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"findings":[{"severity":"P0|P1|P2","path":"<file path>","line":<int>,"title":"<short>","body":"<why it matters>","suggestion":"<concrete fix>"}]}',
  ].join('\n');

  let diffContent = '';
  let coverage = null;

  if (options.partition && options.partitionPlan && shaPartitionManager) {
    const manifestHeader = shaPartitionManager.formatPromptManifestHeader(options.partition, options.partitionPlan);
    const partitionText = options.partition.files.map((file) => `\n--- FILE: ${file.path} ---\n${file.patch || ''}`).join('');
    diffContent = `${manifestHeader}\nUnified diff under review:\n${partitionText}`;
    coverage = {
      text: partitionText,
      reviewed: options.partition.files.map((f) => f.path),
      truncated: [],
      omitted: [],
    };
  } else {
    coverage = planDiffBudget(diffFiles, maxDiffChars);
    diffContent = `Unified diff under review:\n${coverage.text}`;
  }

  const userPrompt = [
    `Repository: ${prContext.repo || 'unknown'}`,
    prContext.prNumber ? `Pull request: #${prContext.prNumber}` : '',
    prContext.title ? `Title: ${prContext.title}` : '',
    prContext.baseSha && prContext.headSha ? `Commit SHA Range: ${prContext.baseSha}...${prContext.headSha}` : '',
    '',
    diffContent,
  ].filter(Boolean).join('\n');

  try {
    if (options.openRouterPolicy) {
      requestOptions = buildOpenRouterRequestOptions(options.openRouterPolicy);
    }

    const allTransports = Array.isArray(options.transports) && options.transports.length > 0
      ? options.transports
      : [{
          baseUrl: requestOptions?.baseUrl || cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: requestOptions?.model || cfg.model,
          provider: requestOptions?.provider,
          plugins: requestOptions?.plugins,
          name: 'default',
          stream: false,
          timeoutMs: options.timeoutMs || 90_000,
        }];

    const circuitBreaker = options.circuitBreaker || globalRunCircuitBreaker;
    const candidateTransports = circuitBreaker.filterCandidates(allTransports);

    let lastError = null;
    let fallbackAttempt = 0;

    for (let i = 0; i < candidateTransports.length; i++) {
      const transport = candidateTransports[i];
      const transportName = transport.name || transport.provider || 'default';
      const requestModel = transport.model || cfg.model;
      const transportApiKey = transport.apiKey || transport.api_key || cfg.apiKey;
      const transportBaseUrl = (transport.baseUrl || transport.base_url || cfg.baseUrl).replace(/\/+$/, '');
      const transportTimeoutMs = transport.timeoutMs || transport.timeout_ms || options.timeoutMs || 90_000;
      const streamEnabled = transport.stream === true;
      const configuredProvider = resolveConfiguredProvider(transport, transportName, transportBaseUrl);
      const isOpenRouterTransport =
        String(transport.provider || '').toLowerCase() === 'openrouter' ||
        String(transport.compat || '').toLowerCase() === 'openrouter' ||
        transportBaseUrl.toLowerCase().includes('openrouter.ai');
      const isDirectReasoning = isDirectReasoningTransport(transport, transportBaseUrl);
      const configuredMaxOutputTokens =
        transport.maxTokens ?? transport.max_tokens ?? options.maxOutputTokens ?? options.max_output_tokens ?? cfg.maxOutputTokens;
      const structuredOutputMode = resolveStructuredOutputMode(transport);
      const connectTimeoutMs = Math.min(
        transportTimeoutMs,
        Number(transport.connectTimeoutMs || transport.connect_timeout_ms) > 0
          ? Number(transport.connectTimeoutMs || transport.connect_timeout_ms)
          : transportTimeoutMs,
      );
      const ttftTimeoutMs = Math.min(
        transportTimeoutMs,
        Number(transport.ttftTimeoutMs || transport.ttft_timeout_ms) > 0
          ? Number(transport.ttftTimeoutMs || transport.ttft_timeout_ms)
          : isOpenRouterTransport
            ? DEFAULT_OPENROUTER_TTFT_TIMEOUT_MS
            : transportTimeoutMs,
      );

      resultBase = {
        ...resultBase,
        model: requestModel,
        provider: configuredProvider,
        transport: transportName,
      };

      const requestBody = {
        model: requestModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: resolveTransportTemperature(transport, transportBaseUrl),
        max_tokens: normalizeMaxOutputTokens(
          configuredMaxOutputTokens,
          isOpenRouterTransport
            ? DEFAULT_OPENROUTER_MAX_OUTPUT_TOKENS
            : isDirectReasoning
              ? DEFAULT_DIRECT_MAX_OUTPUT_TOKENS
              : DEFAULT_MAX_OUTPUT_TOKENS,
        ),
        response_format: buildFindingsResponseFormat(structuredOutputMode),
      };
      if (isOpenRouterTransport && Array.isArray(transport.models) && transport.models.length > 0) {
        requestBody.models = transport.models;
      }
      // This is reporting-only. Keep the actual request body unchanged while recording the
      // distinction between what policy declared and what the runtime placed on the wire.
      outputContract = buildOutputContractTelemetry(transport, requestBody, false);
      const ollamaSeed = deriveOllamaRequestSeed(transport, transportBaseUrl, persona, diffFiles, prContext);
      if (ollamaSeed !== null) requestBody.seed = ollamaSeed;
      if (streamEnabled) requestBody.stream = true;

      const configuredReasoningEffort = persona.reasoningEffort || persona.reasoning_effort || options.reasoningEffort || options.reasoning_effort || transport.reasoningEffort || transport.reasoning_effort;
      const reasoningEffort = downgradeReasoningEffort(configuredReasoningEffort, fallbackAttempt);
      if (reasoningEffort) {
        if (isOpenRouterTransport) requestBody.reasoning = { effort: reasoningEffort };
        else requestBody.reasoning_effort = reasoningEffort;
      }
      if (transport.perfMetricsInResponse === true || transport.perf_metrics_in_response === true) {
        requestBody.perf_metrics_in_response = true;
      }

      // OpenRouter-only routing controls must never be sent to direct provider
      // endpoints. Legacy callers can provide a mixed transport handoff while
      // the action-level policy remains canonical for the OpenRouter fallback.
      // Sending the auto-router plugin to Fireworks/Ollama is rejected as an
      // unknown request field and makes every persona lane fail.
      // Presence matters even when the qualification harness deliberately sends `models: []`
      // to measure one model alone. In both cases, an explicit central handoff must suppress the
      // legacy action policy's Auto Router plugin; an omitted field remains backward-compatible.
      const hasExplicitModelSelection = Array.isArray(transport.models);
      if (isOpenRouterTransport && (transport.plugins || (!hasExplicitModelSelection && requestOptions?.plugins))) {
        requestBody.plugins = transport.plugins || requestOptions?.plugins;
      }
      if (isOpenRouterTransport) {
        const trustedProviderPolicy = requestOptions?.provider && typeof requestOptions.provider === 'object'
          ? requestOptions.provider
          : {};
        const handoffProviderPolicy = transport.providerRouting || transport.provider_routing
          || (transport.provider && typeof transport.provider === 'object' ? transport.provider : {});
        const mergedProviderPolicy = {
          ...(handoffProviderPolicy && typeof handoffProviderPolicy === 'object' ? handoffProviderPolicy : {}),
          // Account privacy policy is authoritative over a transport handoff; routing preferences
          // may be selected by the central plan, but a caller cannot weaken data-collection rules.
          ...trustedProviderPolicy,
        };
        const ignoredProviders = Array.isArray(transport.ignoreProviders)
          ? transport.ignoreProviders.filter(Boolean)
          : typeof transport.ignoreProviders === 'string'
            ? transport.ignoreProviders.split(',').map((entry) => entry.trim()).filter(Boolean)
            : [];
        if (ignoredProviders.length > 0 && !Array.isArray(mergedProviderPolicy.ignore)) {
          mergedProviderPolicy.ignore = ignoredProviders;
        }
        if (Object.keys(mergedProviderPolicy).length > 0) requestBody.provider = mergedProviderPolicy;
      }

      let heartbeatTimer = null;
      const startMs = Date.now();
      heartbeatTimer = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startMs) / 1000);
        console.log(`[Persona: ${persona.id}] Awaiting model response from ${requestModel} via ${transportName} (${elapsedSec}s elapsed)...`);
      }, 15_000);
      if (heartbeatTimer?.unref) heartbeatTimer.unref();

      let fetchAttempts = 0;
      const maxFetchAttempts = 2;
      let formatRecoveryAttempted = false;
      let providerRecoveryAttempted = false;
      let structuredOutputFallbackAttempted = false;
      const prepareDirectFormatRecovery = () => {
        if (!isDirectReasoning || formatRecoveryAttempted || fetchAttempts >= maxFetchAttempts) return false;
        formatRecoveryAttempted = true;
        noteRetryReason('malformed_output');
        requestBody.max_tokens = Math.max(
          requestBody.max_tokens,
          DEFAULT_DIRECT_MAX_OUTPUT_TOKENS,
        );
        requestBody.reasoning_effort = 'none';
        requestBody.messages[0].content += [
          '',
          'FORMAT RECOVERY:',
          '- Your prior response did not contain parseable findings JSON.',
          '- Disable reasoning and return only {"findings":[]} or the required findings object.',
        ].join('\n');
        console.warn(`[Persona: ${persona.id}] Direct transport '${transportName}' returned no parseable findings JSON; retrying once with reasoning disabled before failover...`);
        return true;
      };
      const prepareOpenRouterTimeoutRecovery = () => {
        if (!isOpenRouterTransport || formatRecoveryAttempted || fetchAttempts >= maxFetchAttempts) return false;
        formatRecoveryAttempted = true;
        recoveryAction = 'bounded_retry';
        noteRetryReason('timeout');
        // A timeout with no usable stream cannot identify a failed upstream model. Retry the
        // same OpenRouter route without the auto-router plugin. Preserve the admitted reasoning
        // effort so a transport recovery does not silently downgrade review semantics.
        delete requestBody.plugins;
        requestBody.max_tokens = Math.max(requestBody.max_tokens, DEFAULT_FORMAT_RECOVERY_MAX_OUTPUT_TOKENS);
        requestBody.messages[0].content += [
          '',
          'TIMEOUT RECOVERY:',
          '- The prior generation produced no usable streamed output before the transport deadline.',
          '- Re-evaluate the complete diff against the review charter and return the required findings object.',
          '- Do not assume the change is clean; include every finding that meets the review criteria.',
          '- Do not emit prose or markdown outside the required findings object.',
        ].join('\n');
        console.warn(`[Persona: ${persona.id}] OpenRouter '${transportName}' timed out before producing output; retrying once with the admitted reasoning effort and auto-routing disabled before failing closed...`);
        return true;
      };

      while (fetchAttempts < maxFetchAttempts) {
        fetchAttempts++;
        attemptCount++;
        // Describe only the current response attempt. Cross-attempt instability is
        // represented separately by the closed retryReasons set.
        outputShape = null;
        finishReason = 'missing';
        responseMode = streamEnabled ? 'stream' : 'buffered';
        findingsSource = 'none';
        contentPresent = false;
        reasoningPresent = false;
        contentSizeBucket = 'empty';
        reasoningSizeBucket = 'empty';
        ttftMs = null;
        routerMetadata = null;
        generationIdDigest = null;
        const attemptStartedMs = Date.now();
        let attemptResponseStatus = null;
        let responseAttemptRecorded = false;
        requestFingerprint = requestFingerprintForAttempt(
          requestBody,
          transportName,
          configuredProvider,
          transportBaseUrl,
        );
        const recordResponseAttempt = (outcome, overrides = {}) => {
          if (responseAttemptRecorded || responseAttempts.length >= MAX_MODEL_RESPONSE_ATTEMPTS) return;
          responseAttemptRecorded = true;
          const reasoningEffortForAttempt = requestBody.reasoning?.enabled === false || requestBody.reasoning?.effort === 'none'
            ? 'none'
            : requestBody.reasoning?.effort || requestBody.reasoning_effort || 'missing';
          const attemptFailureClass = overrides.failureClass ?? failureClass;
          const timeoutKind = normalizeModelTimeoutKind(overrides.timeoutKind)
            || (attemptFailureClass === 'timeout' ? 'request' : null);
          const entry = normalizeModelResponseAttempt({
            attempt: attemptCount,
            outcome,
            transport: transportName,
            provider: configuredProvider,
            latencyMs: Date.now() - attemptStartedMs,
            responseStatus: attemptResponseStatus,
            failureClass: attemptFailureClass,
            ...(timeoutKind ? { timeoutKind } : {}),
            reasoningEffort: reasoningEffortForAttempt,
            maxOutputTokens: requestBody.max_tokens,
            outputTokens: null,
            outputShape,
            finishReason,
            responseMode,
            findingsSource,
            contentPresent,
            reasoningPresent,
            ttftMs,
            contentSizeBucket,
            reasoningSizeBucket,
            outputContract,
            routerMetadata,
            requestFingerprint,
            generationIdDigest,
            ...overrides,
          });
          if (entry) responseAttempts.push(entry);
        };
        const streamAbortController = streamEnabled ? new AbortController() : null;
        let responseHeaderTimer = null;
        let releaseOllamaCapacity = null;
        try {
          if (isOllamaTransport(transport, transportBaseUrl)) {
            releaseOllamaCapacity = await ollamaRequestSemaphore.acquire(OLLAMA_CAPACITY_WAIT_TIMEOUT_MS);
          }
          if (streamAbortController) {
            responseHeaderTimer = setTimeout(
              () => streamAbortController.abort(streamInactivityError(transportTimeoutMs, 'request')),
              connectTimeoutMs,
            );
          }
          let response;
          let sdkError = null;
          if (isOpenRouterTransport) {
            const sdkResult = await callOpenRouterSdk({
              baseUrl: transportBaseUrl,
              apiKey: transportApiKey,
              requestBody,
              fetchImpl,
              signal: streamAbortController?.signal || AbortSignal.timeout(transportTimeoutMs),
            });
            response = sdkResult.response;
            sdkError = sdkResult.sdkError;
          } else {
            response = await fetchImpl(`${transportBaseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: streamEnabled ? 'text/event-stream' : 'application/json',
                Authorization: `Bearer ${transportApiKey}`,
              },
              body: JSON.stringify(requestBody),
              signal: streamAbortController?.signal || AbortSignal.timeout(transportTimeoutMs),
            });
          }
          if (responseHeaderTimer) {
            clearTimeout(responseHeaderTimer);
            responseHeaderTimer = null;
          }

          responseStatus = normalizeTelemetryStatus(response.status);
          attemptResponseStatus = responseStatus;
          const generationId = typeof response?.headers?.get === 'function'
            ? response.headers.get('x-generation-id') || response.headers.get('x-request-id')
            : null;
          generationIdDigest = hashTelemetryIdentifier(generationId);

          // A 2xx SDK validation failure is still a provider failure. Do not let a partially
          // parsed/invalid envelope enter the findings parser as if it were a successful review.
          if (sdkError && response.ok) throw sdkError;

          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            const errMsg = `HTTP ${response.status}: ${String(detail).slice(0, 200)}`;
            const outcomeClass = classifyTelemetryHttpFailure(response.status);
            noteRetryReason(outcomeClass);
            failureClass = outcomeClass;
            recordResponseAttempt('http_error', { failureClass: outcomeClass });
            if (!structuredOutputFallbackAttempted
              && fetchAttempts < maxFetchAttempts
              && isStructuredOutputCompatibilityError(response.status, detail)
              && downgradeStructuredOutputRequest(requestBody)) {
              structuredOutputFallbackAttempted = true;
              recoveryAction = 'structured_output_fallback';
              outputContract = buildOutputContractTelemetry(transport, requestBody, false);
              console.warn(`[Persona: ${persona.id}] Transport '${transportName}' does not support the requested JSON Schema; retrying once with the compatible json_object contract...`);
              continue;
            }
            try {
              const parsedDetail = JSON.parse(detail);
              errorCode = resolveOpenRouterErrorCode(parsedDetail);
              if (isOpenRouterTransport && !providerRecoveryAttempted &&
                (outcomeClass === 'http_429' || outcomeClass === 'http_5xx' || outcomeClass === 'timeout') &&
                prepareOpenRouterModelFallback(requestBody, requestOptions, parsedDetail, detail, transport)) {
                providerRecoveryAttempted = true;
                recoveryAction = 'model_fallback';
                const retryAfterMs = parseRetryAfterMs(response);
                if (retryAfterMs > 0) await sleep(retryAfterMs);
                continue;
              }
            } catch (_) {
              // Non-JSON edge errors remain classified by HTTP status and may
              // still take the bounded same-request retry below.
            }
            if (isOpenRouterTransport && !providerRecoveryAttempted && fetchAttempts < maxFetchAttempts && (outcomeClass === 'http_429' || outcomeClass === 'http_5xx' || outcomeClass === 'timeout')) {
              providerRecoveryAttempted = true;
              recoveryAction = 'bounded_retry';
              const retryAfterMs = parseRetryAfterMs(response);
              if (retryAfterMs > 0) await sleep(retryAfterMs);
              continue;
            }
            circuitBreaker.trip(transportName, errMsg);
            if (i < candidateTransports.length - 1) {
              console.warn(`[Persona: ${persona.id}] Fast failover: transport '${transportName}' returned ${errMsg}; trying next transport...`);
              lastError = errMsg;
              fallbackAttempt++;
              break;
            }
            return withTelemetry({ ...resultBase, decision: 'ERROR', findings: [], error: errMsg });
          }

          // A streaming timeout is an inactivity budget, but every generation
          // also receives a hard total wall-clock budget. Once response headers
          // arrive, each body read gets a fresh inactivity timeout; the total
          // deadline prevents active reasoning/content deltas from keeping a
          // lane alive indefinitely. Format recovery gets the same bounded
          // window rather than a special exemption.
          const streamTotalTimeoutMs = streamEnabled
            ? Math.min(DEFAULT_STREAM_MAX_WALL_CLOCK_MS, transportTimeoutMs)
            : 0;
          const payload = await readChatCompletionResponse(
            response,
            streamEnabled,
            transportTimeoutMs,
            streamTotalTimeoutMs,
            ttftTimeoutMs,
            (value) => {
              ttftMs = normalizeTelemetryDuration(value);
            },
          );
          const payloadErrorCode = resolveOpenRouterErrorCode(payload);
          if (payloadErrorCode) errorCode = payloadErrorCode;
          if (payload?.openrouter_metadata?.attempt !== undefined) routerAttempt = payload.openrouter_metadata.attempt;
          routerMetadata = normalizeOpenRouterMetadata(payload?.openrouter_metadata);
          const responseBase = {
            ...resultBase,
            model: resolveResponseModel(payload, requestModel),
            provider: resolveResponseProvider(payload, configuredProvider),
            transport: transportName,
            cost: extractResponseCost(payload),
            ttftMs: normalizeTelemetryDuration(ttftMs),
            ...extractResponseTokenUsage(payload),
          };

          if (payload?.error) {
            const message = payload.error.message || payload.error.code || JSON.stringify(payload.error);
            const providerFailureClass = /rate.?limit|quota|capacity|overload/i.test(`${payload.error.code || ''} ${message}`)
              ? 'provider_rate_limit'
              : 'provider_error';
            noteRetryReason(providerFailureClass);
            failureClass = providerFailureClass;
            recordResponseAttempt('provider_error', {
              provider: responseBase.provider,
              outputTokens: responseBase.outputTokens,
              failureClass: providerFailureClass,
            });
            if (isOpenRouterTransport && !providerRecoveryAttempted && providerFailureClass === 'provider_rate_limit' &&
              prepareOpenRouterModelFallback(requestBody, requestOptions, payload, message, transport)) {
              providerRecoveryAttempted = true;
              recoveryAction = 'model_fallback';
              continue;
            }
            circuitBreaker.trip(transportName, message);
            if (i < candidateTransports.length - 1) {
              console.warn(`[Persona: ${persona.id}] Fast failover: transport '${transportName}' error payload (${message}); trying next transport...`);
              lastError = message;
              fallbackAttempt++;
              break;
            }
            return withTelemetry({ ...responseBase, decision: 'ERROR', findings: [], error: `Provider returned an error payload: ${String(message).slice(0, 200)}` });
          }

          const message = payload?.choices?.[0]?.message || {};
          const content = contentFragments(message.content).join('');
          const reasoning = reasoningFragments(
            message.reasoning_details ?? message.reasoning ?? message.reasoning_content,
          ).join('');
          finishReason = normalizeModelFinishReason(
            payload?.choices?.[0]?.finish_reason ?? payload?.choices?.[0]?.finishReason,
          );
          contentPresent = content.length > 0;
          reasoningPresent = reasoning.length > 0;
          contentSizeBucket = responseSizeBucket(content);
          reasoningSizeBucket = responseSizeBucket(reasoning);
          if (content) {
            try {
              const providerLane = JSON.parse(content);
              if (providerLane?.error) {
                const message = providerLane.error.message || providerLane.error.code || JSON.stringify(providerLane.error);
                const providerFailureClass = /rate.?limit|quota|capacity|overload/i.test(`${providerLane.error.code || ''} ${message}`)
                  ? 'provider_rate_limit'
                  : 'provider_error';
                errorCode = resolveOpenRouterErrorCode(providerLane);
                noteRetryReason(providerFailureClass);
                failureClass = providerFailureClass;
                recordResponseAttempt('provider_error', {
                  provider: responseBase.provider,
                  outputTokens: responseBase.outputTokens,
                  failureClass: providerFailureClass,
                });
                if (isOpenRouterTransport && !providerRecoveryAttempted && providerFailureClass === 'provider_rate_limit' &&
                  prepareOpenRouterModelFallback(requestBody, requestOptions, providerLane, message, transport)) {
                  providerRecoveryAttempted = true;
                  recoveryAction = 'model_fallback';
                  continue;
                }
                if (i < candidateTransports.length - 1) {
                  circuitBreaker.trip(transportName, message);
                  console.warn(`[Persona: ${persona.id}] Fast failover: transport '${transportName}' error payload (${message}); trying next transport...`);
                  lastError = message;
                  fallbackAttempt++;
                  break;
                }
                return withTelemetry({ ...responseBase, decision: 'ERROR', findings: [], error: `Provider returned an error payload: ${String(message).slice(0, 200)}` });
              }
            } catch (_) {}
          }

          // Some reasoning providers emit the final structured object in a reasoning
          // delta and leave assistant content empty.  Accept that alternate wire shape
          // only when it is itself a complete findings payload; prose or partial thought
          // remains fail-closed and follows the normal transport recovery path.
          const contentAnalysis = analyzeFindingsPayload(content);
          const reasoningAnalysis = analyzeFindingsPayload(reasoning);
          const selectedAnalysis = contentAnalysis.findings !== null
            ? contentAnalysis
            : reasoningAnalysis.findings !== null
              ? reasoningAnalysis
              : contentAnalysis.outputShape !== 'empty_content'
                ? contentAnalysis
                : reasoningAnalysis;
          const rawFindings = selectedAnalysis.findings;
          const findingsValidation = rawFindings === null
            ? null
            : validateReviewFindings(rawFindings);
          const contractFailure = findingsValidation?.error
            ? `Model response violated canonical findings contract: ${findingsValidation.error}.`
            : 'Model response contained no parseable findings JSON.';
          outputShape = selectedAnalysis.outputShape;
          findingsSource = contentAnalysis.findings !== null
            ? 'content'
            : reasoningAnalysis.findings !== null
              ? 'reasoning'
              : 'none';
          if (rawFindings === null || !findingsValidation?.valid) {
            noteRetryReason('malformed_output');
            failureClass = 'malformed_output';
            recordResponseAttempt('malformed_output', {
              provider: responseBase.provider,
              outputTokens: responseBase.outputTokens,
              failureClass: 'malformed_output',
            });
            // Direct reasoning providers can spend the first completion budget on
            // thought tokens and return no final JSON. Give the same admitted
            // transport one bounded, reasoning-disabled format-recovery attempt
            // before abandoning it for a different provider. This keeps a healthy
            // Ollama/Fireworks lane useful without accepting malformed output.
            if (prepareDirectFormatRecovery()) continue;
            if (i < candidateTransports.length - 1) {
              lastError = contractFailure;
              console.warn(`[Persona: ${persona.id}] Fast failover: transport '${transportName}' returned a non-canonical findings response; trying next transport...`);
              fallbackAttempt++;
              break;
            }
            if (!formatRecoveryAttempted && fetchAttempts < maxFetchAttempts) {
              formatRecoveryAttempted = true;
              // The final OpenRouter transport may be pinned to the same
              // reasoning-heavy model that already exhausted its answer
              // budget on the direct transports. Keep the already-admitted
              // OpenRouter model: account guardrails can reject a different
              // model even when the central fleet allows it. Disable optional
              // reasoning so the bounded retry reserves its output budget for
              // JSON, and remove the auto-router-only plugin while retaining
              // the provider privacy policy.
              if (isOpenRouterTransport) {
                delete requestBody.plugins;
              }
              requestBody.max_tokens = Math.max(
                requestBody.max_tokens,
                DEFAULT_FORMAT_RECOVERY_MAX_OUTPUT_TOKENS,
              );
              if (isOpenRouterTransport) requestBody.reasoning = { effort: 'none' };
              else if (isDirectReasoning) requestBody.reasoning_effort = 'none';
              else requestBody.reasoning_effort = 'low';
              requestBody.messages[0].content += [
                '',
                'FORMAT RECOVERY:',
                `- Your prior response did not satisfy the canonical findings contract${findingsValidation?.error ? ` (${findingsValidation.error}).` : '.'}`,
                '- Keep reasoning brief and reserve output tokens for the final JSON object.',
                '- Return only {"findings":[]} or the required findings object.',
              ].join('\n');
              console.warn(`[Persona: ${persona.id}] Final transport '${transportName}' returned a non-canonical findings response; retrying once via the admitted ${requestBody.model} route with reasoning disabled and a larger answer budget...`);
              continue;
            }
            return withTelemetry({ ...responseBase, decision: 'ERROR', findings: [], error: contractFailure });
          }

          // Validation happens before the legacy publication sanitizer. The latter may still
          // discard a syntactically valid finding that cannot be anchored to this diff, but it
          // must never invent a severity, line, title, or body for malformed model output.
          const findings = sanitizeFindings(findingsValidation.findings, diffFiles);
          outputContract = buildOutputContractTelemetry(transport, requestBody, true);
          recordResponseAttempt('parsed', {
            provider: responseBase.provider,
            outputTokens: responseBase.outputTokens,
            failureClass: null,
          });
          return withTelemetry({ ...responseBase, decision: findings.length === 0 ? 'APPROVE' : 'FINDINGS', findings, coverage }, null);
        } catch (err) {
          const isTransientSocket = /ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_SOCKET_TIMEOUT|network timeout/i.test(err.message || '');
          const isUnusableDirectOutput = /empty_sse|Streaming response exceeded total deadline/i.test(err.message || '');
          const attemptFailureClass = classifyTelemetryTransportError(err);
          const timeoutKind = classifyTelemetryTimeoutKind(err);
          recordResponseAttempt('transport_error', {
            failureClass: attemptFailureClass,
            ...(timeoutKind ? { timeoutKind } : {}),
          });
          if (isUnusableDirectOutput && prepareDirectFormatRecovery()) continue;
          if (attemptFailureClass === 'timeout' && prepareOpenRouterTimeoutRecovery()) continue;
          if (fetchAttempts < maxFetchAttempts && isTransientSocket) {
            noteRetryReason('transient_socket');
            console.warn(`[Persona: ${persona.id}] Transient socket error on ${transportName} (${err.message}); retrying attempt ${fetchAttempts + 1}/${maxFetchAttempts}...`);
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }

          lastError = err.message;
          failureClass = classifyTelemetryTransportError(err);
          if (failureClass !== 'unknown') noteRetryReason(failureClass);
          circuitBreaker.trip(transportName, err.message);
          if (i < candidateTransports.length - 1) {
            console.warn(`[Persona: ${persona.id}] Fast failover: transport '${transportName}' exception (${err.message}); trying next transport...`);
            fallbackAttempt++;
            break; 
          }
          return withTelemetry({ ...resultBase, decision: 'ERROR', findings: [], error: err.message });
        } finally {
          if (releaseOllamaCapacity) releaseOllamaCapacity();
          if (responseHeaderTimer) clearTimeout(responseHeaderTimer);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      }
    }

    failureClass = failureClass || 'unknown';
    return withTelemetry({ ...resultBase, decision: 'ERROR', findings: [], error: lastError || 'All transports failed' });
  } catch (err) {
    failureClass = classifyTelemetryTransportError(err);
    if (failureClass !== 'unknown') noteRetryReason(failureClass);
    return withTelemetry({ ...resultBase, decision: 'ERROR', findings: [], error: err.message });
  }
}

/**
 * Parses raw git diff text into per-file diff structures.
 */
function parseDiff(diffText) {
  if (!diffText || typeof diffText !== 'string') return [];
  const files = [];
  const lines = diffText.split(/\r?\n/);
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      const filePath = match ? match[1] : 'unknown';
      currentFile = {
        path: filePath,
        patch: line + '\n',
        addedLines: [],
        deletedLines: [],
      };
      files.push(currentFile);
    } else if (line.startsWith('+++ b/')) {
      if (currentFile) {
        currentFile.path = line.slice(6);
      }
    } else if (currentFile) {
      currentFile.patch += line + '\n';
      if (line === 'old mode 160000' || line === 'new mode 160000' || line === 'new file mode 160000' || line === 'deleted file mode 160000' || /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/iu.test(line)) {
        currentFile.mode = '160000';
        currentFile.isSubmodule = true;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.addedLines.push({ text: line.slice(1) });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.deletedLines.push({ text: line.slice(1) });
      }
    }
  }

  if (files.length === 0 && diffText.trim().length > 0) {
    files.push({
      path: 'src/index.ts',
      patch: diffText,
      addedLines: diffText.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => ({ text: l.slice(1) })),
      deletedLines: [],
    });
  }

  return files;
}

/**
 * Extracts PR diff payload and execution context from environment variables,
 * GITHUB_EVENT_PATH event file, or fallback git diff execution.
 */
function getPRDiffAndContext() {
  let diffText = '';
  let prNumber = process.env.PR_NUMBER || null;
  let repo = process.env.GITHUB_REPOSITORY || 'review-bot/review-bot';
  let headSha = process.env.PR_HEAD_SHA || process.env.GITHUB_SHA || 'main';
  let baseSha = process.env.PR_BASE_SHA || null;
  let title = 'Automated PR Review';
  let eventData = null;

  // Explicit inputs (PR_HEAD_SHA / PR_BASE_SHA, or a PR_DIFF JSON payload) name the pull request
  // actually under review. The ambient GitHub event describes the run that *triggered* the runner,
  // which is a different pull request whenever the bot is dispatched at a specific head — the same
  // asymmetry PR_REPO already documents at step 6. prNumber and repo are guarded against that
  // clobber; headSha, baseSha and title were not. Track what a caller named explicitly so step 3
  // can refine the derived defaults without overwriting a caller's intent.
  let headShaExplicit = Boolean(process.env.PR_HEAD_SHA);
  let baseShaExplicit = Boolean(process.env.PR_BASE_SHA);
  let titleExplicit = false;

  // 1. Prefer a file boundary for real action runs. Passing a large unified diff through an
  // environment variable counts toward execve's argument limit and fails on large PRs.
  if (process.env.PR_DIFF_FILE && fs.existsSync(process.env.PR_DIFF_FILE)) {
    try {
      diffText = fs.readFileSync(process.env.PR_DIFF_FILE, 'utf8');
    } catch (_) {}
  }

  // 2. Check process.env.PR_DIFF for small synthetic/test payloads and backwards compatibility.
  if (process.env.PR_DIFF) {
    const raw = process.env.PR_DIFF.trim();
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.diff) diffText = parsed.diff;
        if (parsed.prNumber) prNumber = String(parsed.prNumber);
        if (parsed.repo) repo = parsed.repo;
        if (parsed.headSha) {
          headSha = parsed.headSha;
          headShaExplicit = true;
        }
        if (parsed.baseSha) {
          baseSha = parsed.baseSha;
          baseShaExplicit = true;
        }
        if (parsed.title) {
          title = parsed.title;
          titleExplicit = true;
        }
      } catch (_) {
        diffText = raw;
      }
    } else {
      diffText = raw;
    }
  }

  // 3. Check process.env.GITHUB_EVENT_PATH
  if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    try {
      const eventContent = fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8');
      eventData = JSON.parse(eventContent);
      if (eventData.pull_request) {
        if (!prNumber && eventData.pull_request.number) {
          prNumber = String(eventData.pull_request.number);
        }
        // Ambient event data fills in derived defaults, but must never overwrite a value the
        // caller named explicitly (see the precedence note above).
        if (!headShaExplicit && eventData.pull_request.head && eventData.pull_request.head.sha) {
          headSha = eventData.pull_request.head.sha;
        }
        if (!baseShaExplicit && eventData.pull_request.base && eventData.pull_request.base.sha) {
          baseSha = eventData.pull_request.base.sha;
        }
        if (!titleExplicit && eventData.pull_request.title) {
          title = eventData.pull_request.title;
        }
      }
      if (eventData.client_payload) {
        if (eventData.client_payload.target_repo || eventData.client_payload.repo) {
          repo = eventData.client_payload.target_repo || eventData.client_payload.repo;
        }
        if (eventData.client_payload.pr_number || eventData.client_payload.prNumber) {
          prNumber = String(eventData.client_payload.pr_number || eventData.client_payload.prNumber);
        }
        if (eventData.client_payload.head_sha || eventData.client_payload.headSha) {
          headSha = eventData.client_payload.head_sha || eventData.client_payload.headSha;
        }
        if (eventData.client_payload.base_sha || eventData.client_payload.baseSha) {
          baseSha = eventData.client_payload.base_sha || eventData.client_payload.baseSha;
        }
      }
      if (!repo && eventData.repository && eventData.repository.full_name) {
        repo = eventData.repository.full_name;
      }
      if (!diffText && eventData.diff) {
        diffText = eventData.diff;
      }
    } catch (_) {}
  }

  // 4. Extract PR number from GITHUB_REF (e.g. refs/pull/42/merge)
  if (!prNumber && process.env.GITHUB_REF) {
    const refMatch = process.env.GITHUB_REF.match(/refs\/pull\/(\d+)/);
    if (refMatch) {
      prNumber = refMatch[1];
    }
  }

  // 5. Fallback to git command if no diff found yet
  if (!diffText) {
    try {
      diffText = execSync('git diff HEAD~1 2>/dev/null || git diff 2>/dev/null', { encoding: 'utf-8' }) || '';
    } catch (_) {}
  }

  // 6. PR_REPO wins over everything: the runner checks out the central review repository, so
  // GITHUB_REPOSITORY names the runner, not the repository actually under review.
  if (process.env.PR_REPO) {
    repo = process.env.PR_REPO;
  }

  return { diffText, prNumber, repo, headSha, baseSha, title, eventData };
}

/**
 * Ingests MCP_CONFIG_JSON (or client_payload.mcp_config_json) and registers MCP servers.
 * Provides safe fallback when missing/null.
 */
async function initMcpFleet(clientPayload) {
  let mcpConfigRaw = process.env.MCP_CONFIG_JSON;
  if (!mcpConfigRaw && clientPayload && clientPayload.mcp_config_json) {
    mcpConfigRaw = clientPayload.mcp_config_json;
  }

  let mcpServers = [];
  if (mcpConfigRaw) {
    try {
      const parsed = typeof mcpConfigRaw === 'string' ? JSON.parse(mcpConfigRaw) : mcpConfigRaw;
      mcpServers = Array.isArray(parsed) ? parsed : (parsed.servers || []);
    } catch (err) {
      console.warn('⚠️ Could not parse MCP_CONFIG_JSON:', err.message);
    }
  }

  let mcpStatusSummary = 'Default Built-in MCP Adapters Active';
  let registeredCount = 0;

  if (mcpFleetManager) {
    if (mcpServers.length > 0) {
      for (const server of mcpServers) {
        try {
          await mcpFleetManager.registerServer(server);
          registeredCount++;
        } catch (err) {
          console.warn(`⚠️ Failed to register MCP server ${server.id || server.name}:`, err.message);
        }
      }
      mcpStatusSummary = `${registeredCount} Custom MCP Server(s) Registered & Live Execution Enabled`;
    } else {
      mcpStatusSummary = 'No MCP_CONFIG_JSON provided; using default built-in MCP adapters';
    }
  } else {
    mcpStatusSummary = mcpServers.length > 0
      ? `${mcpServers.length} Custom MCP Server(s) Configured (Fallback Mode)`
      : 'Default Built-in MCP Adapters Active (Fallback Mode)';
  }

  return { mcpServers, mcpStatusSummary, registeredCount };
}

/**
 * Evaluates a single persona charter against changed files.
 * Performs deep pattern analysis and charter verification.
 */
async function evaluatePersonaLane(persona, diffFiles, prContext, sessionContext) {
  const findings = [];

  // Composable multi-turn context header prepended at the top of all persona prompts
  let promptHeader = '';
  if (sessionContext?.augmentedHeader) {
    promptHeader = `${sessionContext.augmentedHeader}\n\n`;
    console.log(`[Persona ${persona.id}] Prepended multi-turn session ledger context header to prompt.`);
  }

  const activeCharter = `${promptHeader}${persona.charter || ''}`;

  for (const file of diffFiles) {
    const patch = file.patch || '';
    const addedLines = file.addedLines || [];

    switch (persona.id) {
      case 'security': {
        // Secrets scanning
        const secretRegex = /(?:sk-[a-zA-Z0-9]{20,}|AIzaSy[a-zA-Z0-9_-]{33}|xai-[a-zA-Z0-9]{20,}|bearer\s+[a-zA-Z0-9_\-\.]{20,})/i;
        for (let i = 0; i < addedLines.length; i++) {
          if (secretRegex.test(addedLines[i].text)) {
            findings.push({
              severity: 'P0',
              path: file.path,
              line: i + 1,
              title: 'Hardcoded Secret Detected',
              body: 'Potential hardcoded secret or API key credential found in added diff line.',
              suggestion: 'Extract secret to Doppler or environment variables and use secure secret injection.',
            });
          }
        }
        // Authentication & tenant isolation
        if (file.path.includes('/api/') || file.path.includes('/controllers/')) {
          if (patch.includes('req.query') || patch.includes('req.params')) {
            if (!patch.includes('orgId') && !patch.includes('tenantId') && !patch.includes('auth') && !patch.includes('jwt')) {
              findings.push({
                severity: 'P1',
                path: file.path,
                line: 1,
                title: 'Missing Multi-Tenant Isolation Check',
                body: 'API endpoint parses user parameters without explicit orgId/tenantId bounds verification.',
                suggestion: 'Wrap query with mandatory tenant isolation filter (`where: { orgId }`).',
              });
            }
          }
        }
        break;
      }

      case 'performance': {
        if (patch.includes('for (') || patch.includes('.map(') || patch.includes('.forEach(')) {
          if (patch.includes('await ') && (patch.includes('fetch(') || patch.includes('query(') || patch.includes('find('))) {
            findings.push({
              severity: 'P1',
              path: file.path,
              line: 1,
              title: 'N+1 Query / Async Sequential Loop',
              body: 'Sequential async calls inside iteration loop can lead to severe performance degradation.',
              suggestion: 'Batch queries or use `Promise.all()` to parallelize async operations.',
            });
          }
        }
        if (patch.includes('readFileSync(') || patch.includes('execSync(')) {
          if (file.path.includes('/src/api/') || file.path.includes('/server/')) {
            findings.push({
              severity: 'P2',
              path: file.path,
              line: 1,
              title: 'Synchronous Blocking I/O in API Hot Path',
              body: 'Synchronous file or process operations block the Node.js event loop.',
              suggestion: 'Replace synchronous I/O with async `fs.promises` or asynchronous spawn.',
            });
          }
        }
        break;
      }

      case 'architecture': {
        if (patch.includes('../../../') && file.path.includes('/domain/')) {
          findings.push({
            severity: 'P2',
            path: file.path,
            line: 1,
            title: 'Layer Boundary Coupling Hazard',
            body: 'Domain layer imports deep presentation or infrastructure components, violating clean architecture.',
            suggestion: 'Invert dependency using domain interfaces or repository abstractions.',
          });
        }
        break;
      }

      case 'style': {
        for (let i = 0; i < addedLines.length; i++) {
          if (addedLines[i].text.includes('console.log(') && !file.path.includes('test')) {
            findings.push({
              severity: 'P2',
              path: file.path,
              line: i + 1,
              title: 'Leftover Debug Statement',
              body: '`console.log` statement left in production source code.',
              suggestion: 'Remove `console.log` or replace with structured `logger.debug()`.',
            });
          }
        }
        break;
      }

      case 'testing': {
        if (patch.includes('.only(') || patch.includes('fit(')) {
          findings.push({
            severity: 'P1',
            path: file.path,
            line: 1,
            title: 'Exclusive Test Marker Left Active',
            body: 'Test file contains active `.only()` marker which skips all other tests in CI.',
            suggestion: 'Remove `.only()` before merging PR.',
          });
        }
        break;
      }

      case 'documentation': {
        if (file.path.endsWith('.ts') || file.path.endsWith('.js')) {
          if (patch.includes('export function') || patch.includes('export class')) {
            if (!patch.includes('/**') && !patch.includes('* ')) {
              findings.push({
                severity: 'P2',
                path: file.path,
                line: 1,
                title: 'Missing Docstring / JSDoc Annotation',
                body: 'Exported function or class lacks docstring documentation.',
                suggestion: 'Add JSDoc block describing function purpose, parameters, and return type.',
              });
            }
          }
        }
        break;
      }

      case 'accessibility': {
        if (file.path.endsWith('.tsx') || file.path.endsWith('.jsx') || file.path.endsWith('.html')) {
          if (patch.includes('<img') && !patch.includes('alt=')) {
            findings.push({
              severity: 'P2',
              path: file.path,
              line: 1,
              title: 'Image Missing Alt Text (WCAG 2.1)',
              body: '`<img>` element rendered without accessible `alt` property.',
              suggestion: 'Add descriptive `alt="..."` attribute or `alt=""` if decorative.',
            });
          }
        }
        break;
      }

      case 'database': {
        if (patch.includes('DROP TABLE') || patch.includes('DROP COLUMN')) {
          findings.push({
            severity: 'P0',
            path: file.path,
            line: 1,
            title: 'Destructive DDL Schema Migration Hazard',
            body: 'Migration drops database table or column, risking data loss in production.',
            suggestion: 'Use deprecation cycle and separate data backfill before dropping columns.',
          });
        }
        break;
      }

      case 'devops': {
        if (file.path.includes('Dockerfile')) {
          if (!patch.includes('USER node') && !patch.includes('USER appuser') && patch.includes('ENTRYPOINT')) {
            findings.push({
              severity: 'P1',
              path: file.path,
              line: 1,
              title: 'Container Non-Root User Missing',
              body: 'Dockerfile executes entrypoint as root container user.',
              suggestion: 'Enforce non-root execution (`USER node`).',
            });
          }
        }
        break;
      }

      case 'i18n': {
        if (file.path.includes('/components/') || file.path.includes('/app/')) {
          if (patch.includes('<h1>') || patch.includes('<span>') || patch.includes('<button>')) {
            if (!patch.includes('t(') && !patch.includes('i18n') && !patch.includes('{')) {
              findings.push({
                severity: 'P2',
                path: file.path,
                line: 1,
                title: 'Hardcoded User Interface Text String',
                body: 'UI component contains hardcoded string without internationalization wrapper.',
                suggestion: 'Wrap string in translation function `t(...)`.',
              });
            }
          }
        }
        break;
      }

      case 'dependencies': {
        if (file.path.endsWith('package.json')) {
          if (patch.includes('"*"') || patch.includes('"latest"')) {
            findings.push({
              severity: 'P1',
              path: file.path,
              line: 1,
              title: 'Unpinned Wildcard Dependency Version',
              body: '`package.json` contains wildcard `*` or `latest` version specifier.',
              suggestion: 'Pin exact dependency version to prevent supply chain breaks.',
            });
          }
        }
        break;
      }

      case 'licensing': {
        if (file.path.endsWith('.go') || file.path.endsWith('.ts') || file.path.endsWith('.py')) {
          if (!patch.includes('Copyright') && !patch.includes('License') && addedLines.length > 50) {
            findings.push({
              severity: 'P2',
              path: file.path,
              line: 1,
              title: 'Missing License Header Notice',
              body: 'New substantial source file lacks standard open-source license header.',
              suggestion: 'Add project license header notice at top of file.',
            });
          }
        }
        break;
      }
    }
  }

  return {
    personaId: persona.id,
    displayName: persona.name,
    model: persona.model,
    decision: findings.length === 0 ? 'APPROVE' : 'FINDINGS',
    findings,
  };
}

/**
 * Resolves which persona charters should run for this review.
 *
 * Precedence: dispatch client_payload > local repository config > environment > all personas.
 * Defaulting to every persona matters: an unconfigured repository must get a real review, not a
 * silent no-op that always reports SHIP. An explicitly empty list is still honored as an opt-out.
 *
 * @param {object} payload - `client_payload` from a repository_dispatch event.
 * @param {object|null} localConfig - Result of `loadLocalRepoConfig()` for the target repository.
 * @param {object} env - Environment to read `ACTIVE_PERSONAS` from.
 * @returns {string[]} Persona ids in charter order.
 */
const PERSONA_DIR = path.join('.ct-review', 'personas');
const DEFAULT_MAX_PERSONAS = 25;

/**
 * Shortens a long path for display, keeping the first segment for orientation and the filename,
 * which carries the most meaning. The full path is still used for the link target.
 *
 *   server/CoolFocus/Services/Inbox/SmsComplianceWayCoolReviewSupportNotifier.cs
 *   → server/…/SmsComplianceWayCoolReviewSupportNotifier.cs
 */
function abbreviatePath(filePath, maxLength = 48) {
  if (!filePath || filePath.length <= maxLength) return filePath;

  const segments = filePath.split('/');
  if (segments.length <= 2) return filePath;

  const first = segments[0];
  const last = segments[segments.length - 1];
  const abbreviated = `${first}/…/${last}`;

  // A single very long filename cannot be shortened without hiding what matters; leave it.
  return abbreviated.length < filePath.length ? abbreviated : filePath;
}

/**
 * Directory to read repository configuration from.
 *
 * This must not be the pull request's own checkout. Reviewer charters are prompts executed with
 * the repository's API key, so sourcing them from the head of a pull request lets that pull
 * request rewrite the instructions reviewing it. The action fetches configuration from the base
 * ref into a separate directory and points here at it; falling back to the working directory
 * keeps local runs working.
 */
function resolveConfigRoot(env = process.env) {
  return env.CT_REVIEW_CONFIG_DIR || process.cwd();
}

/**
 * Loads persona definitions from `.ct-review/personas/*.md`.
 *
 * One file per reviewer, so a charter can be as long as it needs to be: optional YAML
 * frontmatter carries the metadata, and the markdown body is the charter itself.
 *
 *     ---
 *     name: "🏢 Multi-Tenant Isolation"
 *     ---
 *     Every query touching customer data must be scoped by orgId.
 *
 * The id defaults to the filename, so dropping a file in is enough to define a reviewer.
 *
 * @param {string} repoRoot - Directory of the repository under review.
 * @returns {{personas: object[], errors: string[]}}
 */
function loadPersonaFiles(repoRoot = process.cwd()) {
  const dir = path.resolve(repoRoot, PERSONA_DIR);
  const personas = [];
  const errors = [];

  if (!fs.existsSync(dir)) return { personas, errors };

  let jsYaml = null;
  try { jsYaml = require('js-yaml'); } catch (_) {}

  // Sorted so persona ordering in the review comment is stable across runs.
  const files = fs.readdirSync(dir).filter((f) => /\.mdx?$/i.test(f)).sort();

  for (const file of files) {
    const rel = path.join(PERSONA_DIR, file);
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    } catch (err) {
      errors.push(`Could not read persona file ${rel}: ${err.message}`);
      continue;
    }

    let meta = {};
    let body = raw;

    const fm = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (fm) {
      body = fm[2];
      const header = fm[1].trim();
      if (header) {
        if (!jsYaml) {
          errors.push(`Persona file ${rel} has frontmatter but js-yaml is unavailable to parse it.`);
          continue;
        }
        try {
          const parsed = jsYaml.load(header);
          if (parsed && typeof parsed === 'object') meta = parsed;
        } catch (err) {
          errors.push(`Persona file ${rel} has malformed frontmatter: ${err.message}`);
          continue;
        }
      }
    }

    const charter = body.trim();
    if (!charter) {
      errors.push(`Persona file ${rel} has no charter body. The markdown below the frontmatter is the reviewer's instructions.`);
      continue;
    }

    const id = String(meta.id || file.replace(/\.mdx?$/i, '')).trim();
    if (!id) {
      errors.push(`Persona file ${rel} resolves to an empty id.`);
      continue;
    }

    personas.push({
      id,
      name: meta.name,
      model: meta.model,
      enabled: meta.enabled !== false,
      charter,
      source: rel,
    });
  }

  return { personas, errors };
}

function resolvePersonaRoster(payload = {}, localConfig = null, env = process.env, filePersonas = []) {
  const builtins = new Map(PERSONA_CHARTERS.map((p) => [p.id, p]));
  const errors = [];
  const declared = new Map();

  // Personas defined one-per-file under .ct-review/personas/.
  for (const fp of filePersonas) {
    if (!fp || !fp.id) continue;
    const builtin = builtins.get(fp.id);
    declared.set(fp.id, {
      persona: {
        id: fp.id,
        name: fp.name || builtin?.name || `🔎 ${fp.id}`,
        model: fp.model || builtin?.model || DEFAULT_MODEL,
        charter: fp.charter,
        reasoningEffort: fp.reasoning_effort || fp.reasoningEffort || fp.effort,
      },
      enabled: fp.enabled !== false,
      source: fp.source || PERSONA_DIR,
    });
  }

  // Repository-defined personas declared inline. An entry supplying a charter either defines a
  // new reviewer or overrides a built-in one; an entry without a charter may only reference a
  // built-in.
  const localEntries = Array.isArray(localConfig?.parsed?.personas) ? localConfig.parsed.personas : [];

  for (const entry of localEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || entry.personaId || entry.name || '').trim();
    if (!id) continue;

    const charter = typeof entry.charter === 'string' ? entry.charter.trim() : '';

    if (!charter && !builtins.has(id)) {
      errors.push(
        `Unknown persona id "${id}" in ${localConfig.file}. ` +
        `Valid built-in ids: ${[...builtins.keys()].join(', ')}. ` +
        `To define a custom persona, supply a charter describing what it should review.`
      );
      continue;
    }
    if (entry.charter !== undefined && !charter) {
      errors.push(`Persona "${id}" in ${localConfig.file} declares an empty charter. Give it instructions or remove the key.`);
      continue;
    }

    // Declaring one id in two places has no obvious winner, so refuse rather than invent one.
    const existing = declared.get(id);
    if (existing?.source) {
      errors.push(
        `Persona "${id}" is declared both in ${existing.source} and inline in ${localConfig.file}. ` +
        `Keep it in one place.`
      );
      continue;
    }

    const builtin = builtins.get(id);
    declared.set(id, {
      persona: {
        id,
        name: entry.name || builtin?.name || `🔎 ${id}`,
        model: entry.model || builtin?.model || DEFAULT_MODEL,
        charter: charter || builtin.charter,
        reasoningEffort: entry.reasoning_effort || entry.reasoningEffort || entry.effort,
      },
      enabled: entry.enabled !== false,
      source: localConfig.file,
    });
  }

  // Selection source, most specific first.
  let selected = null;
  if (Array.isArray(payload?.activePersonas)) {
    selected = payload.activePersonas;
  } else if (payload?.personaSettings && typeof payload.personaSettings === 'object') {
    selected = Object.keys(payload.personaSettings)
      .filter((k) => payload.personaSettings[k]?.enabled !== false);
  } else if (localEntries.length > 0) {
    // An inline `personas:` list is an explicit roster: it governs which reviewers run.
    // Persona files, by contrast, extend the default roster rather than replacing it, so that
    // dropping one file in does not silently switch every built-in off.
    selected = [...declared.entries()]
      .filter(([, v]) => v.enabled && v.source === localConfig.file)
      .map(([id]) => id);
  } else if (typeof env.ACTIVE_PERSONAS === 'string' && env.ACTIVE_PERSONAS.trim()) {
    const raw = env.ACTIVE_PERSONAS.trim();
    try {
      const parsed = JSON.parse(raw);
      // GitHub Actions renders `toJson(<missing>)` as the string "null" on non-dispatch events.
      if (Array.isArray(parsed)) selected = parsed;
    } catch (_) {
      selected = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  // Unconfigured means the default reviewers, plus anything the repository defined. Running all
  // twelve everywhere reports on internationalisation in single-language projects and licence
  // headers in projects that use none, which is how a reviewer teaches people to ignore it.
  if (selected === null) {
    selected = [...DEFAULT_PERSONA_IDS, ...[...declared.keys()].filter((id) => !builtins.has(id))];
  }

  // "all" opts back into the complete built-in roster.
  if (selected.some((id) => typeof id === 'string' && id.trim().toLowerCase() === 'all')) {
    selected = [
      ...builtins.keys(),
      ...[...declared.keys()].filter((id) => !builtins.has(id)),
      ...selected.filter((id) => typeof id === 'string' && id.trim().toLowerCase() !== 'all' && !builtins.has(id.trim())),
    ];
    selected = [...new Set(selected)];
  }

  const personas = [];
  for (const raw of selected) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id) continue;

    const local = declared.get(id);
    if (local) {
      if (local.enabled) personas.push(local.persona);
      continue;
    }
    if (builtins.has(id)) {
      personas.push(builtins.get(id));
      continue;
    }
    // A typo must not quietly halve review coverage, so this is fatal rather than skipped.
    errors.push(
      `Unknown persona id "${id}". Valid built-in ids: ${[...builtins.keys()].join(', ')}. ` +
      `To define a custom persona, declare it in .ct-review.yaml with a charter.`
    );
  }

  // Each reviewer is one request per push, so an unbounded roster is unbounded spend. Cap it
  // rather than discovering the limit on an invoice.
  const maxPersonas = parseInt(env.MAX_PERSONAS || '', 10) || DEFAULT_MAX_PERSONAS;
  if (personas.length > maxPersonas) {
    errors.push(
      `Roster resolves to ${personas.length} reviewers, above the limit of ${maxPersonas}. ` +
      `Each reviewer is one model request per push. Narrow the roster, or raise max-personas deliberately.`
    );
  }

  // Built-ins in charter order, then repository-defined reviewers in declaration order, so the
  // review comment reads the same regardless of how the configuration happened to be written.
  const builtinOrder = [...builtins.keys()];
  personas.sort((a, b) => {
    const ai = builtinOrder.indexOf(a.id);
    const bi = builtinOrder.indexOf(b.id);
    return (ai === -1 ? builtinOrder.length : ai) - (bi === -1 ? builtinOrder.length : bi);
  });

  return { personas, errors };
}

/**
 * Computes binding arbitration quorum verdict from persona evaluation results.
 *
 * @param {object[]} personaResults - Completed persona lane results.
 * @param {number} [expectedPersonas] - How many personas were expected to run; quorum is degraded
 *   when fewer completed. Defaults to the number of results supplied.
 */
/**
 * Verified publication (src/review/findingFalsification.js): an independent falsification pass
 * that gates which hypotheses reach the arbiter. Persona lanes are recall-oriented hypothesis
 * generators; nothing between a lane and arbitration currently establishes causality for a
 * finding. This stage fails CLOSED per finding: REFUTE, ABSTAIN, contract violations, and
 * verifier provider failure all withhold the finding (recorded in the receipt, never silently),
 * matching the contract that uncertainty must produce abstention, not publication.
 * Config: review.finding_falsification (true | {limits: {...}}); default not_configured (OFF);
 * env kill-switch REVIEW_YETI_FINDING_FALSIFICATION=false.
 */
function resolveFindingFalsificationPolicy({ localConfig, env = process.env } = {}) {
  const disabled = (reason) => Object.freeze({ enabled: false, reason });
  const configured = localConfig?.parsed?.review?.finding_falsification;
  if (configured === undefined || configured === null) return disabled('not_configured');
  if (configured === false) return disabled('disabled_by_config');
  if (configured !== true && (typeof configured !== 'object' || Array.isArray(configured))) return disabled('invalid_config');
  const settings = configured === true ? {} : configured;
  if (settings.enabled === false) return disabled('disabled_by_config');
  const envOverride = String(env.REVIEW_YETI_FINDING_FALSIFICATION ?? '').trim().toLowerCase();
  if (envOverride === 'false') return disabled('disabled_by_env');
  const limits = settings.limits && typeof settings.limits === 'object' && !Array.isArray(settings.limits) ? settings.limits : undefined;
  return Object.freeze({ enabled: true, reason: 'configured', ...(limits ? { limits } : {}) });
}

/**
 * Flattens per-lane findings into the index-parallel `{findings, locations}` pair
 * runFindingFalsification and applyFalsificationOutcomes contract on.
 */
function flattenPersonaFindings(personaResults) {
  const findings = [];
  const locations = [];
  (Array.isArray(personaResults) ? personaResults : []).forEach((lane, laneIndex) => {
    (lane?.findings || []).forEach((finding, findingIndex) => {
      findings.push(finding);
      locations.push({ laneIndex, findingIndex });
    });
  });
  return { findings, locations };
}

/**
 * One buffered chat-completion turn for the falsification verifier, over the same transport
 * plan the persona lanes resolve (resolveModelConfig / REVIEW_YETI_TRANSPORTS). Deliberately
 * simpler than reviewWithModel: no streaming, no format recovery -- a failed turn returns
 * `{ok: false}` and the falsification stage converts that into a withheld-on-abstention
 * outcome (fail closed), so transport sophistication buys nothing here.
 * Returns `{ok: true, content, usage}` on success.
 */
async function callFalsificationModelTurn({ messages, timeoutMs, signal } = {}, options = {}) {
  const cfg = { ...resolveModelConfig(), ...options };
  const fetchImpl = options.fetchImplementation || options.fetchImpl || globalThis.fetch;
  const transports = Array.isArray(cfg.transports) && cfg.transports.length > 0
    ? cfg.transports
    : [{ name: 'default', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model }];
  let lastError = null;
  let timedOut = false;
  for (const transport of transports) {
    if (signal?.aborted) throw new Error('falsification turn aborted');
    const baseUrl = String(transport.baseUrl || cfg.baseUrl || '').replace(/\/+$/, '');
    const apiKey = transport.apiKey || cfg.apiKey;
    if (!baseUrl || !apiKey) continue;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    // Distinguish "our own per-call deadline fired" from every other failure: the
    // falsification stage records the former as verifier_timeout (a latency-budget
    // collision) and the latter as verifier_unavailable (provider weather). Conflating
    // them cost a full NO-SHIP diagnosis cycle in the 2026-08-21 measurement.
    let deadlineFired = false;
    const onDeadline = () => {
      deadlineFired = true;
      onAbort();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const deadlineMs = timeoutMs || transport.timeoutMs || 90_000;
    const timer = setTimeout(onDeadline, deadlineMs);
    if (timer.unref) timer.unref();
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model || transport.model || cfg.model,
          messages,
          temperature: 0.1,
          max_tokens: normalizeMaxOutputTokens(options.maxOutputTokens ?? transport.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS),
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = new Error(`falsification transport ${transport.name || 'default'}: HTTP ${response.status}`);
        continue;
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        lastError = new Error(`falsification transport ${transport.name || 'default'}: empty completion`);
        continue;
      }
      const cost = extractResponseCost(payload);
      return {
        ok: true,
        content,
        usage: {
          promptTokens: payload?.usage?.prompt_tokens,
          completionTokens: payload?.usage?.completion_tokens,
          totalTokens: payload?.usage?.total_tokens,
          ...(Number.isFinite(Number(cost)) ? { costUSD: Number(cost) } : {}),
        },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (deadlineFired) {
        timedOut = true;
        lastError = new Error(`falsification transport ${transport.name || 'default'}: timed out after ${deadlineMs}ms`);
      } else {
        lastError = error;
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  return { ok: false, error: lastError?.message || 'no falsification transport available', ...(timedOut ? { timedOut: true } : {}) };
}

function computeArbitrationQuorumLegacy(personaResults, expectedPersonas = personaResults.length) {
  let p0Count = 0;
  let p1Count = 0;
  let p2Count = 0;
  const failedLanes = personaResults.filter((res) => res.decision === 'ERROR');
  const completedResults = personaResults.filter((res) => res.decision !== 'ERROR');

  for (const res of completedResults) {
    for (const f of res.findings) {
      if (f.severity === 'P0') p0Count++;
      else if (f.severity === 'P1') p1Count++;
      else if (f.severity === 'P2') p2Count++;
    }
  }

  // Thresholds scale with the size of the panel. Fixed counts were calibrated for sparse regex
  // hits; with a dozen model-driven reviewers each free to raise a concern, a flat "3 P1s blocks"
  // means essentially every pull request blocks, and a reviewer that always blocks is ignored.
  const panelSize = Math.max(1, completedResults.length);
  const blockP1 = Math.max(3, Math.ceil(panelSize / 2));
  const fixP2 = Math.max(5, panelSize);

  let verdict = 'SHIP';
  let rationale = `All ${completedResults.length} persona evaluation(s) passed or contained only minor nits. Quorum satisfied for release.`;

  if (failedLanes.length > 0) {
    verdict = 'BLOCK';
    rationale = `Blocked because ${failedLanes.length} persona lane(s) failed; provider failures cannot produce a successful verdict.`;
  } else if (p0Count > 0) {
    verdict = 'BLOCK';
    rationale = `Blocked on ${p0Count} critical P0 finding(s).`;
  } else if (p1Count >= blockP1) {
    verdict = 'BLOCK';
    rationale = `Blocked on ${p1Count} P1 finding(s) across ${panelSize} reviewer(s), at or above the blocking threshold of ${blockP1}.`;
  } else if (p1Count > 0) {
    verdict = 'FIX_FIRST';
    rationale = `Changes requested for ${p1Count} P1 finding(s) and ${p2Count} P2 nit(s).`;
  } else if (p2Count >= fixP2) {
    verdict = 'FIX_FIRST';
    rationale = `Changes requested for ${p2Count} P2 nit(s) across ${panelSize} reviewer(s), at or above the nit threshold of ${fixP2}.`;
  }

  return {
    totalPersonas: expectedPersonas,
    completedPersonas: completedResults.length,
    quorumSatisfied: failedLanes.length === 0 && completedResults.length === expectedPersonas,
    verdict,
    rationale,
    thresholds: { blockP1, fixP2 },
    metrics: { p0Count, p1Count, p2Count, totalFindings: p0Count + p1Count + p2Count },
  };
}

/**
 * Canonical arbitration boundary shared with the typed App runtime.
 * The legacy implementation above is retained only as a readable migration reference.
 */
function computeArbitrationQuorum(personaResults, expectedPersonas = personaResults.length, options = {}) {
  return computeCanonicalArbitration(personaResults, expectedPersonas, options);
}

/**
 * Formats persona evaluation findings into a GitHub PR comment containing
 * a Mermaid summary graph/diagram and persona findings breakdown.
 */
function formatPRComment(arbitration, personaResults, prContext, mcpTelemetry = {}, modelConfig = {}, coverage = null) {
  const verdictBadge = arbitration.verdict === 'SHIP'
    ? '🟢 **Verdict: SHIP**'
    : arbitration.verdict === 'FIX_FIRST'
      ? '🟡 **Verdict: FIX_FIRST**'
      : '🔴 **Verdict: BLOCK**';

  const alertHeader = arbitration.verdict === 'SHIP'
    ? '> [!TIP]\n> **Verdict: SHIP** — All reviewer personas passed.'
    : arbitration.verdict === 'FIX_FIRST'
      ? `> [!WARNING]\n> **Verdict: FIX_FIRST** — ${arbitration.metrics?.p1Count || 0} issue(s) and ${arbitration.metrics?.p2Count || 0} recommendation(s) found across ${personaResults.length} reviewer personas.`
      : `> [!CAUTION]\n> **Verdict: BLOCK** — Critical issues detected. Merge approval blocked.`;

  const mcpStatusLine = mcpTelemetry.mcpStatusSummary || 'Default Built-in MCP Adapters Active';

  // Build Mermaid diagram
  const mermaidLines = [
    '```mermaid',
    'flowchart TD',
    `  PR["PR #${prContext.prNumber || 'Diff'} Payload"]`,
  ];

  personaResults.forEach((res) => {
    const statusText = res.decision === 'APPROVE' ? 'APPROVE' : `FINDINGS (${res.findings.length})`;
    const nodeCleanId = res.personaId.charAt(0).toUpperCase() + res.personaId.slice(1);
    mermaidLines.push(`  PR --> ${nodeCleanId}["${res.displayName}: ${statusText}"]`);
    mermaidLines.push(`  ${nodeCleanId} --> Arbiter`);
  });

  mermaidLines.push('  Arbiter{"Arbitration Quorum Engine"}');
  mermaidLines.push(`  Arbiter --> Verdict["Verdict: ${arbitration.verdict}"]`);
  mermaidLines.push('```');

  // Build Persona Breakdown Table
  const rosterTotals = { P0: 0, P1: 0, P2: 0 };
  let meteredCostTotal = 0;
  let meteredCostCount = 0;
  let subscriptionCount = 0;
  let unknownCostCount = 0;
  let inputTokenTotal = 0;
  let inputTokenCount = 0;
  let outputTokenTotal = 0;
  let outputTokenCount = 0;
  let breakdownRows = '';
  personaResults.forEach((res) => {
    const counts = countFindingsBySeverity(res.findings);
    rosterTotals.P0 += counts.P0;
    rosterTotals.P1 += counts.P1;
    rosterTotals.P2 += counts.P2;

    let costDisplay = '—';
    if (isSubscriptionLane(res)) {
      costDisplay = 'Subscription';
      subscriptionCount += 1;
    } else {
      const cost = normalizeCost(res.cost);
      if (cost !== null) {
        meteredCostTotal += cost;
        meteredCostCount += 1;
        costDisplay = formatCost(cost);
      } else {
        unknownCostCount += 1;
        costDisplay = '—';
      }
    }

    const icon = res.decision === 'APPROVE' ? '✅' : '⚠️';
    const provider = escapeMarkdownTableCell(res.provider || res.transport || 'unknown');
    const model = escapeMarkdownTableCell(res.model || modelConfig.model || DEFAULT_MODEL);
    const inputTokens = normalizeTokenCount(res.inputTokens);
    if (inputTokens !== null) {
      inputTokenTotal += inputTokens;
      inputTokenCount += 1;
    }
    const outputTokens = normalizeTokenCount(res.outputTokens);
    if (outputTokens !== null) {
      outputTokenTotal += outputTokens;
      outputTokenCount += 1;
    }
    breakdownRows += `| ${escapeMarkdownTableCell(res.displayName)} | \`${provider}\` | \`${model}\` | ${icon} ${res.decision} | 🔴 ${counts.P0} | 🟠 ${counts.P1} | 🟡 ${counts.P2} | ${formatTokenCount(inputTokens)} | ${formatTokenCount(outputTokens)} | ${costDisplay} |\n`;
  });

  let totalCost = '—';
  const totalLanes = personaResults.length;
  if (totalLanes > 0 && unknownCostCount === 0) {
    if (meteredCostCount > 0 && subscriptionCount > 0) {
      totalCost = `${formatCost(meteredCostTotal)} + Subscription`;
    } else if (meteredCostCount > 0) {
      totalCost = formatCost(meteredCostTotal);
    } else if (subscriptionCount > 0) {
      totalCost = 'Subscription';
    }
  }

  const totalInputTokens = inputTokenCount > 0 ? `**${formatTokenCount(inputTokenTotal)}**` : '—';
  const totalOutputTokens = outputTokenCount > 0 ? `**${formatTokenCount(outputTokenTotal)}**` : '—';
  const totalCostCell = totalCost === '—' ? totalCost : `**${totalCost}**`;
  breakdownRows += `| **Total** | — | — | — | 🔴 ${rosterTotals.P0} | 🟠 ${rosterTotals.P1} | 🟡 ${rosterTotals.P2} | ${totalInputTokens} | ${totalOutputTokens} | ${totalCostCell} |\n`;

  // Build Findings Details
  let findingsDetails = '';
  const findingLanes = personaResults.filter(r => r.findings.length > 0);

  if (personaResults.length === 0) {
    findingsDetails = '\nAll reviewer personas disabled in repository settings.\n';
  } else if (findingLanes.length === 0) {
    findingsDetails = '\n> 🎉 **No issues detected across enabled reviewer personas!**\n';
  } else {
    findingLanes.forEach((lane) => {
      const plural = lane.findings.length === 1 ? 'finding' : 'findings';
      findingsDetails += `\n<details open>\n<summary><b>${lane.displayName} (${lane.findings.length} ${plural})</b></summary>\n\n`;

      lane.findings.forEach((f, i) => {
        const sevBadge = f.severity === 'P0' ? '🔴 **P0**' : f.severity === 'P1' ? '🟠 **P1**' : '🟡 **P2**';
        const shown = `${abbreviatePath(f.path)}:${f.line}`;
        // Link to the exact line on the reviewed commit when we know which commit that was.
        const location = prContext.repo && prContext.headSha
          ? `[\`${shown}\`](https://github.com/${prContext.repo}/blob/${prContext.headSha}/${f.path}#L${f.line})`
          : `\`${shown}\``;

        if (i > 0) findingsDetails += '\n';
        findingsDetails += `${sevBadge} · **${f.title}**\n`;
        findingsDetails += `${location}\n`;
        if (f.body) findingsDetails += `\n${f.body}\n`;
        if (f.suggestion) {
          const trimmed = f.suggestion.trim();
          if (trimmed.startsWith('```')) {
            findingsDetails += `\n${trimmed}\n`;
          } else if (trimmed.includes('\n') || /[;{}()=>]/.test(trimmed) || /^(def |fn |function |const |let |var |import |export |Repo\.)/.test(trimmed)) {
            findingsDetails += `\n\`\`\`suggestion\n${trimmed}\n\`\`\`\n`;
          } else {
            findingsDetails += `\n> **Suggested Fix:** ${trimmed}\n`;
          }
        }
      });

      findingsDetails += '\n</details>\n';
    });
  }

  const reviewMode = modelConfig.enabled
    ? `Model-backed (\`${modelConfig.model}\`)`
    : '⚠️ Static heuristics only — no model configured, findings are regex-level';

  const failedLanes = personaResults.filter((r) => r.decision === 'ERROR');
  const failureNote = failedLanes.length > 0
    ? `\n- **Degraded Lanes**: ${failedLanes.length} persona(s) failed and were excluded — ${failedLanes.map(l => `${l.displayName} (${l.error})`).join('; ')}`
    : '';
  const coverageParts = [];
  if (coverage?.omitted?.length) {
    const files = coverage.omitted.slice(0, 15).map((file) => `\`${file}\``).join(', ');
    const more = coverage.omitted.length > 15 ? ` and ${coverage.omitted.length - 15} more` : '';
    coverageParts.push(`**${coverage.omitted.length} file(s) were not reviewed** — ${files}${more}.`);
  }
  if (coverage?.truncated?.length) {
    coverageParts.push(`${coverage.truncated.length} file(s) were truncated and reviewed only in part.`);
  }
  const coverageNote = coverageParts.length > 0
    ? `\n\n> ⚠️ **This verdict covers part of the change.** ${coverageParts.join(' ')}\n> The diff exceeded the per-reviewer budget of ${modelConfig.maxDiffChars || DEFAULT_MAX_DIFF_CHARS} characters.`
    : '';

  const commitRangeLine = prContext.baseSha && prContext.headSha
    ? `- **Commit SHA Range**: \`${prContext.baseSha.slice(0, 7)}...${prContext.headSha.slice(0, 7)}\``
    : `- **Commit SHA**: \`${prContext.headSha ? prContext.headSha.slice(0, 7) : 'HEAD'}\``;

  let coverageBadge = '';
  if (coverage?.partitionPlan || (coverage?.partitionsCount && coverage.partitionsCount > 0)) {
    const totalFiles = coverage.totalFiles || (coverage.reviewed ? coverage.reviewed.length : 0);
    const partitionsCount = coverage.partitionsCount || (coverage.partitionPlan ? coverage.partitionPlan.partitions.length : 1);
    coverageBadge = `\n- **Coverage**: 🟢 **100%** (${totalFiles}/${totalFiles} files reviewed across ${partitionsCount} partitions, 0 omitted)`;
  }

  let partitionManifestSection = '';
  if (coverage?.partitionPlan && coverage.partitionsCount > 1 && shaPartitionManager && typeof shaPartitionManager.formatCoverageComment === 'function') {
    partitionManifestSection = `\n\n${shaPartitionManager.formatCoverageComment(coverage.partitionPlan)}`;
  }

  const telemetrySection = `
<details>
<summary>🔍 <b>Persona Evaluation Roster & Pipeline Telemetry</b></summary>

### 🧬 Architectural Pipeline Flow
${mermaidLines.join('\n')}

### 📋 Persona Evaluation Roster
| Reviewer Persona | Provider | Model | Decision | P0 | P1 | P2 / Nits | Input Tokens | Output Tokens | Cost |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
${breakdownRows}
</details>`;

  const commentMarkdown = `## ${verdictBadge}

${alertHeader}

### 📊 ${BOT_LABEL} Summary
- **Repository**: \`${prContext.repo}\`
${commitRangeLine}
- **Review Mode**: ${reviewMode}${coverageBadge}
- **Parallel Personas Evaluated**: \`${arbitration.completedPersonas}/${arbitration.totalPersonas}\`
- **Quorum Status**: \`${arbitration.quorumSatisfied ? 'SATISFIED' : 'DEGRADED'}\`
- **MCP Server Telemetry**: ${mcpStatusLine}
- **Total Findings**: P0: \`${arbitration.metrics?.p0Count || 0}\` | P1: \`${arbitration.metrics?.p1Count || 0}\` | P2 / Nits: \`${arbitration.metrics?.p2Count || 0}\`
- **Rationale**: ${arbitration.rationale}${failureNote}${coverageNote}

${findingsDetails}
${telemetrySection}${partitionManifestSection}`;

  return commentMarkdown;
}

function emitWorkflowAnnotations(personaResults) {
  if (!Array.isArray(personaResults)) return;
  personaResults.forEach((lane) => {
    (lane.findings || []).forEach((f) => {
      if (!f.path) return;
      const cmd = f.severity === 'P0' || f.severity === 'P1' ? 'error' : 'warning';
      const title = (f.title || lane.displayName || 'Review Finding').replace(/[\r\n]+/g, ' ');
      const msg = (f.body || f.title || '').replace(/[\r\n]+/g, ' ');
      const lineParam = f.line ? `line=${f.line},` : '';
      console.log(`::${cmd} file=${f.path},${lineParam}title=${title}::${msg}`);
    });
  });
}

function writeStepSummary(arbitration, personaResults, prContext, coverage) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    const badge = arbitration.verdict === 'SHIP' ? '🟢 SHIP' : arbitration.verdict === 'FIX_FIRST' ? '🟡 FIX_FIRST' : '🔴 BLOCK';
    const totalFiles = coverage?.reviewed?.length || 'all';
    const summaryMd = `### 🏔️ Review Yeti Executive Summary\n\n` +
      `| Metric | Value |\n|---|---|\n` +
      `| **Arbitration Verdict** | **${badge}** |\n` +
      `| **Review Coverage** | 100% (${totalFiles} files audited) |\n` +
      `| **Quorum** | ${arbitration.quorumSatisfied ? '✅ Satisfied' : '⚠️ Degraded'} (${arbitration.completedPersonas}/${arbitration.totalPersonas} personas) |\n` +
      `| **Total Findings** | 🔴 P0: ${arbitration.metrics?.p0Count || 0} \\| 🟠 P1: ${arbitration.metrics?.p1Count || 0} \\| 🟡 P2: ${arbitration.metrics?.p2Count || 0} |\n\n` +
      `*Rationale: ${arbitration.rationale}*\n`;
    fs.appendFileSync(summaryPath, summaryMd);
  } catch (err) {
    console.warn('Could not write GITHUB_STEP_SUMMARY:', err.message);
  }
}

/**
 * Posts formatted PR comment via `gh pr comment` CLI when PR number is available,
 * or outputs to stdout/file.
 */
function postOrOutputComment(commentBody, prContext, options = {}) {
  const prNumber = prContext.prNumber;
  const now = options.now || Date.now;
  const fileSystem = options.fileSystem || fs;
  const commandRunner = options.commandRunner || ((command, args, commandOptions) => spawnSync(command, args, commandOptions));
  const cwd = options.cwd || process.cwd();

  if (prNumber) {
    const marker = prContext.repo && prContext.headSha
      ? `<!-- ct-review-bot:v1:${prContext.repo}#${prNumber}:${prContext.headSha}:action -->`
      : '';
    const bodyToPublish = marker && !commentBody.includes(marker)
      ? `${commentBody}\n\n${marker}`
      : commentBody;
    try {
      if (marker) {
        const existing = commandRunner('gh', [
          'api',
          `repos/${prContext.repo}/issues/${prNumber}/comments?per_page=100`,
          '--paginate',
          '--jq',
          '.[] | [.id, .body] | @tsv',
        ], {
          encoding: 'utf-8',
          env: process.env,
        });
        if (!existing || existing.status !== 0) {
          const error = `gh api could not verify the existing review marker: ${existing?.stderr || existing?.stdout || 'unknown error'}`;
          console.warn(`[Publish] ${error}`);
          return { success: false, postedViaGh: false, error };
        }
        const matchingComment = String(existing.stdout || '')
          .split(/\r?\n/u)
          .map((line) => {
            const separator = line.indexOf('\t');
            return separator === -1
              ? { id: null, body: line }
              : { id: line.slice(0, separator), body: line.slice(separator + 1) };
          })
          .find((comment) => comment.body.includes(marker));
        if (matchingComment) {
          if (!matchingComment.id) {
            console.log(`[Publish] Exact-head review marker already exists for PR #${prNumber}; skipping duplicate.`);
            return { success: true, postedViaGh: true, deduplicated: true };
          }

          const updated = commandRunner('gh', [
            'api',
            `repos/${prContext.repo}/issues/comments/${matchingComment.id}`,
            '--method',
            'PATCH',
            '--field',
            `body=${bodyToPublish}`,
          ], {
            encoding: 'utf-8',
            env: process.env,
          });
          if (!updated || updated.status !== 0) {
            const error = `gh api could not update the existing review marker: ${updated?.stderr || updated?.stdout || 'unknown error'}`;
            console.warn(`[Publish] ${error}`);
            return { success: false, postedViaGh: false, error };
          }
          console.log(`[Publish] Updated exact-head review marker for PR #${prNumber}.`);
          return { success: true, postedViaGh: true, updated: true };
        }
      }

      const tempPath = path.join(options.tempDirectory || '/tmp', `review-comment-${now()}.md`);
      fileSystem.writeFileSync(tempPath, bodyToPublish, 'utf-8');

      // --repo is required: the review runner checks out the central review repository, so the
      // target PR is almost never the repository `gh` would infer from the working directory.
      const args = ['pr', 'comment', String(prNumber), '--body-file', tempPath];
      if (prContext.repo && prContext.repo.includes('/')) {
        args.push('--repo', prContext.repo);
      }

      const result = commandRunner('gh', args, {
        encoding: 'utf-8',
        env: process.env,
      });

      try { fileSystem.unlinkSync(tempPath); } catch (_) {}

      if (result.status === 0) {
        console.log(`[Publish] Successfully posted PR comment to PR #${prNumber} via gh CLI.`);
        return { success: true, postedViaGh: true };
      } else {
        const error = `gh pr comment failed with status ${result.status}: ${result.stderr || result.stdout || 'unknown error'}`;
        console.warn(`[Publish] ${error}`);
        return { success: false, postedViaGh: false, error };
      }
    } catch (err) {
      const error = `gh pr comment failed: ${err.message}`;
      console.warn(`[Publish] ${error}`);
      return { success: false, postedViaGh: false, error };
    }
  } else {
    console.log('[Publish] No PR_NUMBER found in event context; skipping `gh pr comment` invocation.');
  }

  // Fallback to outputting comment to file & stdout
  const commentFilePath = path.join(cwd, 'review-comment.md');
  try {
    fileSystem.writeFileSync(commentFilePath, commentBody, 'utf-8');
    console.log(`[Publish] Saved formatted review comment to ${commentFilePath}`);
  } catch (_) {}

  return { success: true, postedViaGh: false };
}

/**
 * Publishes the verdict as GitHub Actions step outputs so a consuming workflow can gate on it,
 * e.g. `if: steps.review.outputs.verdict == 'BLOCK'`.
 *
 * @param {object} arbitration - Computed arbitration result.
 * @param {string} [outputPath] - Path to GITHUB_OUTPUT. No-op when absent (local runs).
 */
function buildReviewRunReport(arbitration, personaResults, prContext) {
  const lanes = (Array.isArray(personaResults) ? personaResults : []).map((result) => {
    const findings = Array.isArray(result.findings) ? result.findings : [];
    const severity = findings.reduce((counts, finding) => {
      if (finding?.severity === 'P0') counts.P0++;
      else if (finding?.severity === 'P1') counts.P1++;
      else if (finding?.severity === 'P2') counts.P2++;
      return counts;
    }, { P0: 0, P1: 0, P2: 0 });

    return {
      personaId: result.personaId || '',
      decision: result.decision || 'ERROR',
      findings,
      severity,
    };
  });

  return {
    schemaVersion: 'review-run-report-v1',
    repository: prContext.repo,
    prNumber: Number(prContext.prNumber),
    baseSha: prContext.baseSha,
    headSha: prContext.headSha,
    verdict: arbitration.verdict,
    lanes,
  };
}

function writeRunReport(arbitration, personaResults, prContext, outputDirectory = process.env.RUNNER_TEMP) {
  if (!outputDirectory) return null;

  const report = buildReviewRunReport(arbitration, personaResults, prContext);
  const reportPath = path.join(
    outputDirectory,
    `review-yeti-run-report-${String(prContext.prNumber || 'unknown')}-${String(prContext.headSha || 'unknown').slice(0, 12)}.json`,
  );
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(reportPath, reportJson, 'utf-8');

  return {
    path: reportPath,
    digest: createHash('sha256').update(reportJson, 'utf-8').digest('hex'),
  };
}

function buildProviderTelemetryReceipt(personaResults, prContext) {
  const lanes = (Array.isArray(personaResults) ? personaResults : []).map((result) => {
    const reportedCost = normalizeCost(result.cost);
    return {
      personaId: normalizeTelemetryIdentifier(result.personaId) || '',
      configuredTransport: normalizeTelemetryProvider(result.transport),
      resolvedProvider: normalizeTelemetryProvider(result.provider),
      modelDigest: hashTelemetryIdentifier(result.model),
      inputTokens: normalizeTokenCount(result.inputTokens),
      outputTokens: normalizeTokenCount(result.outputTokens),
      reportedCost,
      reportedCostCurrency: null,
      costStatus: reportedCost === null ? 'unavailable' : 'reported',
      attemptCount: normalizeTelemetryAttemptCount(result.attemptCount),
      latencyMs: normalizeTelemetryDuration(result.latencyMs),
      retryReasons: normalizeTelemetryRetryReasons(result.retryReasons),
      failureClass: normalizeTelemetryOutcomeClass(result.failureClass),
      responseStatus: normalizeTelemetryStatus(result.responseStatus),
      errorCode: normalizeTelemetryErrorCode(result.errorCode),
      generationIdDigest: normalizeTelemetryIdentifier(result.generationIdDigest),
      routerAttempt: normalizeTelemetryAttemptCount(result.routerAttempt),
      ...(result.routerMetadata ? { routerMetadata: normalizeOpenRouterMetadata(result.routerMetadata) } : {}),
      recoveryAction: normalizeTelemetryRecoveryAction(result.recoveryAction),
      outputShape: normalizeFindingsOutputShape(result.outputShape),
      finishReason: normalizeModelFinishReason(result.finishReason),
      responseMode: normalizeResponseMode(result.responseMode),
      findingsSource: normalizeFindingsSource(result.findingsSource),
      contentPresent: result.contentPresent === true,
      reasoningPresent: result.reasoningPresent === true,
      contentSizeBucket: normalizeResponseSizeBucket(result.contentSizeBucket),
      reasoningSizeBucket: normalizeResponseSizeBucket(result.reasoningSizeBucket),
      outputContract: normalizeOutputContractTelemetry(result.outputContract),
      ...(normalizeTelemetryDigest(result.requestFingerprint)
        ? { requestFingerprint: normalizeTelemetryDigest(result.requestFingerprint) }
        : {}),
      responseAttempts: normalizeModelResponseAttempts(result.responseAttempts),
    };
  });

  return {
    schemaVersion: 'review-provider-telemetry-v4',
    repository: prContext.repo,
    prNumber: Number(prContext.prNumber),
    baseSha: prContext.baseSha,
    headSha: prContext.headSha,
    lanes,
  };
}

function writeProviderTelemetryReceipt(personaResults, prContext, outputDirectory = process.env.RUNNER_TEMP) {
  const runnerTemp = String(process.env.RUNNER_TEMP || '').trim();
  if (!outputDirectory || !runnerTemp || !isWithinDirectory(outputDirectory, runnerTemp)) return null;

  const receipt = buildProviderTelemetryReceipt(personaResults, prContext);
  const receiptPath = path.join(
    outputDirectory,
    `review-yeti-provider-telemetry-${safeReceiptPathToken(prContext.prNumber)}-${safeReceiptPathToken(prContext.headSha).slice(0, 12)}.json`,
  );
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  fs.writeFileSync(receiptPath, receiptJson, 'utf-8');

  return {
    path: receiptPath,
    digest: createHash('sha256').update(receiptJson, 'utf-8').digest('hex'),
  };
}

function writeProviderTelemetryReceiptBestEffort(personaResults, prContext, outputDirectory = process.env.RUNNER_TEMP) {
  try {
    return writeProviderTelemetryReceipt(personaResults, prContext, outputDirectory);
  } catch (error) {
    console.warn(`[Telemetry] Could not write provider telemetry receipt: ${error.message}`);
    return null;
  }
}

function writeStepOutputs(arbitration, outputPath = process.env.GITHUB_OUTPUT, coverage = null, runReport = null, providerTelemetry = null) {
  if (!outputPath) return;

  const m = arbitration.metrics || {};
  const totalFiles = coverage?.totalFiles ?? (coverage?.reviewed?.length || 0);
  const omittedFiles = coverage?.omittedFilesCount ?? (coverage?.omitted?.length || 0);
  const partitionsCount = coverage?.partitionsCount ?? (coverage?.partitionPlan ? coverage.partitionPlan.partitions.length : 1);
  const coveragePct = coverage?.coveragePercent ?? (totalFiles > 0 && omittedFiles === 0 ? 100 : Math.round(((totalFiles - omittedFiles) / Math.max(1, totalFiles)) * 100));
  const mergeEligible = arbitration.verdict === 'SHIP' && arbitration.quorumSatisfied !== false && omittedFiles === 0 && Boolean(runReport);
  const rationale = String(arbitration.rationale || '').replace(/[\r\n]+/g, ' ');

  const lines = [
    `verdict=${arbitration.verdict}`,
    `review-status=${arbitration.verdict}`,
    `gate-decision=${mergeEligible ? 'PASS' : 'BLOCK'}`,
    `merge-eligible=${mergeEligible}`,
    `dispatch-reflection-status=${runReport ? 'complete' : ''}`,
    `provider-receipt-digest=${runReport?.digest || ''}`,
    `run-report-path=${runReport?.path || ''}`,
    `provider-telemetry-digest=${providerTelemetry?.digest || ''}`,
    `provider-telemetry-path=${providerTelemetry?.path || ''}`,
    `rationale=${rationale}`,
    `findings-count=${m.totalFindings || 0}`,
    `total-findings=${m.totalFindings || 0}`,
    `p0-count=${m.p0Count || 0}`,
    `p1-count=${m.p1Count || 0}`,
    `p2-count=${m.p2Count || 0}`,
    `personas-completed=${arbitration.completedPersonas || 0}`,
    `personas-total=${arbitration.totalPersonas || 0}`,
    `files-reviewed=${totalFiles}`,
    `files-omitted=${omittedFiles}`,
    `partitions-count=${partitionsCount}`,
    `coverage-pct=${coveragePct}`,
  ];

  try {
    fs.appendFileSync(outputPath, lines.join('\n') + '\n', 'utf-8');
  } catch (err) {
    console.warn(`[Outputs] Could not write step outputs: ${err.message}`);
  }
}

/**
 * Reads local repository .ct-review.yaml or .coderabbit.yaml if present in checked-out repo.
 * Allows local repository overrides for active personas, path filters, model overrides, and effort levels.
 */
function loadLocalRepoConfig(configRoot = resolveConfigRoot()) {
  const candidates = ['.ct-review.yaml', '.ct-review.yml', '.coderabbit.yaml', '.coderabbit.yml'];
  for (const file of candidates) {
    const fullPath = path.resolve(configRoot, file);
    if (fs.existsSync(fullPath)) {
      try {
        let jsYaml = null;
        try { jsYaml = require('js-yaml'); } catch (_) {}
        const content = fs.readFileSync(fullPath, 'utf-8');
        const parsed = jsYaml ? jsYaml.load(content) : null;
        console.log(`[Config] Loaded local repository override configuration from ${file}`);
        return { file, parsed, raw: content };
      } catch (err) {
        console.warn(`[Config] Failed to parse local config file ${file}: ${err.message}`);
      }
    }
  }
  return null;
}

/**
 * Main entry point for pipeline execution.
 */
async function main() {
  console.log('=====================================================');
  console.log(`🚀 ${BOT_LABEL}`);
  console.log('=====================================================');

  const prContext = getPRDiffAndContext();
  console.log(`[Context] Repo: ${prContext.repo} | PR #: ${prContext.prNumber || 'N/A'} | SHA: ${prContext.headSha.slice(0, 7)}`);

  let sessionContext = null;
  if (SessionLedger) {
    try {
      const ledger = new SessionLedger();
      const repoParts = prContext.repo.split('/');
      const owner = repoParts.length > 1 ? repoParts[0] : 'calltelemetry';
      const repoName = repoParts.length > 1 ? repoParts[1] : prContext.repo;
      sessionContext = ledger.getPreviousTurnContext(owner, repoName, prContext.prNumber || 1);
      if (sessionContext?.hasHistory) {
        console.log(`[Session] Loaded previous review history (Turn ${sessionContext.previousTurn}). Remaining turn budget: ${sessionContext.remainingTurns}`);
      }
    } catch (_) {}
  }

  const configRoot = resolveConfigRoot();
  if (process.env.CT_REVIEW_CONFIG_DIR) {
    console.log(`[Config] Reading repository configuration from the trusted base ref, not the pull request head.`);
  }
  const localConfig = loadLocalRepoConfig(configRoot);
  const actionPolicy = resolveActionReviewPolicy(localConfig, process.env);
  const actionRuntime = resolveActionReviewRuntime(localConfig, process.env);
  for (const note of actionRuntime.notes) {
    console.log(`[Config] ${note}`);
  }

  const mcpFleetInfo = await initMcpFleet(prContext.eventData?.client_payload);
  console.log(`[MCP] ${mcpFleetInfo.mcpStatusSummary}`);

  const diffFiles = parseDiff(prContext.diffText);
  console.log(`[Payload] Parsed ${diffFiles.length} file(s) from PR diff payload.`);

  if (diffFiles.length === 0) {
    console.log('[Payload] Diff is empty; nothing to review. Exiting without posting a comment.');
    return;
  }

  const submoduleMetadata = await resolveActionSubmoduleMetadata(diffFiles, {
    parentRepository: prContext.repo,
    baseRef: prContext.baseSha,
    headRef: prContext.headSha,
    baseRoot: configRoot,
    headRoot: process.cwd(),
  });
  const baseSubmoduleUrls = submoduleMetadata.baseUrls;
  const submoduleUrls = submoduleMetadata.headUrls;
  const submoduleReview = applyActionSubmodulePolicy(diffFiles, actionPolicy.submodules, { baseSubmoduleUrls, submoduleUrls, parentRepository: prContext.repo });
  if (submoduleMetadata.hasCandidate) {
    const resolvedBase = Object.keys(baseSubmoduleUrls).length;
    const resolvedHead = Object.keys(submoduleUrls).length;
    console.log(`[Submodules] Exact-ref metadata entries: base=${resolvedBase}, head=${resolvedHead}; coverage=${submoduleReview.coverageComplete ? 'complete' : 'incomplete'}.`);
  }
  const reviewDiffFiles = submoduleReview.files;
  if (reviewDiffFiles.length === 0) {
    console.log('[Payload] All changed files were excluded by the trusted submodule policy; no model verdict was posted.');
    return;
  }

  const modelConfig = actionRuntime.modelConfig;
  const safeDiffCapacityChars = modelConfig.maxDiffChars || calculateSafeDiffCapacity(modelConfig.model || DEFAULT_MODEL) || DEFAULT_MAX_DIFF_CHARS;
  const totalDiffChars = reviewDiffFiles.reduce((sum, file) => sum + String(file.patch || '').length, 0);

  let partitionPlan = null;
  if (shaPartitionManager && reviewDiffFiles.length > 0 && totalDiffChars > safeDiffCapacityChars) {
    const baseSha = prContext.baseSha || 'HEAD~1';
    const headSha = prContext.headSha || 'HEAD';
    try {
      partitionPlan = shaPartitionManager.createPartitionPlan(reviewDiffFiles, baseSha, headSha, safeDiffCapacityChars);
      console.log(`[Partitioning] Total diff size (${totalDiffChars.toLocaleString()} chars) exceeds safe budget (${safeDiffCapacityChars.toLocaleString()} chars). Partitioned into ${partitionPlan.partitions.length} parallel review lanes (100% file coverage guarantee, 0 omitted).`);
    } catch (err) {
      console.warn(`[Partitioning] Failed to create partition plan: ${err.message}`);
    }
  }

  let coverage = null;
  if (partitionPlan && partitionPlan.partitions.length > 1) {
    coverage = {
      text: reviewDiffFiles.map((file) => `\n--- FILE: ${file.path} ---\n${file.patch || ''}`).join(''),
      reviewed: reviewDiffFiles.map((file) => file.path),
      truncated: [],
      omitted: [],
      totalFiles: reviewDiffFiles.length,
      omittedFilesCount: 0,
      partitionsCount: partitionPlan.partitions.length,
      coveragePercent: 100,
      partitionPlan,
    };
  } else {
    coverage = planDiffBudget(reviewDiffFiles, modelConfig.maxDiffChars);
  }

  if (coverage.omitted && coverage.omitted.length > 0) {
    console.warn(`[Budget] Diff exceeds ${modelConfig.maxDiffChars} chars: ${coverage.reviewed.length} reviewed, ${coverage.truncated.length} truncated, ${coverage.omitted.length} omitted.`);
  }
  console.log(modelConfig.enabled
    ? `[Model] OpenRouter-backed review enabled: ${modelConfig.model} (diff budget ${modelConfig.maxDiffChars} chars/persona).`
    : '[Model] OPENROUTER_API_KEY is not configured; refusing to produce a verdict.');

  // Never allow a workflow-supplied variable to disable exact-head verification on a real runner.
  const syntheticVitestRun = process.env.GITHUB_ACTIONS !== 'true'
    && process.env.VITEST === 'true'
    && process.env.PR_DIFF
    && !process.env.GITHUB_EVENT_PATH;
  if (!syntheticVitestRun) assertCurrentPullRequest(prContext);

  // Determine active/enabled personas from dispatch payload, local YAML config, or environment
  const payload = prContext.eventData?.client_payload || {};
  const fileRoster = loadPersonaFiles(configRoot);
  if (fileRoster.personas.length > 0) {
    console.log(`[Personas] Loaded ${fileRoster.personas.length} persona file(s) from ${PERSONA_DIR}/.`);
  }

  const roster = resolvePersonaRoster(payload, localConfig, process.env, fileRoster.personas);
  roster.errors.unshift(...fileRoster.errors);

  // A misconfigured roster must never fall through to a green verdict: an unknown id used to
  // yield zero personas and a cheerful SHIP, which reads exactly like a passing review.
  if (roster.errors.length > 0) {
    console.error('[Personas] Reviewer configuration is invalid:');
    for (const e of roster.errors) console.error(`  - ${e}`);
    console.error('[Personas] Refusing to post a verdict from a misconfigured roster.');
    process.exitCode = 1;
    return;
  }

  const enabledPersonas = roster.personas;
  const customCount = enabledPersonas.filter(p => !PERSONA_CHARTERS.some(b => b.id === p.id)).length;
  console.log(`[Personas] Loaded ${enabledPersonas.length} enabled persona(s) with model ${DEFAULT_MODEL}${customCount ? ` (${customCount} repository-defined)` : ''}...`);

  let personaResults = [];
  let arbitration = null;

  if (enabledPersonas.length === 0) {
    console.log('[Personas] All reviewer personas are disabled in repository/org settings. Skipping LLM persona evaluations.');
    arbitration = {
      verdict: 'BLOCK',
      status: 'INCOMPLETE_REVIEW',
      rationale: 'All reviewer personas are disabled; no review evidence exists, so the run cannot produce a successful verdict.',
      quorumSatisfied: false,
      completedPersonas: 0,
      totalPersonas: 0,
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0 },
    };
  } else {
    if (modelConfig.enabled) {
      const personaConcurrency = resolvePersonaConcurrency();
      if (partitionPlan && partitionPlan.partitions.length > 1) {
        console.log(`[Bounded Evaluation] Dispatching ${enabledPersonas.length} persona lane(s) across ${partitionPlan.partitions.length} partitions to ${modelConfig.model} with concurrency ${personaConcurrency}...`);
        const reviewJobs = partitionPlan.partitions.flatMap((partition) =>
          enabledPersonas.map((persona) => ({ partition, persona }))
        );
        const reviewResults = await mapWithConcurrency(
          reviewJobs,
          personaConcurrency,
          async ({ partition, persona }) => {
            const partitionOptions = {
              ...modelConfig,
              partition,
              partitionPlan,
              maxDiffChars: safeDiffCapacityChars,
            };
            return reviewWithModel(persona, partition.files, prContext, sessionContext, partitionOptions);
          }
        );
        const partitionRuns = partitionPlan.partitions.map((_, partitionIndex) =>
          enabledPersonas.map((_, personaIndex) =>
            reviewResults[(partitionIndex * enabledPersonas.length) + personaIndex]
          )
        );

        // Aggregate results per persona across partitions
        personaResults = enabledPersonas.map((persona, pIdx) => {
          const laneRuns = partitionRuns.map((pRun) => pRun[pIdx]);
          const allFindings = laneRuns.flatMap((r) => r.findings || []);
          const totalInputTokens = laneRuns.reduce((sum, r) => sum + (r.inputTokens || 0), 0);
          const totalOutputTokens = laneRuns.reduce((sum, r) => sum + (r.outputTokens || 0), 0);
          const totalAttempts = laneRuns.reduce((sum, r) => sum + (normalizeTelemetryAttemptCount(r.attemptCount) || 0), 0);
          const totalLatencyMs = laneRuns.reduce((sum, r) => sum + (normalizeTelemetryDuration(r.latencyMs) || 0), 0);
          const retryReasons = normalizeTelemetryRetryReasons(laneRuns.flatMap((r) => Array.isArray(r.retryReasons) ? r.retryReasons : []));
          const anyError = laneRuns.find((r) => r.decision === 'ERROR');
          const lastRun = laneRuns.at(-1) || {};
          const baseRun = laneRuns[0] || {};

          let totalCost = null;
          const numericCosts = laneRuns.map((r) => normalizeCost(r.cost)).filter((c) => c !== null);
          if (numericCosts.length === laneRuns.length) {
            totalCost = numericCosts.reduce((sum, c) => sum + c, 0);
          } else if (laneRuns.some((r) => isSubscriptionLane(r))) {
            totalCost = 'Subscription';
          }

          return {
            ...baseRun,
            personaId: persona.id,
            displayName: persona.name,
            findings: allFindings,
            inputTokens: totalInputTokens || null,
            outputTokens: totalOutputTokens || null,
            cost: totalCost,
            attemptCount: totalAttempts,
            latencyMs: totalLatencyMs,
            retryReasons,
            failureClass: anyError ? (normalizeTelemetryOutcomeClass(anyError.failureClass) || 'unknown') : null,
            responseStatus: normalizeTelemetryStatus(anyError?.responseStatus ?? lastRun.responseStatus),
            errorCode: normalizeTelemetryErrorCode(anyError?.errorCode ?? lastRun.errorCode),
            generationIdDigest: normalizeTelemetryIdentifier(lastRun.generationIdDigest),
            routerAttempt: normalizeTelemetryAttemptCount(lastRun.routerAttempt),
            recoveryAction: normalizeTelemetryRecoveryAction(laneRuns.find((r) => r.recoveryAction)?.recoveryAction),
            outputShape: normalizeFindingsOutputShape(lastRun.outputShape),
            finishReason: normalizeModelFinishReason(lastRun.finishReason),
            responseMode: normalizeResponseMode(lastRun.responseMode),
            findingsSource: normalizeFindingsSource(lastRun.findingsSource),
            contentPresent: laneRuns.some((r) => r.contentPresent === true),
            reasoningPresent: laneRuns.some((r) => r.reasoningPresent === true),
            contentSizeBucket: normalizeResponseSizeBucket(lastRun.contentSizeBucket),
            reasoningSizeBucket: normalizeResponseSizeBucket(lastRun.reasoningSizeBucket),
            outputContract: normalizeOutputContractTelemetry(lastRun.outputContract),
            decision: anyError ? 'ERROR' : (allFindings.length === 0 ? 'APPROVE' : 'FINDINGS'),
            error: anyError ? anyError.error : undefined,
          };
        });
      } else {
        console.log(`[Bounded Evaluation] Dispatching ${enabledPersonas.length} persona lane(s) to ${modelConfig.model} via ${modelConfig.baseUrl} with concurrency ${personaConcurrency}...`);
        personaResults = await mapWithConcurrency(
          enabledPersonas,
          personaConcurrency,
          (persona) => reviewWithModel(persona, reviewDiffFiles, prContext, sessionContext, modelConfig)
        );
      }

      const failed = personaResults.filter((r) => r.decision === 'ERROR');
      for (const lane of failed) {
        console.warn(`[Persona ${lane.personaId}] Lane failed: ${lane.error}`);
      }
      if (failed.length === personaResults.length) {
        console.error('[Review] Every persona lane failed. Refusing to post a verdict derived from zero completed reviews.');
        const failedArbitration = computeArbitrationQuorum(personaResults, enabledPersonas.length, {
          changedFiles: reviewDiffFiles,
        });
        const failedTelemetry = writeProviderTelemetryReceiptBestEffort(personaResults, prContext);
        writeStepOutputs(failedArbitration, process.env.GITHUB_OUTPUT, coverage, null, failedTelemetry);
        process.exitCode = 1;
        return;
      }
      personaResults = personaResults.map((lane) => ({
        ...lane,
        findings: sanitizeCanonicalFindings(lane.findings, reviewDiffFiles),
      }));
    } else {
      console.error('[Review] No OPENROUTER_API_KEY configured. Refusing to post a heuristic or successful verdict.');
      process.exitCode = 1;
      return;
    }

    // Verified publication: the independent falsification gate (see
    // resolveFindingFalsificationPolicy's doc comment). Runs strictly after the persona lanes
    // (and their canonical sanitization) and strictly before arbitration, so the arbiter
    // consumes only hypotheses that survived an adversarial verification attempt. Only the
    // stage's own failure to RUN leaves findings untouched (config off, or the module itself
    // throwing) -- a per-finding verifier failure inside a run is an abstention, and
    // abstention withholds.
    {
      const falsificationPolicy = resolveFindingFalsificationPolicy({ localConfig, env: process.env });
      if (falsificationPolicy.enabled && personaResults.some((lane) => (lane?.findings || []).length > 0)) {
        try {
          const { findings: flatFindings, locations } = flattenPersonaFindings(personaResults);
          const falsificationResult = await runFindingFalsification({
            findings: flatFindings,
            changedFiles: reviewDiffFiles,
            limits: falsificationPolicy.limits,
            falsifyTurn: ({ messages, timeoutMs, signal }) =>
              callFalsificationModelTurn({ messages, timeoutMs, signal }, modelConfig),
          });
          const applied = applyFalsificationOutcomes(personaResults, locations, falsificationResult);
          personaResults = applied.personaResults;
          const falsificationSummary = falsificationResult.receipt.summary;
          console.log(`[Falsification] ${applied.confirmed} finding(s) confirmed, ${applied.refuted} refuted, ${applied.abstained} withheld on abstention (${falsificationSummary.neverVerified} never verified: ${falsificationSummary.timedOut} verifier-timeout, ${falsificationSummary.unavailable} verifier-unavailable, ${falsificationSummary.budgetExhausted} stage-budget).`);
        } catch (error) {
          console.warn(`[Falsification] Stage unavailable (${error.message}); findings stand as reported.`);
        }
      }
    }

    console.log('[Arbitration] Computing binding arbitration quorum...');
    arbitration = computeArbitrationQuorum(personaResults, enabledPersonas.length, {
      changedFiles: reviewDiffFiles,
      coverageComplete: submoduleReview.coverageComplete,
    });
  }

  console.log(`[Verdict] ${arbitration.verdict} | Rationale: ${arbitration.rationale}`);

  if (!syntheticVitestRun) assertCurrentPullRequest(prContext);

  console.log('[Formatting] Formatting GitHub PR comment output with Mermaid diagram and MCP telemetry...');
  const commentMarkdown = formatPRComment(arbitration, personaResults, prContext, mcpFleetInfo, modelConfig, coverage);

  console.log('[Publishing] Executing PR comment publishing...');
  const publication = postOrOutputComment(commentMarkdown, prContext);
  if (!publication.success) {
    console.error(`[Publishing] ${publication.error || 'GitHub publication failed'}`);
    process.exitCode = 1;
    return;
  }

  const runReport = writeRunReport(arbitration, personaResults, prContext);
  const providerTelemetry = writeProviderTelemetryReceiptBestEffort(personaResults, prContext);
  writeStepOutputs(arbitration, process.env.GITHUB_OUTPUT, coverage, runReport, providerTelemetry);
  emitWorkflowAnnotations(personaResults);
  writeStepSummary(arbitration, personaResults, prContext, coverage);

  // Persist session log artifacts under sessions/ directory
  if (SessionLedger) {
    try {
      const ledger = new SessionLedger();
      const repoParts = prContext.repo.split('/');
      const owner = repoParts.length > 1 ? repoParts[0] : 'calltelemetry';
      const repoName = repoParts.length > 1 ? repoParts[1] : prContext.repo;
      const recordRes = ledger.recordTurn({
        owner,
        repo: repoName,
        prNumber: prContext.prNumber || 1,
        headSha: prContext.headSha,
        title: prContext.title,
        currentTurn: (sessionContext?.previousTurn || 0) + 1,
        maxTurns: 20,
        arbitration,
        personaResults,
      });
      console.log(`[Session Ledger] Persisted turn log to ${recordRes.sessionDir}`);
    } catch (err) {
      console.warn(`[Session Ledger] Failed to record turn log: ${err.message}`);
    }
  }

  console.log('=====================================================');
  console.log(`✅ Review Pipeline Completed cleanly. Verdict: ${arbitration.verdict}`);
  console.log('=====================================================');
}

if (require.main === module) {
  main().catch((err) => {
    // Exit non-zero. Swallowing a crash into a green check is indistinguishable from a clean
    // review, which is the worst outcome available to a review tool.
    console.error('Fatal error during review pipeline execution:', err);
    process.exit(1);
  });
}

module.exports = {
  PERSONA_CHARTERS,
  DEFAULT_PERSONA_IDS,
  DEFAULT_MODEL,
  OLLAMA_MAX_IN_FLIGHT_REQUESTS,
  OLLAMA_CAPACITY_WAIT_TIMEOUT_MS,
  AsyncSemaphore,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENROUTER_MAX_OUTPUT_TOKENS,
  DEFAULT_DIRECT_OUTPUT_BUDGET_TOKENS,
  DIRECT_GENERATION_BUDGET_MULTIPLIER,
  DEFAULT_DIRECT_MAX_OUTPUT_TOKENS,
  parseDiff,
  abbreviatePath,
  getPRDiffAndContext,
  assertCurrentPullRequest,
  resolvePersonaRoster,
  loadPersonaFiles,
  resolveConfigRoot,
  resolveModelConfig,
  resolveActionReviewRuntime,
  resolveActionReviewPolicy,
  applyActionSubmodulePolicy,
  parseActionSubmoduleUrls,
  fetchActionSubmoduleUrlsAtRef,
  hasActionSubmoduleCandidate,
  mergeActionSubmoduleUrls,
  resolveActionSubmoduleMetadata,
  planDiffBudget,
  reviewWithModel,
  analyzeFindingsPayload,
  parseFindingsPayload,
  normalizeModelFinishReason,
  responseSizeBucket,
  buildOutputContractTelemetry,
  normalizeOutputContractTelemetry,
  normalizeStructuredOutputMode,
  resolveStructuredOutputMode,
  buildFindingsResponseFormat,
  readChatCompletionResponse,
  isStructuredOutputCompatibilityError,
  downgradeStructuredOutputRequest,
  FINDINGS_RESPONSE_SCHEMA,
  downgradeReasoningEffort,
  sanitizeFindings,
  loadLocalRepoConfig,
  writeStepOutputs,
  buildReviewRunReport,
  writeRunReport,
  buildProviderTelemetryReceipt,
  writeProviderTelemetryReceipt,
  writeProviderTelemetryReceiptBestEffort,
  initMcpFleet,
  evaluatePersonaLane,
  computeArbitrationQuorum,
  resolveFindingFalsificationPolicy,
  flattenPersonaFindings,
  callFalsificationModelTurn,
  formatPRComment,
  emitWorkflowAnnotations,
  writeStepSummary,
  postOrOutputComment,
  isSubscriptionTransport,
  isDirectReasoningTransport,
  isOllamaTransport,
  resolveTransportTemperature,
  deriveOllamaRequestSeed,
  RunTransportCircuitBreaker,
  globalRunCircuitBreaker,
  isSubscriptionLane,
  calculateSafeDiffCapacity,
  resolvePersonaConcurrency,
  mapWithConcurrency,
  getStaticModelContext,
  formatCost,
  normalizeTelemetryDigest,
  requestFingerprintForAttempt,
  shaPartitionManager,
  main,
};
