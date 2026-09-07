#!/usr/bin/env node
// scripts/ct-impact.mjs — Standalone Blast Radius Scout & AST Code Mesh Engine for Review Yeti
//
// Fast, self-contained, zero-npm-dependency analyzer for CI runners and local reviews.
// Inspects PR changed files and targets against the compiled exampleorg AST mesh:
//   - Upstream Phoenix routes, controllers, and schemas (example-api)
//   - Downstream Quasar Vue 3 components, Pinia stores, and composables (example-ui)
//   - JTAPI Sidecar reflection classes and CTI Operator handlers (jtapi-sidecar, jtapi-operator)
//   - Ingestion microservices and NATS topics (ct-sftpd-go, ct-syslog-ingest-go, etc.)
//   - Acceptance test scenarios (example-uat)
//   - Governing OKF Architectural Decision Records (ADRs)
//   - Documentation (vitepress) and Marketing (next-cloudflare)
//   - Exact verification test commands
//
// Vanilla Node >=18, zero external dependencies. Uses built-in zlib for compressed mesh.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPTS_DIR, '..');

let cachedMesh = null;

/**
 * Loads the compiled AST code mesh.
 * Resolves .json or decompress .json.gz using Node's built-in zlib.
 */
export function loadMesh(options = {}) {
  if (cachedMesh && !options.refresh) return cachedMesh;

  const candidatePaths = [
    process.env.CT_MESH_PATH,
    join(REPO_ROOT, 'knowledge/mesh/cross-repo-mesh.json'),
    join(REPO_ROOT, 'knowledge/mesh/cross-repo-mesh.json.gz'),
    // Fallback if running in a peer workspace:
    join(REPO_ROOT, '../example-meta/knowledge/mesh/cross-repo-mesh.json'),
    join(REPO_ROOT, '../example-meta/knowledge/mesh/cross-repo-mesh.json.gz'),
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (!existsSync(p)) continue;
    try {
      if (p.endsWith('.gz')) {
        const compressed = readFileSync(p);
        const decompressed = gunzipSync(compressed).toString('utf8');
        cachedMesh = JSON.parse(decompressed);
        return cachedMesh;
      }
      cachedMesh = JSON.parse(readFileSync(p, 'utf8'));
      return cachedMesh;
    } catch (err) {
      // try next candidate
    }
  }

  throw new Error('Cross-repo code mesh index not found. Ensure knowledge/mesh/cross-repo-mesh.json.gz exists.');
}

function normalizeRoute(str) {
  return (str || '')
    .toLowerCase()
    .replace(/\/org\/:[a-zA-Z0-9_]+/g, '/org/:org_id')
    .replace(/\/org\/[a-zA-Z0-9_-]+/g, '/org/:org_id')
    .replace(/\/:[a-zA-Z0-9_]+/g, '/:param')
    .replace(/\/$/, '')
    .trim();
}

