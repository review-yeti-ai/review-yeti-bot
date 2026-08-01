#!/usr/bin/env node

/**
 * PI.dev Review Workflow Pipeline Script
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
const { spawnSync, execSync } = require('child_process');

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

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/auto';

// 12 Persona Charters configured with default model openrouter/auto
const PERSONA_CHARTERS = [
  {
    id: 'security',
    name: '🛡️ Security & Tenancy Guardian',
    model: DEFAULT_MODEL,
    charter: 'Audit for authentication bypasses, authorization flaws, OWASP Top 10 vulnerabilities, secret scanning (hardcoded API keys, JWTs, RSA keys), tenant isolation breaches, injection vulnerabilities, and unvalidated request boundaries.',
  },
  {
    id: 'performance',
    name: '⚡ Performance & Scalability Specialist',
    model: DEFAULT_MODEL,
    charter: 'Identify CPU and memory bottlenecks, algorithmic inefficiencies (O(N^2) nested loops), N+1 database query patterns, missing index requirements, synchronous blocking I/O, memory leaks, and inefficient resource allocation.',
  },
  {
    id: 'architecture',
    name: '🏛️ System Architecture & Design',
    model: DEFAULT_MODEL,
    charter: 'Inspect modular coupling boundaries, clean layer separation (Presentation -> Application -> Domain -> Infrastructure), DRY compliance, circular dependency prevention, clear domain abstractions, ADR alignment, and interface stability.',
  },
  {
    id: 'style',
    name: '✨ Code Style & Idioms Specialist',
    model: DEFAULT_MODEL,
    charter: 'Enforce language idioms, code readability, naming conventions, structural code cleanliness, anti-patterns, cyclomatic complexity control, and clean code formatting standards.',
  },
  {
    id: 'testing',
    name: '🧪 Testing & Quality Assurance',
    model: DEFAULT_MODEL,
    charter: 'Verify test coverage for modified and new functionality, unit and integration test validity, boundary and edge case coverage, test isolation, mock correctness, and flaky test hazards.',
  },
  {
    id: 'documentation',
    name: '📝 Documentation & API Specs',
    model: DEFAULT_MODEL,
    charter: 'Check for inline JSDoc/TSDoc comments on exported interfaces/functions, public API endpoint documentation, updated README and docs guides, CHANGELOG entries, and parameter/return descriptions.',
  },
  {
    id: 'accessibility',
    name: '♿ Accessibility (a11y) & Usability',
    model: DEFAULT_MODEL,
    charter: 'Audit HTML and UI components for WCAG 2.1 compliance, proper ARIA roles and attributes, image alt attributes, keyboard navigation support, color contrast, and semantic element usage.',
  },
  {
    id: 'database',
    name: '🗄️ Database & Persistence Specialist',
    model: DEFAULT_MODEL,
    charter: 'Review database schema migrations for zero-downtime rollback safety, non-blocking index creation (CREATE INDEX CONCURRENTLY), transaction isolation boundaries, deadlock hazards, parameterized query safety, and connection pool sizing.',
  },
  {
    id: 'devops',
    name: '🐳 DevOps & Containerization',
    model: DEFAULT_MODEL,
    charter: 'Inspect Dockerfile multi-stage build optimization, non-root user enforcement, Kubernetes YAML securityContext (readOnlyRootFilesystem, drop ALL), CPU/memory requests and limits, CI/CD pipeline safety, and infrastructure configs.',
  },
  {
    id: 'i18n',
    name: '🌐 Internationalization & Localizability',
    model: DEFAULT_MODEL,
    charter: 'Audit for hardcoded user-visible UI strings, missing translation keys, date/time/currency formatting abstractions, locale-aware sorting, and right-to-left (RTL) layout compatibility.',
  },
  {
    id: 'dependencies',
    name: '📦 Dependency Safety & Supply Chain',
    model: DEFAULT_MODEL,
    charter: 'Check for vulnerable or outdated dependencies, wildcard version specifiers (* or latest), supply chain security risks, package-lock integrity, and unverified third-party library imports.',
  },
  {
    id: 'licensing',
    name: '📄 License & IP Compliance',
    model: DEFAULT_MODEL,
    charter: 'Verify open-source license compatibility (MIT, Apache 2.0, BSD vs copyleft GPL/AGPL), third-party attribution requirements, open-source license headers, and corporate IP policy adherence.',
  },
];

const SEVERITIES = ['P0', 'P1', 'P2'];
const DEFAULT_MAX_DIFF_CHARS = 24_000;

/**
 * Resolves LLM endpoint configuration from the environment.
 *
 * Any OpenAI-compatible `/chat/completions` endpoint works; OpenRouter is the default because
 * OPENROUTER_API_KEY is already plumbed through the workflow.
 *
 * @returns {{enabled: boolean, apiKey: string, baseUrl: string, model: string, maxDiffChars: number}}
 */
