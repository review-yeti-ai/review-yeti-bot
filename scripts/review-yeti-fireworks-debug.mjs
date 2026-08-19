#!/usr/bin/env node
/**
 * Operator debug: time Fireworks the way Review Yeti actually calls it.
 *
 *   doppler run --project example-workspace --config prd -- node scripts/review-yeti-fireworks-debug.mjs
 *
 * Never prints the API key. Reports HTTP status, TTFB, total ms, and 429s.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const BASE = 'https://api.fireworks.ai/inference/v1';
const MODEL = 'accounts/fireworks/models/deepseek-v4-flash-0731';

function filler(tokenTarget) {
  const unit = 'Review this PR hunk: plugins/ct-workflow/scripts/launch-dashboard-mcp.sh uses npx @latest. ';
  return unit.repeat(Math.max(1, Math.floor((tokenTarget * 4) / unit.length)));
}

async function timedFetch(label, { tokens, stream, maxTokens, timeoutMs }) {
  const key = process.env.FIREWORKS_PR_REVIEW_API_KEY || '';
  const started = Date.now();
  const out = { label, stream: !!stream, promptTokensApprox: tokens, maxTokens };
  if (!key) {
    out.error = 'missing_key';
    return out;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a Review Yeti transport probe. Do not inspect files.' },
      {
        role: 'user',
        content:
          tokens <= 200
            ? 'Return exactly {"ok":true,"review":"SMOKE_OK"} as a JSON object.'
            : `${filler(tokens)}\nReturn JSON with keys decision, summary, findings.`,
      },
    ],
    temperature: 0,
    max_tokens: maxTokens,
    stream: !!stream,
    response_format: { type: 'json_object' },
  };
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    out.http = response.status;
    if (!response.body) {
      out.totalMs = Date.now() - started;
      out.error = 'no_body';
      return out;
    }
    const reader = response.body.getReader();
    let first = true;
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength || 0;
      if (first) {
        out.ttfbMs = Date.now() - started;
        first = false;
      }
    }
    out.bodyBytes = bytes;
    out.totalMs = Date.now() - started;
    if (out.ttfbMs == null) out.ttfbMs = out.totalMs;
    out.over30 = out.ttfbMs > 30_000;
  } catch (error) {
    out.totalMs = Date.now() - started;
    out.error = error?.name === 'AbortError' ? 'timeout' : error?.name;
    out.over30 = out.totalMs > 30_000;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

async function main() {
  const keyLen = (process.env.FIREWORKS_PR_REVIEW_API_KEY || '').length;
  console.log(`Fireworks debug model=${MODEL} key_len=${keyLen}`);
  const cases = [
    { label: 'smoke-json-nostream', tokens: 50, stream: false, maxTokens: 128, timeoutMs: 30_000 },
    { label: 'smoke-json-stream', tokens: 50, stream: true, maxTokens: 128, timeoutMs: 30_000 },
    { label: '26k-json-nostream', tokens: 26_000, stream: false, maxTokens: 1024, timeoutMs: 90_000 },
    { label: '26k-json-stream', tokens: 26_000, stream: true, maxTokens: 1024, timeoutMs: 90_000 },
  ];
  for (const item of cases) {
    console.log(JSON.stringify(await timedFetch(item.label, item)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`fireworks debug failed: ${error.name}`);
    process.exitCode = 1;
  });
}

export { timedFetch };
