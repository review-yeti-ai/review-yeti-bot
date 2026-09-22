#!/usr/bin/env node
// scripts/honcho-mcp.mjs — Review Yeti Stdio MCP Server for Honcho operational memory
//
// MCP JSON-RPC 2.0 over stdio. Vanilla Node >=18 (native fetch). Honcho v3 API.
// Lets reviewer personas RECALL institutional memory (past failures, decisions,
// checkpoints) and STORE new conclusions — reviews honor settled facts instead
// of re-litigating them.
//
// RETIREMENT CONDITION (REL-888 followup): Honcho is ALREADY federated on the
// ct-mcp gateway (https://llm-gateway.example.com/mcp exposes
// honcho-recall_memory / honcho-store_conclusion / ...). This stdio server
// exists only because the review worker mounts MCP servers as local stdio
// commands and cannot consume gateway-streamed tools yet. Once the worker
// supports gateway MCP transport, delete this script and the
// policy/review-yeti.json mcp_servers entry `honcho-memory` — personas reach
// Honcho through the gateway like every other federated tool, and this file
// becomes a second, drifting implementation of the same five tools.
//
// Env: HONCHO_API_KEY, HONCHO_BASE_URL, HONCHO_WORKSPACE (all required).
// Observer peer is the reviewer identity (REVIEW_RUN_ID or 'review-yeti').

import readline from 'node:readline';
import { isEntrypoint } from './entrypoint-guard.mjs';

const REQUIRED_ENV = ['HONCHO_API_KEY', 'HONCHO_BASE_URL', 'HONCHO_WORKSPACE'];
const OBSERVER = 'review-yeti';

function envReady() {
  return REQUIRED_ENV.every((k) => process.env[k] && String(process.env[k]).trim() !== '');
}

function baseUrl() {
  return String(process.env.HONCHO_BASE_URL || '').replace(/\/$/, '');
}

async function honchoFetch(path, method = 'GET', body = null) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.HONCHO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Honcho ${method} ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

function redact(s) {
  return String(s || '')
    .replace(/(gh[pousr]_)[A-Za-z0-9]{20,}/g, '$1<redacted>')
    .replace(/(sk-)[A-Za-z0-9_-]{20,}/g, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{20,}/gi, '$1<redacted>')
    .replace(/(AQ\.)[A-Za-z0-9._-]{20,}/g, '$1<redacted>');
}

async function recall(query, topK = 5) {
  if (!envReady()) return { error: `Honcho env not configured: need ${REQUIRED_ENV.join(', ')}` };
  const clean = redact(String(query || '').trim().slice(0, 300));
  if (!clean) return { error: 'query is required' };
  const data = await honchoFetch(
    `/v3/workspaces/${encodeURIComponent(process.env.HONCHO_WORKSPACE)}/conclusions/query`,
    'POST',
    {
      query: clean,
      top_k: Math.min(Number(topK) || 5, 10),
      filters: { observer_id: OBSERVER, observed_id: 'exampleorg-platform' },
    },
  );
  const results = (Array.isArray(data) ? data : (data.conclusions || data.results || []))
    .slice(0, 10)
    .map((m) => ({
      id: m.id,
      content: redact(String(m.content || '')).slice(0, 600),
      level: m.level,
      session_id: m.session_id || undefined,
    }));
  return { query: clean, results, count: results.length };
}

async function store(statement, level, sessionOverride) {
  if (!envReady()) return { error: `Honcho env not configured: need ${REQUIRED_ENV.join(', ')}` };
  const content = redact(String(statement || '')).slice(0, 4000);
  if (!content) return { error: 'statement is required' };
  const rawSession = sessionOverride || `review-yeti-${process.env.REVIEW_RUN_ID || 'adhoc'}`;
  const sessionId = rawSession.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 512) || 'review-yeti-adhoc';
  // Ensure the session exists (idempotent) before storing a conclusion.
  try {
    await honchoFetch(
      `/v3/workspaces/${encodeURIComponent(process.env.HONCHO_WORKSPACE)}/sessions`,
      'POST',
      { id: sessionId },
    );
  } catch (e) {
    if (!String(e).includes('409') && !String(e).includes('already exists')) {
      return { error: String(e.message || e) };
    }
  }
  const data = await honchoFetch(
    `/v3/workspaces/${encodeURIComponent(process.env.HONCHO_WORKSPACE)}/conclusions`,
    'POST',
    {
      conclusions: [{
        content,
        observer_id: OBSERVER,
        observed_id: 'exampleorg-platform',
        session_id: sessionId,
      }],
    },
  );
  const first = (Array.isArray(data) ? data : (data.conclusions || [data]))[0] || {};
  return { stored: true, id: first.id || undefined };
}

const TOOLS = [
  {
    name: 'honcho_recall',
    description: 'Recall institutional memory: past failures, decisions, corrections, and checkpoints relevant to the review target. Query BEFORE finalizing findings to avoid re-litigating settled issues or repeating known false positives.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search topic: repo, failure signature, decision, or checkpoint.' },
        top_k: { type: 'number', description: 'Max results (default 5, max 10).' },
      },
    },
  },
  {
    name: 'honcho_store',
    description: 'Store a durable operational conclusion from this review (RCA verdict, false-positive pattern, settled decision). Bounded statements; secrets are redacted automatically.',
    inputSchema: {
      type: 'object',
      required: ['statement'],
      properties: {
        statement: { type: 'string', description: 'High-signal conclusion (max 4000 chars).' },
        level: {
          type: 'string',
          enum: ['explicit', 'deductive', 'inductive', 'contradiction'],
          description: 'Conclusion level (optional).',
        },
      },
    },
  },
  {
    name: 'honcho_status',
    description: 'Check Honcho wiring health (env configured, API reachable).',
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
      serverInfo: { name: 'honcho-memory', version: '1.0.0' },
    };
  }
  if (request.method === 'notifications/initialized') return null;
  if (request.method === 'tools/list') return { tools: TOOLS };
  if (request.method !== 'tools/call') throw Object.assign(new Error('method not found'), { code: -32601 });

  const name = request.params?.name;
  const args = request.params?.arguments || {};

  try {
    if (name === 'honcho_recall') return toolResult(await recall(args.query, args.top_k));
    if (name === 'honcho_store') return toolResult(await store(args.statement, args.level));
    if (name === 'honcho_status') {
      if (!envReady()) {
        return toolResult({ ready: false, missing_env: REQUIRED_ENV.filter((k) => !process.env[k]) }, true);
      }
      const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(8000) }).catch((e) => ({ status: 0, error: String(e) }));
      return toolResult({ ready: true, workspace: process.env.HONCHO_WORKSPACE, api_reachable: Boolean(res.status) });
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
          error: { code: error.code ?? -32603, message: error.message || 'honcho-memory request failed' },
        })}\n`);
      }
    }
  }
}

if (isEntrypoint(import.meta.url)) {
  runServer();
}