function resolveModelConfig(env = process.env) {
  const apiKey = env.LLM_API_KEY || env.OPENROUTER_API_KEY || '';
  const baseUrl = (env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const model = env.OPENROUTER_MODEL || 'openrouter/auto';
  const maxDiffChars = parseInt(env.MAX_DIFF_CHARS || '', 10) || DEFAULT_MAX_DIFF_CHARS;

  return { enabled: Boolean(apiKey), apiKey, baseUrl, model, maxDiffChars };
}

/**
 * Extracts a findings array from a model response, tolerating prose and markdown fences.
 * Returns null when nothing parseable is present.
 */
function parseFindingsPayload(content) {
  if (!content || typeof content !== 'string') return null;

  const candidates = [];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(content);

  // Fall back to the outermost brace-delimited object embedded in prose.
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(content.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.findings)) return parsed.findings;
    } catch (_) {}
  }
  return null;
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

/**
 * Renders the diff for a prompt, capped at a character budget.
 *
 * The cap is a cost control as much as a context-window one: this runs once per persona per push,
 * so an unbounded diff multiplies straight into the bill.
 */
function renderDiffForPrompt(diffFiles, maxDiffChars) {
  let out = '';
  let truncated = false;

  for (const file of diffFiles) {
    const block = `\n--- FILE: ${file.path} ---\n${file.patch || ''}`;
    if (out.length + block.length > maxDiffChars) {
      out += `\n--- FILE: ${file.path} ---\n[diff truncated to fit the ${maxDiffChars} character review budget]\n`;
      truncated = true;
      break;
    }
    out += block;
  }

  if (truncated) {
    out += '\n[Some files were truncated. Report only on what you can see above.]\n';
  }
  return out;
}

/**
 * Evaluates one persona charter against the diff using an LLM.
 *
 * Never throws: a failed lane degrades to zero findings with an `error` set, so one bad persona
 * cannot take down a whole review.
 */
async function reviewWithModel(persona, diffFiles, prContext, sessionContext, options = {}) {
  const cfg = { ...resolveModelConfig(), ...options };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const maxDiffChars = options.maxDiffChars || cfg.maxDiffChars || DEFAULT_MAX_DIFF_CHARS;

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
    '- Use the exact file path as given in the diff headers.',
    '- Severity: P0 = exploitable or data-losing, P1 = must fix before merge, P2 = nit.',
    '- If the diff is clean by your charter, return an empty findings array. Finding nothing is a valid, useful result.',
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"findings":[{"severity":"P0|P1|P2","path":"<file path>","line":<int>,"title":"<short>","body":"<why it matters>","suggestion":"<concrete fix>"}]}',
  ].join('\n');

  const userPrompt = [
    `Repository: ${prContext.repo || 'unknown'}`,
    prContext.prNumber ? `Pull request: #${prContext.prNumber}` : '',
    prContext.title ? `Title: ${prContext.title}` : '',
    '',
    'Unified diff under review:',
    renderDiffForPrompt(diffFiles, maxDiffChars),
  ].filter(Boolean).join('\n');

  const base = { personaId: persona.id, displayName: persona.name, model: cfg.model };

  try {
    const response = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      // fetch has no default timeout; without this a stalled provider hangs the job until
      // GitHub's 6 hour ceiling.
      signal: AbortSignal.timeout(options.timeoutMs || 120_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ...base, decision: 'ERROR', findings: [], error: `HTTP ${response.status}: ${String(detail).slice(0, 200)}` };
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const rawFindings = parseFindingsPayload(content);

    if (rawFindings === null) {
      return { ...base, decision: 'ERROR', findings: [], error: 'Model response contained no parseable findings JSON.' };
    }

    const findings = sanitizeFindings(rawFindings, diffFiles);
    return { ...base, decision: findings.length === 0 ? 'APPROVE' : 'FINDINGS', findings };
  } catch (err) {
    return { ...base, decision: 'ERROR', findings: [], error: err.message };
  }
}

