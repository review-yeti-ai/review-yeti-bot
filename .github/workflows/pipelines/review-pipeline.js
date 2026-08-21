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
const { spawnSync, execSync } = require('child_process');
const { computeArbitration: computeCanonicalArbitration, sanitizeFindings: sanitizeCanonicalFindings } = require('../../../src/review/reviewCore');
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
    name: '📄 License & IP Compliance',
    model: DEFAULT_MODEL,
    defaultEnabled: false,
    charter: `You review changes for licence obligations the project may be taking on.

Flag:
- A dependency added under a copyleft licence, such as GPL or AGPL, in a project distributed under a permissive one.
- Substantial code that appears copied from another project without attribution.
- Removal or alteration of an existing copyright or licence notice.
- A project licence changed in a way that conflicts with what it already depends on.

Do not flag:
- Missing licence headers on individual files. Most projects do not use per-file headers, and demanding them on every new file is noise. Raise this only where the surrounding files visibly carry headers already.
- Dependencies under permissive licences such as MIT, Apache 2.0, BSD or ISC.
- Licence questions you cannot answer from the diff.

Severity: P1 for an incompatible licence obligation or a removed notice. P2 for attribution worth adding. P0 does not apply.`,
  },
];

// Reviewers that apply to essentially any codebase. The rest are situational: enabling all twelve
// everywhere produces findings about internationalisation in projects that ship one language, and
// licence headers in projects that use none.
const DEFAULT_PERSONA_IDS = PERSONA_CHARTERS.filter((p) => p.defaultEnabled).map((p) => p.id);

