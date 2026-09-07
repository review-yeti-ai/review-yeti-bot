#!/usr/bin/env node
// scripts/ct-impact-mcp.mjs — Review Yeti Stdio MCP Server for Cross-Repo AST Mesh & Blast Radius
//
// Compliant with Model Context Protocol (MCP) JSON-RPC 2.0 specification over stdio.
// Exposes ct_impact, ct_mesh_query, and ct_mesh_stats to Review Yeti reviewer personas.
//
// Vanilla Node >=18, zero external dependencies.

import readline from 'node:readline';
import { isEntrypoint } from './entrypoint-guard.mjs';
import { analyzeImpact, loadMesh, formatImpactMarkdown } from './ct-impact.mjs';

function getMeshStats() {
  try {
    const meshData = loadMesh();
    return {
      generated_at: meshData.generated_at,
      workspace_root: meshData.workspace_root,
      stats: meshData.stats,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

function queryMesh(query, kind = 'all') {
  try {
    const meshData = loadMesh();
    const cleanQ = String(query || '').toLowerCase().trim().slice(0, 100);
    if (!cleanQ) return { error: 'Query parameter is required' };

    const matches = [];
    if (kind === 'all' || kind === 'http_route') {
      const routes = (meshData.mesh || []).filter((m) => m.kind === 'http_route' && (
        m.path?.toLowerCase().includes(cleanQ) ||
        m.backend?.controller?.toLowerCase().includes(cleanQ) ||
        m.backend?.file?.toLowerCase().includes(cleanQ)
      ));
      matches.push(...routes.slice(0, 15));
    }
    if (kind === 'all' || kind === 'nats_topic') {
      const topics = (meshData.mesh || []).filter((m) => m.kind === 'nats_topic' && (
        m.topic?.toLowerCase().includes(cleanQ)
      ));
      matches.push(...topics.slice(0, 10));
    }
    if ((kind === 'all' || kind === 'microservice') && meshData.microservices) {
      const mservices = Object.entries(meshData.microservices).filter(([name, data]) => (
        name.toLowerCase().includes(cleanQ) ||
        data.service?.toLowerCase().includes(cleanQ) ||
        data.suggested_test?.toLowerCase().includes(cleanQ)
      )).map(([name, data]) => ({ kind: 'microservice', name, ...data }));
      matches.push(...mservices);
    }
    if ((kind === 'all' || kind === 'documentation') && Array.isArray(meshData.documentation)) {
      const docs = meshData.documentation.filter((d) => (
        d.title?.toLowerCase().includes(cleanQ) ||
        d.file?.toLowerCase().includes(cleanQ) ||
        d.keywords?.some((k) => k.includes(cleanQ))
      ));
      matches.push(...docs.slice(0, 10).map((d) => ({ kind: 'documentation', ...d })));
    }
    if ((kind === 'all' || kind === 'marketing') && Array.isArray(meshData.marketing)) {
      const mkts = meshData.marketing.filter((m) => (
        m.title?.toLowerCase().includes(cleanQ) ||
        m.file?.toLowerCase().includes(cleanQ) ||
        (m.feature_slug && m.feature_slug.includes(cleanQ))
      ));
      matches.push(...mkts.slice(0, 10).map((m) => ({ kind: 'marketing', ...m })));
    }

    return {
      query,
      kind,
      total_matches: matches.length,
      matches,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

const impactToolContract = {
  description: 'Scout cross-repository blast radius across Phoenix routes/controllers, Quasar Vue components, JTAPI sidecar/operator, UAT scenarios, governing ADRs, and Ingestion microservices for given changed files or targets.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Target file path, HTTP route (e.g. /api/jtapi/audio), NATS topic (e.g. cucm.jtapi.*), controller (e.g. JtapiAudioController), or component.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of touched/modified file paths to evaluate in a single batch.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: 'Output format: "markdown" (default, human-readable) or "json" (structured raw data).',
      },
    },
  },
};

const TOOLS = [
  { name: 'impact_analysis', ...impactToolContract },
  { name: 'ct_impact', ...impactToolContract },
  {
    name: 'ct_mesh_query',
    description: 'Query nodes and relationships in the exampleorg cross-repository AST mesh (example-api, example-ui, jtapi-sidecar, jtapi-operator, example-uat, example-meta, vitepress, next-cloudflare, ct-sftpd-go, ct-syslog-ingest-go).',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword, route path, NATS topic, or symbol.',
        },
        kind: {
          type: 'string',
          enum: ['all', 'http_route', 'nats_topic', 'microservice', 'documentation', 'marketing'],
          description: 'Category of nodes to query (default: all).',
        },
      },
    },
  },
  {
    name: 'ct_mesh_stats',
    description: 'Return real-time aggregate statistics of the exampleorg cross-repo AST mesh across all repositories.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
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
      serverInfo: { name: 'ct-impact', version: '1.0.0' },
    };
  }
  if (request.method === 'notifications/initialized') return null;
  if (request.method === 'tools/list') return { tools: TOOLS };
  if (request.method !== 'tools/call') throw Object.assign(new Error('method not found'), { code: -32601 });

  const name = request.params?.name;
  const args = request.params?.arguments || {};

  if (name === 'ct_mesh_stats') {
    return toolResult(getMeshStats());
  }

  if (name === 'ct_mesh_query') {
    const qRes = queryMesh(args.query || '', args.kind || 'all');
    return toolResult(qRes, Boolean(qRes.error));
  }

  if (name === 'ct_impact' || name === 'impact_analysis') {
    const target = args.files && args.files.length > 0 ? args.files : (args.target || '');
    if (!target || (Array.isArray(target) && target.length === 0)) {
      return toolResult({ error: 'Either "target" or "files" must be provided.' }, true);
    }
    const impact = analyzeImpact(target);
    const markdown = formatImpactMarkdown(impact);
    return toolResult({ markdown, ...impact });
  }

  throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
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
          error: { code: error.code ?? -32603, message: error.message || 'ct-impact request failed' },
        })}\n`);
      }
    }
  }
}

if (isEntrypoint(import.meta.url)) {
  runServer();
}