/**
 * Parses raw git diff text into per-file diff structures.
 */
function parseDiff(diffText) {
  if (!diffText || typeof diffText !== 'string') return [];
  const files = [];
  const lines = diffText.split('\n');
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
  let headSha = process.env.GITHUB_SHA || 'main';
  let title = 'Automated PR Review';
  let eventData = null;

  // 1. Check process.env.PR_DIFF
  if (process.env.PR_DIFF) {
    const raw = process.env.PR_DIFF.trim();
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.diff) diffText = parsed.diff;
        if (parsed.prNumber) prNumber = String(parsed.prNumber);
        if (parsed.repo) repo = parsed.repo;
        if (parsed.headSha) headSha = parsed.headSha;
        if (parsed.title) title = parsed.title;
      } catch (_) {
        diffText = raw;
      }
    } else {
      diffText = raw;
    }
  }

  // 2. Check process.env.GITHUB_EVENT_PATH
  if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    try {
      const eventContent = fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8');
      eventData = JSON.parse(eventContent);
      if (eventData.pull_request) {
        if (!prNumber && eventData.pull_request.number) {
          prNumber = String(eventData.pull_request.number);
        }
        if (eventData.pull_request.head && eventData.pull_request.head.sha) {
          headSha = eventData.pull_request.head.sha;
        }
        if (eventData.pull_request.title) {
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
      }
      if (!repo && eventData.repository && eventData.repository.full_name) {
        repo = eventData.repository.full_name;
      }
      if (!diffText && eventData.diff) {
        diffText = eventData.diff;
      }
    } catch (_) {}
  }

  // 3. Extract PR number from GITHUB_REF (e.g. refs/pull/42/merge)
  if (!prNumber && process.env.GITHUB_REF) {
    const refMatch = process.env.GITHUB_REF.match(/refs\/pull\/(\d+)/);
    if (refMatch) {
      prNumber = refMatch[1];
    }
  }

  // 4. Fallback to git command if no diff found yet
  if (!diffText) {
    try {
      diffText = execSync('git diff HEAD~1 2>/dev/null || git diff 2>/dev/null', { encoding: 'utf-8' }) || '';
    } catch (_) {}
  }

  // 5. PR_REPO wins over everything: the runner checks out the central review repository, so
  // GITHUB_REPOSITORY names the runner, not the repository actually under review.
  if (process.env.PR_REPO) {
    repo = process.env.PR_REPO;
  }

  return { diffText, prNumber, repo, headSha, title, eventData };
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
function resolvePersonaRoster(payload = {}, localConfig = null, env = process.env) {
  const builtins = new Map(PERSONA_CHARTERS.map((p) => [p.id, p]));
  const errors = [];

  // Repository-defined personas. An entry supplying a charter either defines a new reviewer or
  // overrides a built-in one; an entry without a charter may only reference a built-in.
  const localEntries = Array.isArray(localConfig?.parsed?.personas) ? localConfig.parsed.personas : [];
  const declared = new Map();

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

    const builtin = builtins.get(id);
    declared.set(id, {
      persona: {
        id,
        name: entry.name || builtin?.name || `🔎 ${id}`,
        model: entry.model || builtin?.model || DEFAULT_MODEL,
        charter: charter || builtin.charter,
      },
      enabled: entry.enabled !== false,
    });
  }

  // Selection source, most specific first.
  let selected = null;
  if (Array.isArray(payload?.activePersonas)) {
    selected = payload.activePersonas;
  } else if (payload?.personaSettings && typeof payload.personaSettings === 'object') {
    selected = Object.keys(payload.personaSettings)
      .filter((k) => payload.personaSettings[k]?.enabled !== false);
  } else if (declared.size > 0) {
    selected = [...declared.entries()].filter(([, v]) => v.enabled).map(([id]) => id);
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

  // Unconfigured means every built-in, plus anything the repository defined.
  if (selected === null) {
    selected = [...builtins.keys(), ...[...declared.keys()].filter((id) => !builtins.has(id))];
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

  return { personas, errors };
}

/**
 * Computes binding arbitration quorum verdict from persona evaluation results.
 *
 * @param {object[]} personaResults - Completed persona lane results.
 * @param {number} [expectedPersonas] - How many personas were expected to run; quorum is degraded
 *   when fewer completed. Defaults to the number of results supplied.
 */
function computeArbitrationQuorum(personaResults, expectedPersonas = personaResults.length) {
  let p0Count = 0;
  let p1Count = 0;
  let p2Count = 0;

  for (const res of personaResults) {
    for (const f of res.findings) {
      if (f.severity === 'P0') p0Count++;
      else if (f.severity === 'P1') p1Count++;
      else if (f.severity === 'P2') p2Count++;
    }
  }

  let verdict = 'SHIP';
  let rationale = `All ${personaResults.length} persona evaluation(s) passed or contained only minor nits. Quorum satisfied for release.`;

  if (p0Count > 0 || p1Count >= 3) {
    verdict = 'BLOCK';
    rationale = `Arbitration engine blocked merge due to ${p0Count} critical P0 finding(s) and ${p1Count} P1 finding(s).`;
  } else if (p1Count > 0 || p2Count >= 5) {
    verdict = 'FIX_FIRST';
    rationale = `Arbitration engine requested changes due to ${p1Count} P1 finding(s) and ${p2Count} P2 nit(s).`;
  }

  return {
    totalPersonas: expectedPersonas,
    completedPersonas: personaResults.length,
    quorumSatisfied: personaResults.length === expectedPersonas,
    verdict,
    rationale,
    metrics: { p0Count, p1Count, p2Count, totalFindings: p0Count + p1Count + p2Count },
  };
}

/**
 * Formats persona evaluation findings into a GitHub PR comment containing
 * a Mermaid summary graph/diagram and persona findings breakdown.
 */
function formatPRComment(arbitration, personaResults, prContext, mcpTelemetry = {}, modelConfig = {}) {
  const verdictBadge = arbitration.verdict === 'SHIP'
    ? '🟢 **Verdict: SHIP**'
    : arbitration.verdict === 'FIX_FIRST'
      ? '🟡 **Verdict: FIX_FIRST**'
      : '🔴 **Verdict: BLOCK**';

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
  let breakdownRows = '';
  personaResults.forEach((res) => {
    const icon = res.decision === 'APPROVE' ? '✅' : '⚠️';
    breakdownRows += `| ${res.displayName} | \`${res.model}\` | ${icon} ${res.decision} | ${res.findings.length} |\n`;
  });

  // Build Findings Details
  let findingsDetails = '';
  const findingLanes = personaResults.filter(r => r.findings.length > 0);

  if (personaResults.length === 0) {
    findingsDetails = '\nAll reviewer personas disabled in repository settings.\n';
  } else if (findingLanes.length === 0) {
    findingsDetails = '\n> 🎉 **No issues detected across enabled reviewer personas!**\n';
  } else {
    findingLanes.forEach((lane) => {
      findingsDetails += `\n<details open>\n<summary><b>${lane.displayName} (${lane.findings.length} findings)</b></summary>\n\n`;
      findingsDetails += '| Severity | Path | Line | Title | Suggestion |\n';
      findingsDetails += '|---|---|---|---|---|\n';
      lane.findings.forEach((f) => {
        const sevBadge = f.severity === 'P0' ? '🔴 P0' : f.severity === 'P1' ? '🟠 P1' : '🟡 P2';
        const sugg = (f.suggestion || f.body || '').replace(/\|/g, '\\|');
        findingsDetails += `| ${sevBadge} | \`${f.path}\` | ${f.line} | **${f.title}** | ${sugg} |\n`;
      });
      findingsDetails += '\n</details>\n';
    });
  }

  // State the review mode plainly. A heuristic pass dressed up as a model review is worse than
  // no review, because it is trusted like one.
  const reviewMode = modelConfig.enabled
    ? `Model-backed (\`${modelConfig.model}\`)`
    : '⚠️ Static heuristics only — no model configured, findings are regex-level';

  const failedLanes = personaResults.filter((r) => r.decision === 'ERROR');
  const failureNote = failedLanes.length > 0
    ? `\n- **Degraded Lanes**: ${failedLanes.length} persona(s) failed and were excluded — ${failedLanes.map(l => `${l.displayName} (${l.error})`).join('; ')}`
    : '';

  const commentMarkdown = `## ${verdictBadge}

### 📊 PI.dev Review Quorum Summary
- **Repository**: \`${prContext.repo}\`
- **Commit SHA**: \`${prContext.headSha.slice(0, 7)}\`
- **Review Mode**: ${reviewMode}
- **Parallel Personas Evaluated**: \`${arbitration.completedPersonas}/${arbitration.totalPersonas}\`
- **Quorum Status**: \`${arbitration.quorumSatisfied ? 'SATISFIED' : 'DEGRADED'}\`
- **MCP Server Telemetry**: ${mcpStatusLine}
- **Total Findings**: P0: \`${arbitration.metrics.p0Count}\` | P1: \`${arbitration.metrics.p1Count}\` | P2: \`${arbitration.metrics.p2Count}\`
- **Rationale**: ${arbitration.rationale}${failureNote}

### 🧬 Architectural Pipeline Flow
${mermaidLines.join('\n')}

### 📋 Persona Evaluation Roster
| Reviewer Persona | Model | Decision | Findings |
|---|---|---|---|
${breakdownRows}
${findingsDetails}`;

  return commentMarkdown;
}

/**
 * Posts formatted PR comment via `gh pr comment` CLI when PR number is available,
 * or outputs to stdout/file.
 */
function postOrOutputComment(commentBody, prContext) {
  const prNumber = prContext.prNumber;

  if (prNumber) {
    try {
      const tempPath = path.join('/tmp', `review-comment-${Date.now()}.md`);
      fs.writeFileSync(tempPath, commentBody, 'utf-8');

      // --repo is required: the review runner checks out the central review repository, so the
      // target PR is almost never the repository `gh` would infer from the working directory.
      const args = ['pr', 'comment', String(prNumber), '--body-file', tempPath];
      if (prContext.repo && prContext.repo.includes('/')) {
        args.push('--repo', prContext.repo);
      }

      const result = spawnSync('gh', args, {
        encoding: 'utf-8',
        env: process.env,
      });

      try { fs.unlinkSync(tempPath); } catch (_) {}

      if (result.status === 0) {
        console.log(`[PI.dev Review Pipeline] Successfully posted PR comment to PR #${prNumber} via gh CLI.`);
        return { success: true, postedViaGh: true };
      } else {
        console.warn(`[PI.dev Review Pipeline] gh CLI comment returned non-zero status (${result.status}): ${result.stderr || result.stdout}`);
      }
    } catch (err) {
      console.warn(`[PI.dev Review Pipeline] Error executing gh pr comment CLI: ${err.message}`);
    }
  } else {
    console.log('[PI.dev Review Pipeline] No PR_NUMBER found in event context; skipping `gh pr comment` invocation.');
  }

  // Fallback to outputting comment to file & stdout
  const commentFilePath = path.join(process.cwd(), 'review-comment.md');
  try {
    fs.writeFileSync(commentFilePath, commentBody, 'utf-8');
    console.log(`[PI.dev Review Pipeline] Saved formatted review comment to ${commentFilePath}`);
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
function writeStepOutputs(arbitration, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;

  const m = arbitration.metrics || {};
  const lines = [
    `verdict=${arbitration.verdict}`,
    `findings-count=${m.totalFindings || 0}`,
    `p0-count=${m.p0Count || 0}`,
    `p1-count=${m.p1Count || 0}`,
    `p2-count=${m.p2Count || 0}`,
    `personas-completed=${arbitration.completedPersonas || 0}`,
    `personas-total=${arbitration.totalPersonas || 0}`,
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
function loadLocalRepoConfig() {
  const candidates = ['.ct-review.yaml', '.ct-review.yml', '.coderabbit.yaml', '.coderabbit.yml'];
  for (const file of candidates) {
    const fullPath = path.resolve(process.cwd(), file);
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
  console.log('🚀 PI.dev Review Workflow Pipeline Engine');
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

  const localConfig = loadLocalRepoConfig();

  const mcpFleetInfo = await initMcpFleet(prContext.eventData?.client_payload);
  console.log(`[MCP] ${mcpFleetInfo.mcpStatusSummary}`);

  const diffFiles = parseDiff(prContext.diffText);
  console.log(`[Payload] Parsed ${diffFiles.length} file(s) from PR diff payload.`);

  if (diffFiles.length === 0) {
    console.log('[Payload] Diff is empty; nothing to review. Exiting without posting a comment.');
    return;
  }

  const modelConfig = resolveModelConfig();
  console.log(modelConfig.enabled
    ? `[Model] Model-backed review enabled: ${modelConfig.model} (diff budget ${modelConfig.maxDiffChars} chars/persona).`
    : '[Model] No API key configured; heuristic-only mode.');

  // Determine active/enabled personas from dispatch payload, local YAML config, or environment
  const payload = prContext.eventData?.client_payload || {};
  const roster = resolvePersonaRoster(payload, localConfig, process.env);

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
      verdict: 'SHIP',
      rationale: 'All reviewer personas disabled in repository settings.',
      quorumSatisfied: true,
      completedPersonas: 0,
      totalPersonas: 0,
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0 },
    };
  } else {
    if (modelConfig.enabled) {
      console.log(`[Parallel Evaluation] Dispatching ${enabledPersonas.length} persona lane(s) to ${modelConfig.model} via ${modelConfig.baseUrl}...`);
      personaResults = await Promise.all(
        enabledPersonas.map((persona) => reviewWithModel(persona, diffFiles, prContext, sessionContext, modelConfig))
      );

      const failed = personaResults.filter((r) => r.decision === 'ERROR');
      for (const lane of failed) {
        console.warn(`[Persona ${lane.personaId}] Lane failed: ${lane.error}`);
      }
      if (failed.length === personaResults.length) {
        console.error('[Review] Every persona lane failed. Refusing to post a verdict derived from zero completed reviews.');
        process.exitCode = 1;
        return;
      }
    } else {
      console.warn('[Review] No LLM API key configured (set OPENROUTER_API_KEY or LLM_API_KEY).');
      console.warn('[Review] Falling back to static heuristic checks. This is NOT a model-backed review.');
      personaResults = await Promise.all(
        enabledPersonas.map((persona) => evaluatePersonaLane(persona, diffFiles, prContext, sessionContext))
      );
    }

    console.log('[Arbitration] Computing binding arbitration quorum...');
    const completed = personaResults.filter((r) => r.decision !== 'ERROR');
    arbitration = computeArbitrationQuorum(completed, enabledPersonas.length);
  }

  console.log(`[Verdict] ${arbitration.verdict} | Rationale: ${arbitration.rationale}`);

  console.log('[Formatting] Formatting GitHub PR comment output with Mermaid diagram and MCP telemetry...');
  const commentMarkdown = formatPRComment(arbitration, personaResults, prContext, mcpFleetInfo, modelConfig);

  console.log('[Publishing] Executing PR comment publishing...');
  postOrOutputComment(commentMarkdown, prContext);

  writeStepOutputs(arbitration);

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
  DEFAULT_MODEL,
  parseDiff,
  getPRDiffAndContext,
  resolvePersonaRoster,
  resolveModelConfig,
  reviewWithModel,
  parseFindingsPayload,
  sanitizeFindings,
  loadLocalRepoConfig,
  writeStepOutputs,
  initMcpFleet,
  evaluatePersonaLane,
  computeArbitrationQuorum,
  formatPRComment,
  postOrOutputComment,
  main,
};