const SEVERITIES = ['P0', 'P1', 'P2'];
const DEFAULT_MAX_DIFF_CHARS = 410_400;
const ACTION_MAX_DIFF_CAP = 10_000_000;
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
function resolveModelConfig(env = process.env) {
  const apiKey = env.OPENROUTER_API_KEY || '';
  const baseUrl = (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const model = env.OPENROUTER_MODEL || 'openrouter/auto';
  const dynamicDefaultDiff = calculateSafeDiffCapacity(model);
  const maxDiffChars = parseInt(env.MAX_DIFF_CHARS || '', 10) || dynamicDefaultDiff;

  return { enabled: Boolean(apiKey), apiKey, baseUrl, model, maxDiffChars };
}

function trustedOpenRouterInputsFromEnv(env = process.env) {
  return {
    'llm-base-url': env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
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

function loadActionSubmoduleUrls(repoRoot, parentRepository) {
  const filePath = path.resolve(repoRoot, '.gitmodules');
  if (!fs.existsSync(filePath)) return {};
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return {};
  }
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

function normalizeResponseProvider(provider) {
  if (typeof provider === 'string' && provider.trim()) return provider.trim();
  if (provider && typeof provider === 'object') {
    const name = provider.name || provider.id || provider.slug;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

function resolveResponseModel(payload, fallbackModel) {
  return typeof payload?.model === 'string' && payload.model.trim()
    ? payload.model.trim()
    : typeof payload?.model_id === 'string' && payload.model_id.trim()
      ? payload.model_id.trim()
      : fallbackModel;
}

function resolveResponseProvider(payload) {
  return normalizeResponseProvider(payload?.provider)
    || normalizeResponseProvider(payload?.usage?.provider)
    || 'openrouter';
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
 * Evaluates one persona charter against the diff using an LLM.
 *
 * Never throws: a failed lane degrades to zero findings with an `error` set, so one bad persona
 * cannot take down a whole review.
 */
async function reviewWithModel(persona, diffFiles, prContext, sessionContext, options = {}) {
  const cfg = { ...resolveModelConfig(), ...options };
  const fetchImpl = options.fetchImplementation || options.fetchImpl || globalThis.fetch;
  const maxDiffChars = options.maxDiffChars || cfg.maxDiffChars || DEFAULT_MAX_DIFF_CHARS;
  let requestOptions = null;
  let resultBase = {
    personaId: persona.id,
    displayName: persona.name,
    model: cfg.model,
    provider: 'openrouter',
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
    '- Use the exact file path as given in the diff headers.',
    '- Every finding must name what breaks and under what conditions. If you cannot, do not report it.',
    '- Severity: P0 = exploitable, data-losing or outage-causing. P1 = a defect that must be fixed before merge. P2 = worth doing, safe to merge without.',
    '- P1 and P0 are rare. When unsure between two levels, choose the lower one.',
    '- If the diff is clean by your charter, return an empty findings array. Finding nothing is the expected result on most changes, and is more useful than a speculative finding.',
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

    const candidateTransports = Array.isArray(options.transports) && options.transports.length > 0
      ? options.transports
      : [{
          baseUrl: requestOptions?.baseUrl || cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: requestOptions?.model || cfg.model,
          provider: requestOptions?.provider,
          plugins: requestOptions?.plugins,
          name: 'default',
          timeoutMs: options.timeoutMs || 90_000,
          ttftTimeoutMs: options.ttftTimeoutMs || 20_000,
        }];

    let lastError = null;

    for (let i = 0; i < candidateTransports.length; i++) {
      const transport = candidateTransports[i];
      const transportName = transport.name || transport.provider || 'default';
      const requestModel = transport.model || cfg.model;
      const transportApiKey = transport.apiKey || transport.api_key || cfg.apiKey;
      const transportBaseUrl = (transport.baseUrl || transport.base_url || cfg.baseUrl).replace(/\/+$/, '');
      const transportTimeoutMs = transport.timeoutMs || transport.timeout_ms || options.timeoutMs || 90_000;
      const transportTtftTimeoutMs = transport.ttftTimeoutMs || transport.connect_timeout_ms || 20_000;

      resultBase = { ...resultBase, model: requestModel, transport: transportName };

      const requestBody = {
        model: requestModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      };

      if (transport.plugins || requestOptions?.plugins) {
        requestBody.plugins = transport.plugins || requestOptions?.plugins;
      }
      if (transport.provider || requestOptions?.provider) {
        requestBody.provider = transport.provider || requestOptions?.provider;
      }

      let heartbeatTimer = null;
      const startMs = Date.now();
      heartbeatTimer = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startMs) / 1000);
        console.log(`[Persona: ${persona.id}] Awaiting model response from ${requestModel} via ${transportName} (${elapsedSec}s elapsed)...`);
      }, 15_000);

      try {
        const response = await fetchImpl(`${transportBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${transportApiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(transportTimeoutMs),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          const errMsg = `HTTP ${response.status}: ${String(detail).slice(0, 200)}`;
          // Check if retryable / queue failure for fallback
          if (i < candidateTransports.length - 1 && (response.status === 429 || response.status === 503 || response.status === 500 || detail.includes('cancelled') || detail.includes('queue'))) {
            console.warn(`[Persona: ${persona.id}] Fast failover: transport '${transportName}' returned ${errMsg}; trying next transport...`);
            lastError = errMsg;
            continue;
          }
          return { ...resultBase, decision: 'ERROR', findings: [], error: errMsg };
        }

        const payload = await response.json();
        const responseBase = {
          ...resultBase,
          model: resolveResponseModel(payload, requestModel),
          provider: resolveResponseProvider(payload),
          transport: transportName,
          cost: extractResponseCost(payload),
          ...extractResponseTokenUsage(payload),
        };

        if (payload?.error) {
          const message = payload.error.message || payload.error.code || JSON.stringify(payload.error);
          if (i < candidateTransports.length - 1 && (String(message).includes('cancelled') || String(message).includes('rate') || String(message).includes('queue'))) {
            console.warn(`[Persona: ${persona.id}] Fast failover: transport '${transportName}' error payload (${message}); trying next transport...`);
            lastError = message;
            continue;
          }
          return { ...responseBase, decision: 'ERROR', findings: [], error: `Provider returned an error payload: ${String(message).slice(0, 200)}` };
        }

        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          try {
            const providerLane = JSON.parse(content);
            if (providerLane?.error) {
              const message = providerLane.error.message || providerLane.error.code || JSON.stringify(providerLane.error);
              if (i < candidateTransports.length - 1) {
                console.warn(`[Persona: ${persona.id}] Fast failover: transport '${transportName}' error payload (${message}); trying next transport...`);
                lastError = message;
                continue;
              }
              return { ...responseBase, decision: 'ERROR', findings: [], error: `Provider returned an error payload: ${String(message).slice(0, 200)}` };
            }
          } catch (_) {}
        }

        const rawFindings = parseFindingsPayload(content);
        if (rawFindings === null) {
          return { ...responseBase, decision: 'ERROR', findings: [], error: 'Model response contained no parseable findings JSON.' };
        }

        const findings = sanitizeFindings(rawFindings, diffFiles);
        return { ...responseBase, decision: findings.length === 0 ? 'APPROVE' : 'FINDINGS', findings, coverage };
      } catch (err) {
        lastError = err.message;
        if (i < candidateTransports.length - 1) {
          console.warn(`[Persona: ${persona.id}] Fast failover: transport '${transportName}' exception (${err.message}); trying next transport...`);
          continue;
        }
        return { ...resultBase, decision: 'ERROR', findings: [], error: err.message };
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    }

    return { ...resultBase, decision: 'ERROR', findings: [], error: lastError || 'All transports failed' };
  } catch (err) {
    return { ...resultBase, decision: 'ERROR', findings: [], error: err.message };
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
        if (parsed.headSha) headSha = parsed.headSha;
        if (parsed.baseSha) baseSha = parsed.baseSha;
        if (parsed.title) title = parsed.title;
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
        if (eventData.pull_request.head && eventData.pull_request.head.sha) {
          headSha = eventData.pull_request.head.sha;
        }
        if (eventData.pull_request.base && eventData.pull_request.base.sha) {
          baseSha = eventData.pull_request.base.sha;
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
    const provider = escapeMarkdownTableCell(res.provider || 'openrouter');
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
  //
  // Rendered as stacked blocks rather than a table. A markdown table gives the path its own
  // column, so a single deeply-nested filename crushes the title and suggestion into columns one
  // word wide.
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
        if (f.suggestion) findingsDetails += `\n> **Fix:** ${f.suggestion}\n`;
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

  const commentMarkdown = `## ${verdictBadge}

### 📊 ${BOT_LABEL} Summary
- **Repository**: \`${prContext.repo}\`
${commitRangeLine}
- **Review Mode**: ${reviewMode}${coverageBadge}
- **Parallel Personas Evaluated**: \`${arbitration.completedPersonas}/${arbitration.totalPersonas}\`
- **Quorum Status**: \`${arbitration.quorumSatisfied ? 'SATISFIED' : 'DEGRADED'}\`
- **MCP Server Telemetry**: ${mcpStatusLine}
- **Total Findings**: P0: \`${arbitration.metrics.p0Count}\` | P1: \`${arbitration.metrics.p1Count}\` | P2 / Nits: \`${arbitration.metrics.p2Count}\`
- **Rationale**: ${arbitration.rationale}${failureNote}${coverageNote}

### 🧬 Architectural Pipeline Flow
${mermaidLines.join('\n')}

### 📋 Persona Evaluation Roster
| Reviewer Persona | Provider | Model | Decision | P0 | P1 | P2 / Nits | Input Tokens | Output Tokens | Cost |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
${breakdownRows}
${findingsDetails}${partitionManifestSection}`;

  return commentMarkdown;
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
          '.[].body',
        ], {
          encoding: 'utf-8',
          env: process.env,
        });
        if (!existing || existing.status !== 0) {
          const error = `gh api could not verify the existing review marker: ${existing?.stderr || existing?.stdout || 'unknown error'}`;
          console.warn(`[Publish] ${error}`);
          return { success: false, postedViaGh: false, error };
        }
        if (String(existing.stdout || '').includes(marker)) {
          console.log(`[Publish] Exact-head review marker already exists for PR #${prNumber}; skipping duplicate.`);
          return { success: true, postedViaGh: true, deduplicated: true };
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
function writeStepOutputs(arbitration, outputPath = process.env.GITHUB_OUTPUT, coverage = null) {
  if (!outputPath) return;

  const m = arbitration.metrics || {};
  const totalFiles = coverage?.totalFiles ?? (coverage?.reviewed?.length || 0);
  const omittedFiles = coverage?.omittedFilesCount ?? (coverage?.omitted?.length || 0);
  const partitionsCount = coverage?.partitionsCount ?? (coverage?.partitionPlan ? coverage.partitionPlan.partitions.length : 1);
  const coveragePct = coverage?.coveragePercent ?? (totalFiles > 0 && omittedFiles === 0 ? 100 : Math.round(((totalFiles - omittedFiles) / Math.max(1, totalFiles)) * 100));

  const lines = [
    `verdict=${arbitration.verdict}`,
    `findings-count=${m.totalFindings || 0}`,
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

  const baseSubmoduleUrls = loadActionSubmoduleUrls(configRoot, prContext.repo);
  const submoduleUrls = loadActionSubmoduleUrls(process.cwd(), prContext.repo);
  const submoduleReview = applyActionSubmodulePolicy(diffFiles, actionPolicy.submodules, { baseSubmoduleUrls, submoduleUrls, parentRepository: prContext.repo });
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
      if (partitionPlan && partitionPlan.partitions.length > 1) {
        console.log(`[Parallel Evaluation] Dispatching ${enabledPersonas.length} persona lane(s) across ${partitionPlan.partitions.length} partitions to ${modelConfig.model}...`);
        const partitionRuns = await Promise.all(
          partitionPlan.partitions.map(async (partition) => {
            const partitionOptions = {
              ...modelConfig,
              partition,
              partitionPlan,
              maxDiffChars: safeDiffCapacityChars,
            };
            return Promise.all(
              enabledPersonas.map((persona) =>
                reviewWithModel(persona, partition.files, prContext, sessionContext, partitionOptions)
              )
            );
          })
        );

        // Aggregate results per persona across partitions
        personaResults = enabledPersonas.map((persona, pIdx) => {
          const laneRuns = partitionRuns.map((pRun) => pRun[pIdx]);
          const allFindings = laneRuns.flatMap((r) => r.findings || []);
          const totalInputTokens = laneRuns.reduce((sum, r) => sum + (r.inputTokens || 0), 0);
          const totalOutputTokens = laneRuns.reduce((sum, r) => sum + (r.outputTokens || 0), 0);
          const anyError = laneRuns.find((r) => r.decision === 'ERROR');
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
            decision: anyError ? 'ERROR' : (allFindings.length === 0 ? 'APPROVE' : 'FINDINGS'),
            error: anyError ? anyError.error : undefined,
          };
        });
      } else {
        console.log(`[Parallel Evaluation] Dispatching ${enabledPersonas.length} persona lane(s) to ${modelConfig.model} via ${modelConfig.baseUrl}...`);
        personaResults = await Promise.all(
          enabledPersonas.map((persona) => reviewWithModel(persona, reviewDiffFiles, prContext, sessionContext, modelConfig))
        );
      }

      const failed = personaResults.filter((r) => r.decision === 'ERROR');
      for (const lane of failed) {
        console.warn(`[Persona ${lane.personaId}] Lane failed: ${lane.error}`);
      }
      if (failed.length === personaResults.length) {
        console.error('[Review] Every persona lane failed. Refusing to post a verdict derived from zero completed reviews.');
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

  writeStepOutputs(arbitration, process.env.GITHUB_OUTPUT, coverage);

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
  planDiffBudget,
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
  isSubscriptionTransport,
  isSubscriptionLane,
  calculateSafeDiffCapacity,
  getStaticModelContext,
  formatCost,
  shaPartitionManager,
  main,
};
