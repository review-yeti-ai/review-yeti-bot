#!/usr/bin/env node
// scripts/arbiter-mcp.mjs — Review Yeti Arbiter: normalizes freeform persona
// output into the strict verdict contract, tolerating flexible LLM responses.
//
// Why: persona lanes dispatched to providers that do not honor structured
// output (e.g. ollama glm-5.3-flash via bifrost) intermittently return prose,
// ```json fences, or schema-drifted objects. The worker's contract validator
// rejects those (malformed_output). The arbiter parses ANY output, extracts
// the verdict, enforces the enum + schema, and returns contract-conformant
// JSON using the governed Bifrost route backed by NeuralWatt.
//
// Env: BIFROST_PR_REVIEW_API_KEY (required), ARBITER_MODEL (optional,
// default pr-reviewer), ARBITER_MAX_RETRIES (default 2).

import readline from 'node:readline';
import { isEntrypoint } from './entrypoint-guard.mjs';

const BIFROST_BASE_URL = 'https://gateway-internal.example.com/v1';
const ARBITER_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'BLOCK', 'FIX_FIRST'] },
    confidence: { type: 'number' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'line', 'severity', 'title', 'body'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          body: { type: 'string', maxLength: 4000 },
        },
      },
    },
    rationale: { type: 'string', maxLength: 4000 },
  },
};

function apiKey() {
  return process.env.BIFROST_PR_REVIEW_API_KEY || '';
}

function extractJson(text) {
  if (!text) return null;
  // strip markdown fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence && fence[1], text];
  for (const c of candidates) {
    if (!c) continue;
    // find first balanced object
    const start = c.indexOf('{');
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (!inStr && ch === '{') depth++;
      if (ch === '}' && depth > 0) { depth--; if (depth === 0) {
        try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
      }}
    }
  }
  return null;
}

function normalizeVerdict(v) {
  const s = String(v || '').trim().toUpperCase();
  const map = { APPROVE: 'APPROVE', SHIP: 'APPROVE', PASS: 'APPROVE', LGT: 'APPROVE',
    BLOCK: 'BLOCK', REJECT: 'BLOCK', DENY: 'BLOCK',
    FIX_FIRST: 'FIX_FIRST', FIX: 'FIX_FIRST', REQUEST_CHANGES: 'FIX_FIRST' };
  return map[s] || null;
}

function normalizeFindings(f) {
  if (!Array.isArray(f)) return [];
  return f.slice(0, 20).map((x) => ({
    path: String(x.path || x.file || x.location || 'unknown').slice(0, 300),
    line: Number(x.line || x.line_number || 0) || 0,
    severity: ['P0','P1','P2','P3'].includes(String(x.severity||'').toUpperCase())
      ? String(x.severity).toUpperCase()
      : (x.priority ? String(x.priority).toUpperCase() : 'P2'),
    body: String(x.body || x.message || x.description || x.summary || '').slice(0, 4000),
  }));
}