function baseToken(str) {
  if (!str) return '';
  let base = str.split(/[\/\\]/).pop() || '';
  base = base.replace(/\.(ex|exs|js|ts|vue|java|go|json|md)$/i, '');
  base = base.split('.').pop() || '';
  base = base.replace(/controller$/i, '');
  return base.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Single-pass impact analysis for an array of diff files.
 * @param {Array<string|{path: string, patch?: string}>} files
 * @param {object} options
 */
export function analyzeDiffFiles(files = [], options = {}) {
  const meshData = options.meshData || loadMesh(options);
  const normalizedFilePaths = files.map((f) => (typeof f === 'string' ? f : f.path || '')).filter(Boolean);

  const touchedTokens = new Set(normalizedFilePaths.map((p) => baseToken(p)).filter((t) => t.length >= 3));
  const rawFilePaths = new Set(normalizedFilePaths);

  const results = {
    analyzed_at: new Date().toISOString(),
    files_count: normalizedFilePaths.length,
    touched_files: normalizedFilePaths,
    backend_routes: [],
    frontend_consumers: [],
    nats_topics: [],
    microservices: [],
    uat_scenarios: [],
    governing_adrs: [],
    documentation_pages: [],
    marketing_pages: [],
    verification_commands: new Set(),
  };

  const seenRoutes = new Set();
  const seenFrontend = new Set();
  const seenTopics = new Set();
  const seenMicroservices = new Set();
  const seenAdrs = new Set();
  const seenDocs = new Set();

  for (const item of meshData.mesh || []) {
    if (item.kind === 'http_route') {
      const ctrlBase = baseToken(item.backend?.controller);
      const fileBase = baseToken(item.backend?.file);

      const isDirectPath = rawFilePaths.has(item.backend?.file) || rawFilePaths.has(item.path);
      const isTokenMatch = (ctrlBase && touchedTokens.has(ctrlBase)) || (fileBase && touchedTokens.has(fileBase));
      const isFrontendMatch = item.frontend_consumers?.some((fc) => rawFilePaths.has(fc.file) || touchedTokens.has(baseToken(fc.file)));
      const isUatMatch = item.uat_scenarios?.some((u) => rawFilePaths.has(u.file) || touchedTokens.has(baseToken(u.id)));

      if (isDirectPath || isTokenMatch || isFrontendMatch || isUatMatch) {
        const routeKey = `${item.method} ${item.path}`;
        if (!seenRoutes.has(routeKey)) {
          seenRoutes.add(routeKey);
          results.backend_routes.push({
            method: item.method,
            path: item.path,
            controller: item.backend?.controller,
            action: item.backend?.action,
            file: item.backend?.file,
            line: item.backend?.line,
          });
          if (item.backend?.suggested_test) results.verification_commands.add(item.backend.suggested_test);
        }

        for (const fc of item.frontend_consumers || []) {
          const fcKey = `${fc.file}:${fc.line}`;
          if (!seenFrontend.has(fcKey)) {
            seenFrontend.add(fcKey);
            results.frontend_consumers.push(fc);
            results.verification_commands.add(`yarn test:unit ${fc.file}`);
          }
        }

        for (const uat of item.uat_scenarios || []) {
          results.uat_scenarios.push(uat);
          if (uat.run_command) results.verification_commands.add(uat.run_command);
        }

        for (const adr of item.governing_adrs || []) {
          if (!seenAdrs.has(adr.number)) {
            seenAdrs.add(adr.number);
            results.governing_adrs.push(adr);
          }
        }

        for (const doc of item.documentation_pages || []) {
          if (!seenDocs.has(doc.file)) {
            seenDocs.add(doc.file);
            results.documentation_pages.push(doc);
          }
        }

        for (const mkt of item.marketing_pages || []) {
          results.marketing_pages.push(mkt);
        }
      }
    }

    if (item.kind === 'nats_topic') {
      const topicBase = baseToken(item.topic);
      const isElixirMatch = item.example_api?.some((c) => rawFilePaths.has(c.file) || touchedTokens.has(baseToken(c.file)));
      const isJavaMatch = item.jtapi_sidecar?.some((j) => rawFilePaths.has(j.file) || touchedTokens.has(baseToken(j.file)));
      const isGoSftp = item.ct_sftpd_go?.some((g) => rawFilePaths.has(g.file) || touchedTokens.has(baseToken(g.file)));
      const isGoSyslog = item.ct_syslog_ingest_go?.some((g) => rawFilePaths.has(g.file) || touchedTokens.has(baseToken(g.file)));

      if (isElixirMatch || isJavaMatch || isGoSftp || isGoSyslog || touchedTokens.has(topicBase)) {
        if (!seenTopics.has(item.topic)) {
          seenTopics.add(item.topic);
          results.nats_topics.push(item);
          if (item.jtapi_sidecar?.length > 0) results.verification_commands.add('mvn test -Dtest=*Nats*');
          if (item.example_api?.length > 0) results.verification_commands.add('fmix test test/cdrcisco/jtapi_greeting/nats_communication_test.exs');
          if (item.ct_sftpd_go?.length > 0) results.verification_commands.add('go test ./...');
          if (item.ct_syslog_ingest_go?.length > 0) results.verification_commands.add('make test');
        }
      }
    }
  }

  // Check microservices
  if (meshData.microservices) {
    for (const [sName, mData] of Object.entries(meshData.microservices)) {
      const sBase = baseToken(sName);
      if (touchedTokens.has(sBase) || normalizedFilePaths.some((p) => p.includes(sName))) {
        if (!seenMicroservices.has(sName)) {
          seenMicroservices.add(sName);
          results.microservices.push({ name: sName, ...mData });
          if (mData.suggested_test) results.verification_commands.add(mData.suggested_test);
        }
      }
    }
  }

  results.verification_commands = Array.from(results.verification_commands);
  return results;
}

/**
 * Analyzes impact for a single target query (file path, route, topic, or symbol).
 */
export function analyzeTarget(target = '', options = {}) {
  const meshData = options.meshData || loadMesh(options);
  const cleanTarget = String(target).trim();
  if (!cleanTarget) {
    return { error: 'Target query cannot be empty' };
  }

  const results = {
    target: cleanTarget,
    matched_kind: null,
    backend_routes: [],
    frontend_consumers: [],
    nats_topics: [],
    microservices: [],
    uat_scenarios: [],
    governing_adrs: [],
    documentation_pages: [],
    marketing_pages: [],
    verification_commands: new Set(),
  };

  const seenRoutes = new Set();
  const seenFrontend = new Set();
  const seenTopics = new Set();
  const seenAdrs = new Set();
  const seenDocs = new Set();

  const normTarget = normalizeRoute(cleanTarget);
  const targetBase = baseToken(cleanTarget);

  for (const item of meshData.mesh || []) {
    if (item.kind === 'http_route') {
      const normPath = normalizeRoute(item.path);
      const isPathMatch = normPath === normTarget || normPath.includes(normTarget) || normTarget.includes(normPath);
      const isControllerMatch = item.backend?.controller && (
        item.backend.controller.toLowerCase().includes(cleanTarget.toLowerCase()) ||
        (targetBase.length >= 4 && baseToken(item.backend.controller) === targetBase)
      );
      const isFileMatch = item.backend?.file && (
        item.backend.file.includes(cleanTarget) ||
        (targetBase.length >= 4 && baseToken(item.backend.file) === targetBase)
      );
      const isFrontendMatch = item.frontend_consumers?.some((fc) => (
        fc.file.includes(cleanTarget) || (targetBase.length >= 4 && baseToken(fc.file) === targetBase)
      ));

      if (isPathMatch || isControllerMatch || isFileMatch || isFrontendMatch) {
        results.matched_kind = 'http_route';
        const routeKey = `${item.method} ${item.path}`;
        if (!seenRoutes.has(routeKey)) {
          seenRoutes.add(routeKey);
          results.backend_routes.push({
            method: item.method,
            path: item.path,
            controller: item.backend?.controller,
            action: item.backend?.action,
            file: item.backend?.file,
            line: item.backend?.line,
          });

          if (item.backend?.suggested_test) results.verification_commands.add(item.backend.suggested_test);
        }

        for (const fc of item.frontend_consumers || []) {
          const fcKey = `${fc.file}:${fc.line}`;
          if (!seenFrontend.has(fcKey)) {
            seenFrontend.add(fcKey);
            results.frontend_consumers.push(fc);
            results.verification_commands.add(`yarn test:unit ${fc.file}`);
          }
        }

        for (const uat of item.uat_scenarios || []) {
          results.uat_scenarios.push(uat);
          if (uat.run_command) results.verification_commands.add(uat.run_command);
        }

        for (const adr of item.governing_adrs || []) {
          if (!seenAdrs.has(adr.number)) {
            seenAdrs.add(adr.number);
            results.governing_adrs.push(adr);
          }
        }

        for (const doc of item.documentation_pages || []) {
          if (!seenDocs.has(doc.file)) {
            seenDocs.add(doc.file);
            results.documentation_pages.push(doc);
          }
        }

        for (const mkt of item.marketing_pages || []) {
          results.marketing_pages.push(mkt);
        }
      }
    }

    if (item.kind === 'nats_topic') {
      const isTopicMatch = item.topic.includes(cleanTarget) || cleanTarget.includes(item.topic);
      const isElixirMatch = item.example_api?.some((c) => c.file.includes(cleanTarget) || (targetBase.length >= 4 && baseToken(c.file) === targetBase));
      const isJavaMatch = item.jtapi_sidecar?.some((j) => j.file.includes(cleanTarget) || (targetBase.length >= 4 && baseToken(j.file) === targetBase));
      const isGoSftp = item.ct_sftpd_go?.some((g) => g.file.includes(cleanTarget) || (targetBase.length >= 4 && baseToken(g.file) === targetBase));
      const isGoSyslog = item.ct_syslog_ingest_go?.some((g) => g.file.includes(cleanTarget) || (targetBase.length >= 4 && baseToken(g.file) === targetBase));

      if (isTopicMatch || isElixirMatch || isJavaMatch || isGoSftp || isGoSyslog) {
        if (!seenTopics.has(item.topic)) {
          seenTopics.add(item.topic);
          results.matched_kind = results.matched_kind || 'nats_topic';
          results.nats_topics.push(item);
          if (item.jtapi_sidecar?.length > 0) results.verification_commands.add('mvn test -Dtest=*Nats*');
          if (item.example_api?.length > 0) results.verification_commands.add('fmix test test/cdrcisco/jtapi_greeting/nats_communication_test.exs');
          if (item.ct_sftpd_go?.length > 0) results.verification_commands.add('go test ./...');
          if (item.ct_syslog_ingest_go?.length > 0) results.verification_commands.add('make test');
        }
      }
    }
  }

  // Microservices check
  if (meshData.microservices) {
    for (const [name, data] of Object.entries(meshData.microservices)) {
      if (name.toLowerCase().includes(cleanTarget.toLowerCase()) || cleanTarget.includes(name)) {
        results.microservices.push({ name, ...data });
        if (data.suggested_test) results.verification_commands.add(data.suggested_test);
      }
    }
  }

  results.verification_commands = Array.from(results.verification_commands);
  return results;
}

/**
 * Universal wrapper matching ct_impact MCP signature.
 */
export function analyzeImpact(target, options = {}) {
  if (Array.isArray(target)) {
    return analyzeDiffFiles(target, options);
  }
  if (typeof target === 'string' && target.trim()) {
    return analyzeTarget(target, options);
  }
  return { error: 'Invalid target specified for impact analysis' };
}

/**
 * Formats impact result into clean GitHub Markdown for Review Yeti prompts and comments.
 */
export function formatImpactMarkdown(impact) {
  if (!impact || impact.error) return '';
  const lines = [];

  lines.push('### Cross-Repository Blast Radius & Downstream Consumers');

  if (impact.backend_routes && impact.backend_routes.length > 0) {
    lines.push('\n**Upstream Phoenix Routes & Controllers (example-api)**:');
    for (const r of impact.backend_routes.slice(0, 8)) {
      lines.push(`- \`${r.method} ${r.path}\` → \`${r.controller}#${r.action}\` (${r.file}:${r.line})`);
    }
  }

  if (impact.frontend_consumers && impact.frontend_consumers.length > 0) {
    lines.push('\n**Downstream Quasar / Vue 3 Components & Stores (example-ui)**:');
    for (const fc of impact.frontend_consumers.slice(0, 10)) {
      lines.push(`- \`${fc.file}:${fc.line}\` (calls \`${fc.call}\`)`);
    }
  }

  if (impact.nats_topics && impact.nats_topics.length > 0) {
    lines.push('\n**NATS Event Topics & Cross-Service Pub/Sub**:');
    for (const t of impact.nats_topics.slice(0, 6)) {
      lines.push(`- Topic: \`${t.topic}\``);
    }
  }

  if (impact.microservices && impact.microservices.length > 0) {
    lines.push('\n**Ingestion Microservices Impacted**:');
    for (const m of impact.microservices.slice(0, 5)) {
      lines.push(`- \`${m.name || m.service}\`: ${m.description || 'Ingestion service'} (${m.suggested_test || ''})`);
    }
  }

  if (impact.uat_scenarios && impact.uat_scenarios.length > 0) {
    lines.push('\n**example-uat Scenarios**:');
    for (const u of impact.uat_scenarios.slice(0, 5)) {
      lines.push(`- Scenario \`${u.id}\`: ${u.name} (\`${u.run_command || ''}\`)`);
    }
  }

  if (impact.governing_adrs && impact.governing_adrs.length > 0) {
    lines.push('\n**Governing Architectural Decision Records (ADRs)**:');
    for (const a of impact.governing_adrs.slice(0, 6)) {
      lines.push(`- ADR ${a.number}: ${a.title}`);
    }
  }

  if (impact.verification_commands && impact.verification_commands.length > 0) {
    lines.push('\n**Recommended Verification Commands**:');
    lines.push('```bash');
    for (const cmd of impact.verification_commands.slice(0, 8)) {
      lines.push(cmd);
    }
    lines.push('```');
  }

  return lines.join('\n');
}