async function arbitrate(rawOutput, expectedSchemaHint) {
  const key = apiKey();
  if (!key) return { error: 'BIFROST_PR_REVIEW_API_KEY env not configured' };
  const raw = String(rawOutput || '').slice(0, 60000);
  if (!raw.trim()) return { error: 'raw_output is required' };

  // Fast path: already conformant?
  const direct = extractJson(raw);
  if (direct && ['APPROVE','BLOCK','FIX_FIRST'].includes(String(direct.verdict||'').toUpperCase())
      && (!direct.findings || Array.isArray(direct.findings))) {
    return {
      arbitrated: false,
      verdict: String(direct.verdict).toUpperCase(),
      findings: normalizeFindings(direct.findings),
      rationale: String(direct.rationale || direct.summary || '').slice(0, 4000),
    };
  }

  // Arbiter call on the structured-capable lane
  const maxRetries = Number(process.env.ARBITER_MAX_RETRIES || 2);
  let lastErr = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const bodyStr = JSON.stringify({
      model: process.env.ARBITER_MODEL || 'pr-reviewer',
      messages: [
        { role: 'system', content:
          'You are a review-output arbiter. You receive a raw AI-reviewer output that may be prose, markdown-fenced JSON, or schema-drifted JSON. ' +
          'Extract the review verdict and findings, normalize them to the exact contract, and respond ONLY with the JSON object — no prose, no fences.' +
          (expectedSchemaHint ? `\nTarget schema: ${expectedSchemaHint}` : '') +
          ' Verdict enum is EXACTLY one of: APPROVE, BLOCK, FIX_FIRST. Findings items have: path (string), line (number), severity (P0|P1|P2|P3), body (string). Add rationale (string, max 4000 chars) summarizing the reviewer\'s actual judgments — do not invent findings. If the raw output contains no review verdict at all, set verdict to "BLOCK" with a single finding explaining the raw output was unintelligible.' },
        { role: 'user', content: `Raw reviewer output to arbitrate:\n\n${raw.slice(0, 30000)}` },
      ],
      max_tokens: 4000,
      response_format: { type: 'json_schema', json_schema: { name: 'arbitrated_verdict', strict: true, schema: ARBITER_SCHEMA } },
    });
    const req = fetch(`${BIFROST_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: bodyStr,
      signal: AbortSignal.timeout(90_000),
    });
    try {
      const res = await req;
      if (!res.ok) { lastErr = `HTTP ${res.status}: ${(await res.text().catch(()=>(''))).slice(0,150)}`; continue; }
      const d = await res.json();
      const content = d.choices?.[0]?.message?.content || '';
      const parsed = extractJson(content);
      if (!parsed) { lastErr = `arbiter returned non-JSON: ${content.slice(0,120)}`; continue; }
      const verdict = String(parsed.verdict || '').toUpperCase();
      if (!['APPROVE','BLOCK','FIX_FIRST'].includes(verdict)) { lastErr = `arbiter verdict invalid: ${verdict}`; continue; }
      return {
        arbitrated: true,
        verdict,
        confidence: Number(parsed.confidence) || undefined,
        findings: normalizeFindings(parsed.findings),
        rationale: String(parsed.rationale || '').slice(0, 4000),
        attempt,
      };
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  return { error: `arbiter failed after ${maxRetries + 1} attempts: ${lastErr}` };
}

const TOOLS = [
  {
    name: 'arbitrate_verdict',
    description: 'Normalize your raw review output into the strict verdict contract. Call this BEFORE returning your lane result if you are unsure your output is contract-conformant (e.g. you are on a provider that may not honor JSON schema). Tolerates prose, markdown fences, schema drift. Returns the strict verdict JSON to return as your lane result.',
    inputSchema: {
      type: 'object',
      required: ['raw_output'],
      properties: {
        raw_output: { type: 'string', description: 'Your complete raw review output (prose, fenced JSON, or drifted JSON — anything).' },
        schema_hint: { type: 'string', description: 'Optional description of the target schema if it differs from the standard verdict contract.' },
      },
    },
  },
  {
    name: 'arbiter_status',
    description: 'Check arbiter lane health (structured-capable provider reachable, API key configured).',
    inputSchema: { type: 'object', properties: {} },
  },
];

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
}

async function handle(request) {
  if (request.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'review-arbiter', version: '1.0.0' },
    };
  }
  if (request.method === 'notifications/initialized') return null;
  if (request.method === 'tools/list') return { tools: TOOLS };
  if (request.method !== 'tools/call') throw Object.assign(new Error('method not found'), { code: -32601 });

  const name = request.params?.name;
  const args = request.params?.arguments || {};
  try {
    if (name === 'arbitrate_verdict') return toolResult(await arbitrate(args.raw_output, args.schema_hint));
    if (name === 'arbiter_status') {
      const key = apiKey();
      if (!key) return toolResult({ ready: false, missing: 'BIFROST_PR_REVIEW_API_KEY' }, true);
      const res = await fetch(`${BIFROST_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000),
      }).catch((e) => ({ status: 0, error: String(e) }));
      return toolResult({ ready: Boolean(res.status), model: process.env.ARBITER_MODEL || 'pr-reviewer', upstream: res.status || String(res.error) });
    }
    throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
  } catch (error) {
    return toolResult({ error: String(error.message || error) }, true);
  }
}

export async function runServer(input = process.stdin, output = process.stdout) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      const result = await handle(request);
      if (request.id !== undefined && result !== null) {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      }
    } catch (error) {
      if (request?.id !== undefined) {
        output.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: error.code ?? -32603, message: error.message || 'arbiter request failed' },
        })}\n`);
      }
    }
  }
}

if (isEntrypoint(import.meta.url)) {
  runServer();
}
