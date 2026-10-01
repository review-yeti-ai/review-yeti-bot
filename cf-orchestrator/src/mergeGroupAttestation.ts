/**
 * mergeGroupAttestation.ts
 *
 * Direct GitHub webhook-driven merge-group attestation for Review Yeti.
 * Handles GitHub `merge_group` (`checks_requested`) webhook events directly in the Cloudflare
 * Worker to eliminate dedicated GitHub Actions runner overhead.
 *
 * Implements:
 * 1. Verification via GitHub GraphQL API of all constituent PRs at or ahead of current queue position
 *    (with cursor pagination and defensive error parsing).
 * 2. Strict exact-head Review Yeti check-run verification from App ID 4385771.
 * 3. Speculative composite delta hazard scanning for batched PRs and drifted PRs:
 *    - Base branch drift diff evaluation (`compare/${baseSha}...${queueBaseSha}`)
 *    - Conflicting Ecto migration timestamps across PRs and against base drift
 *    - Shared runtime/config file collisions (such as `mcp-servers.json` or `mix.lock`)
 *    - Incompatible caller/callee contract breaks (with word/invocation boundary matching and modification checks)
 *    - Clean single-PR queue entries with no base drift bypass scan for instant zero-cost attestation
 * 4. Direct check-run publication via GitHub API with name "Review Yeti",
 *    output title "Review Yeti (Merge Group Attestation)", and external ID "merge-group:${headSha}".
 */

import type { Env } from './types.js';

export const DEFAULT_REQUIRED_APP_ID = '4385771';
export const REQUIRED_CHECK_NAME = 'Review Yeti';
export const ATTESTATION_CHECK_TITLE = 'Review Yeti (Merge Group Attestation)';

export interface MergeGroupPayload {
  action: string;
  merge_group?: {
    head_sha?: string;
    head_ref?: string;
    base_ref?: string;
    base_sha?: string;
    head_commit?: {
      id?: string;
      tree_id?: string;
      message?: string;
    };
  };
  repository?: {
    name?: string;
    full_name?: string;
    owner?: {
      login?: string;
    };
  };
  installation?: {
    id?: number;
  };
}

export interface MergeQueueEntry {
  position: number;
  state: string;
  number: number;
  head_sha: string;
  base_sha?: string;
}

export interface ConstituentVerificationResult {
  passed: boolean;
  blockerReason?: string;
  prs: MergeQueueEntry[];
}

export interface HazardFinding {
  type: 'migration_collision' | 'shared_config_collision' | 'contract_break';
  file: string;
  prNumber: number;
  conflictingPrNumber?: number;
  description: string;
}

export interface HazardScanResult {
  passed: boolean;
  bypassed: boolean;
  hazards: HazardFinding[];
  diagnosticSummary?: string;
}

export interface CheckRunRecord {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string;
  external_id?: string | null;
  app?: {
    id: number | string;
    slug?: string;
  };
}

export interface AttestationOutcome {
  status: 'attested' | 'blocked';
  headSha: string;
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
  constituentPrs: number[];
  bypassedHazardScan: boolean;
  hazards?: HazardFinding[];
  checkRunId?: number;
  checkRunError?: string;
}

export const SHARED_RUNTIME_CONFIG_PATTERNS = [
  /(?:^|\/)mcp-servers(?:\.[a-zA-Z0-9_-]+)?\.json$/,
  /(?:^|\/)mix\.lock$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)Cargo\.lock$/,
  /(?:^|\/)Gemfile\.lock$/,
  /(?:^|\/)config\/[a-zA-Z0-9_/-]*\.exs$/,
  /(?:^|\/)\.env(?:\.[a-zA-Z0-9_-]+)*$/,
  /(?:^|\/)wrangler\.(?:json|toml)$/,
];

export const ECTO_MIGRATION_PATTERN = /(?:^|\/)priv\/[a-zA-Z0-9_/-]*migrations\/(\d+)_([^.]+)\.exs$/;

/**
 * Extracts PR number from merge group head_ref string,
 * e.g. "refs/heads/gh-readonly-queue/main/pr-4836-1234abcd" -> 4836
 */
export function extractPrNumberFromHeadRef(headRef: string): number | null {
  if (!headRef || typeof headRef !== 'string') return null;
  const cleaned = headRef.replace(/\/+$/, '').trim();
  const match = cleaned.match(/(?:^|\/)pr[-_]?(\d+)(?:[-_.][0-9a-zA-Z_-]+)?$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isNaN(num) || num <= 0 ? null : num;
}

/**
 * Normalizes base_ref, stripping any leading "refs/heads/".
 */
export function normalizeBaseBranch(baseRef: string): string {
  if (!baseRef || typeof baseRef !== 'string') return '';
  return baseRef.replace(/^refs\/heads\//, '').trim();
}

/**
 * Queries GitHub GraphQL API for merge queue entries and filters constituent PRs
 * at or ahead of the current queue position, supporting cursor pagination and error reporting.
 */
export async function getConstituentPullRequests(params: {
  owner: string;
  repo: string;
  baseBranch: string;
  currentPrNumber: number;
  token: string;
  fetchFn?: typeof fetch;
}): Promise<ConstituentVerificationResult> {
  const { owner, repo, baseBranch, currentPrNumber, token, fetchFn = fetch } = params;

  const query = `query($owner: String!, $name: String!, $branch: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) {
      entries(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          position
          state
          baseCommit {
            oid
          }
          pullRequest {
            number
            headRefOid
            baseRefOid
          }
        }
      }
    }
  }
}`;

  const validEntries: MergeQueueEntry[] = [];
  let cursor: string | null = null;
  let page = 1;
  const maxPages = 5;

  while (page <= maxPages) {
    let data: any;
    try {
      const res = await fetchFn('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'ReviewYeti-Edge-Orchestrator',
        },
        body: JSON.stringify({
          query,
          variables: { owner, name: repo, branch: baseBranch, after: cursor },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          passed: false,
          blockerReason: `merge queue API error (${res.status}): ${errText}`,
          prs: [],
        };
      }

      data = await res.json();
    } catch (err: any) {
      return {
        passed: false,
        blockerReason: `merge queue API fetch exception: ${err?.message || String(err)}`,
        prs: [],
      };
    }

    if (data?.errors && Array.isArray(data.errors) && data.errors.length > 0) {
      return {
        passed: false,
        blockerReason: `merge queue GraphQL error: ${data.errors[0]?.message || JSON.stringify(data.errors)}`,
        prs: [],
      };
    }

    const mergeQueueObj = data?.data?.repository?.mergeQueue;
    if (mergeQueueObj === null) {
      return {
        passed: false,
        blockerReason: `merge queue is not enabled or not found on branch "${baseBranch}" for ${owner}/${repo}`,
        prs: [],
      };
    }

    const entriesObj = mergeQueueObj?.entries;
    const nodes = entriesObj?.nodes;
    if (!Array.isArray(nodes)) {
      return {
        passed: false,
        blockerReason: 'merge queue API returned no entries array',
        prs: [],
      };
    }

    for (const node of nodes) {
      if (node?.pullRequest && typeof node.pullRequest.number === 'number') {
        const baseOid = node.baseCommit?.oid
          ? String(node.baseCommit.oid)
          : (node.pullRequest.baseRefOid ? String(node.pullRequest.baseRefOid) : undefined);
        validEntries.push({
          position: node.position,
          state: String(node.state || ''),
          number: node.pullRequest.number,
          head_sha: String(node.pullRequest.headRefOid || ''),
          base_sha: baseOid,
        });
      }
    }

    const hasNext = Boolean(entriesObj?.pageInfo?.hasNextPage);
    const endCursor = entriesObj?.pageInfo?.endCursor;
    const currentFound = validEntries.some((e) => e.number === currentPrNumber);

    if (!hasNext || !endCursor || currentFound) {
      break;
    }

    cursor = endCursor;
    page++;
  }

  const currentSeen = validEntries.filter((e) => e.number === currentPrNumber);
  if (currentSeen.length !== 1) {
    return {
      passed: false,
      blockerReason: `merge queue API did not return current PR #${currentPrNumber} exactly once (found ${currentSeen.length})`,
      prs: [],
    };
  }

  const currentEntry = currentSeen[0];
  if (currentEntry.position === undefined || currentEntry.position === null) {
    return {
      passed: false,
      blockerReason: `current PR #${currentPrNumber} has no queue position`,
      prs: [],
    };
  }

  const constituentPrs = validEntries.filter((e) => e.position <= currentEntry.position);
  if (constituentPrs.length < 1) {
    return {
      passed: false,
      blockerReason: `merge queue API returned no entries through current PR #${currentPrNumber}`,
      prs: [],
    };
  }

  constituentPrs.sort((a, b) => a.position - b.position);

  for (const pr of constituentPrs) {
    if (!pr.number || !pr.head_sha) {
      return {
        passed: false,
        blockerReason: 'merge_group constituent entry omitted pull-request number or head_sha',
        prs: [],
      };
    }
    if (!/^[0-9a-fA-F]{40}$/.test(pr.head_sha)) {
      return {
        passed: false,
        blockerReason: `invalid constituent head SHA for PR #${pr.number}: ${pr.head_sha}`,
        prs: [],
      };
    }
    if (pr.state === 'UNMERGEABLE' || pr.state === 'LOCKED') {
      return {
        passed: false,
        blockerReason: `merge queue entry for PR #${pr.number} is not mergeable (${pr.state})`,
        prs: [],
      };
    }
  }

  return {
    passed: true,
    prs: constituentPrs,
  };
}

/**
 * Fetches all check runs for a commit with full pagination support.
 */
export async function fetchAllCheckRunsForCommit(params: {
  owner: string;
  repo: string;
  commitSha: string;
  token: string;
  fetchFn?: typeof fetch;
}): Promise<CheckRunRecord[]> {
  const { owner, repo, commitSha, token, fetchFn = fetch } = params;
  const allChecks: CheckRunRecord[] = [];
  let page = 1;
  const maxPages = 20;

  while (page <= maxPages) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}/check-runs?filter=all&per_page=100&page=${page}`;
    const res = await fetchFn(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ReviewYeti-Edge-Orchestrator',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitHub check-runs API error (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { check_runs?: CheckRunRecord[] };
    const runs = data?.check_runs || [];
    if (runs.length === 0) break;

    allChecks.push(...runs);
    if (runs.length < 100) break;
    page++;
  }

  return allChecks;
}

/**
 * Verifies that a constituent PR possesses a valid, successful, App-owned Review Yeti check:
 * - name == REQUIRED_CHECK_NAME ('Review Yeti')
 * - app.id == REQUIRED_APP_ID (4385771)
 * - external_id matches ^run_[a-f0-9]{32}:a[1-9][0-9]*$ (excludes synthetic merge-group attestations)
 * - started_at is non-empty string and id is number
 * - newest review (sorted chronologically by started_at, with numeric id tie-breaker) has status 'completed' and conclusion 'success'
 */
export function verifyConstituentChecks(
  checks: CheckRunRecord[],
  prNumber: number,
  sha: string,
  requiredAppId: string = DEFAULT_REQUIRED_APP_ID,
  requiredContext: string = REQUIRED_CHECK_NAME
): { passed: boolean; blockerReason?: string } {
  const candidateReviews = checks.filter((c) => {
    const nameMatch = c.name === requiredContext;
    const appIdMatch = c.app?.id !== undefined && c.app?.id !== null && String(c.app.id) === requiredAppId;
    const extId = typeof c.external_id === 'string' ? c.external_id : '';
    const externalIdMatch = /^run_[a-f0-9]{32}:a[1-9][0-9]*$/.test(extId);
    return nameMatch && appIdMatch && externalIdMatch;
  });

  if (candidateReviews.length === 0) {
    return {
      passed: false,
      blockerReason: `PR #${prNumber} at ${sha} has no newest successful exact-head ${requiredContext} check from app ${requiredAppId}`,
    };
  }

  for (const r of candidateReviews) {
    if (typeof r.started_at !== 'string' || !r.started_at.trim() || typeof r.id !== 'number') {
      return {
        passed: false,
        blockerReason: `PR #${prNumber} at ${sha} contains exact-app check run lacking valid started_at or numeric id`,
      };
    }
  }

  // Sort by started_at (ISO-8601), tie-break with check-run id
  candidateReviews.sort((a, b) => {
    if (a.started_at !== b.started_at) {
      return (a.started_at || '').localeCompare(b.started_at || '');
    }
    return a.id - b.id;
  });

  const newest = candidateReviews[candidateReviews.length - 1];
  if (newest.status !== 'completed' || newest.conclusion !== 'success') {
    return {
      passed: false,
      blockerReason: `PR #${prNumber} at ${sha} has no newest successful exact-head ${requiredContext} check from app ${requiredAppId} (latest status=${newest.status}, conclusion=${newest.conclusion})`,
    };
  }

  return { passed: true };
}

/**
 * Fetches all changed files for a pull request with pagination support.
 */
export async function fetchAllChangedFilesForPr(params: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  fetchFn?: typeof fetch;
}): Promise<Array<{ filename: string; patch?: string; status?: string }>> {
  const { owner, repo, prNumber, token, fetchFn = fetch } = params;
  const allFiles: Array<{ filename: string; patch?: string; status?: string }> = [];
  let page = 1;
  const maxPages = 10;

  while (page <= maxPages) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const res = await fetchFn(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ReviewYeti-Edge-Orchestrator',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitHub files API error (${res.status}): ${errText}`);
    }

    const files = (await res.json()) as Array<{ filename: string; patch?: string; status?: string }>;
    if (!Array.isArray(files) || files.length === 0) break;

    allFiles.push(...files);
    if (files.length < 100) break;
    page++;
  }

  return allFiles;
}

/**
 * Fetches changed files between the PR's original base SHA and the queue's base SHA (main drift).
 */
export async function fetchBaseDriftFiles(params: {
  owner: string;
  repo: string;
  baseSha: string;
  queueBaseSha: string;
  token: string;
  fetchFn?: typeof fetch;
}): Promise<Array<{ filename: string; patch?: string; status?: string }>> {
  const { owner, repo, baseSha, queueBaseSha, token, fetchFn = fetch } = params;
  if (!baseSha || !queueBaseSha || baseSha === queueBaseSha) {
    return [];
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/compare/${baseSha}...${queueBaseSha}`;
  const res = await fetchFn(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'ReviewYeti-Edge-Orchestrator',
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub compare API error (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as any;
  const files = data?.files;
  return Array.isArray(files) ? files : [];
}

export const STANDARD_LIBRARY_MODULE_PREFIXES = [
  'Map.', 'Enum.', 'Repo.', 'String.', 'Kernel.', 'System.', 'Process.', 'Task.', 'Agent.',
  'File.', 'Path.', 'IO.', 'Logger.', 'DateTime.', 'Date.', 'Time.', 'NaiveDateTime.', 'URI.',
  'Registry.', 'Supervisor.', 'DynamicSupervisor.', 'Application.', 'Config.', 'Keyword.',
  'List.', 'Integer.', 'Float.', 'Stream.', 'Access.', 'Regex.', 'Tuple.', 'Atom.', 'Base.',
  'Code.', 'Port.', 'OptionParser.', 'Math.', 'JSON.', 'Object.', 'Array.', 'Promise.',
  'console.',
];

export const COMMON_UBIQUITOUS_SYMBOLS = new Set([
  // Elixir OTP & GenServer callbacks
  'init', 'start_link', 'start', 'stop', 'terminate', 'child_spec',
  'handle_call', 'handle_cast', 'handle_info', 'handle_continue', 'code_change', 'format_status',
  // Phoenix / LiveView callbacks
  'mount', 'render', 'handle_event', 'handle_params', 'handle_async',
  // Ecto schema / changeset callbacks
  'changeset', 'change', 'schema',
  // Standard CRUD / REST controller action names
  'index', 'show', 'new', 'edit', 'create', 'update', 'delete',
  // Common execution / utility methods
  'run', 'call', 'apply', 'get', 'set', 'all', 'list', 'find', 'select', 'count', 'insert',
  'execute', 'process', 'parse', 'dump', 'load', 'format', 'transform',
  // Ubiquitous domain fields / terms
  'id', 'name', 'type', 'status', 'data', 'params', 'error', 'ok', 'value', 'default',
  // Lifecycle & test hooks
  'test', 'setup', 'setup_all', 'teardown',
  // JS/TS standard object / collection methods
  'constructor', 'then', 'catch', 'finally', 'next', 'done', 'valueOf', 'toString',
  'forEach', 'map', 'filter', 'reduce', 'has', 'clear', 'add',
]);

const DEF_PATTERN = /(?:(?:^|\s)(?:def|defdelegate|defmacro|defguard)\s+([a-zA-Z0-9_!?]+)|(?:export\s+(?:default\s+)?(?:async\s+)?function|function|export\s+(?:const|let|var))\s+([a-zA-Z0-9_$]+))/;

function extractDefinitions(patch: string, prefix: '+' | '-'): Map<string, string> {
  const defs = new Map<string, string>();
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith(prefix) && !line.startsWith(prefix === '+' ? '+++' : '---')) {
      const trimmed = line.slice(1).trim();
      const match = trimmed.match(DEF_PATTERN);
      if (match) {
        const sym = match[1] || match[2];
        if (sym && !COMMON_UBIQUITOUS_SYMBOLS.has(sym) && !defs.has(sym)) {
          defs.set(sym, trimmed);
        }
      }
    }
  }
  return defs;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSignature(sig: string): string {
  return sig.replace(/\s+/g, ' ').trim();
}

export function sanitizeCodeLine(line: string): string {
  // Strip string literals first so hashes/slashes inside strings are not treated as comments
  const withoutStrings = line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``');
  // Strip inline comments
  return withoutStrings.replace(/(?:#|\/\/).*$/, '').trim();
}

export function isNonCallerLine(line: string): boolean {
  const trimmed = line.trim();
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('--') ||
    trimmed.startsWith(';')
  ) {
    return true;
  }
  if (
    trimmed.startsWith('def ') ||
    trimmed.startsWith('defp ') ||
    trimmed.startsWith('defdelegate ') ||
    trimmed.startsWith('defmacro ') ||
    trimmed.startsWith('defguard ') ||
    trimmed.startsWith('defguardp ') ||
    trimmed.startsWith('function ') ||
    trimmed.startsWith('async function ') ||
    trimmed.startsWith('async def ') ||
    trimmed.startsWith('export ') ||
    trimmed.startsWith('class ') ||
    trimmed.startsWith('interface ') ||
    trimmed.startsWith('type ')
  ) {
    return true;
  }
  if (
    trimmed.startsWith('@spec ') ||
    trimmed.startsWith('@type ') ||
    trimmed.startsWith('@typedoc ') ||
    trimmed.startsWith('@callback ') ||
    trimmed.startsWith('@macrocallback ') ||
    trimmed.startsWith('@doc ') ||
    trimmed.startsWith('@moduledoc ') ||
    trimmed.startsWith('@behaviour ') ||
    trimmed.startsWith('@impl ') ||
    trimmed.startsWith('@opaque ')
  ) {
    return true;
  }
  if (
    trimmed.startsWith('alias ') ||
    trimmed.startsWith('import ') ||
    trimmed.startsWith('require ') ||
    trimmed.startsWith('use ')
  ) {
    return true;
  }
  if (trimmed.startsWith('test ') || trimmed.startsWith('describe ')) {
    return true;
  }
  return false;
}

export function createSymbolMatcher(symbol: string): (line: string) => boolean {
  const escaped = escapeRegex(symbol);
  const pipePattern = new RegExp(`\\|>\\s*(?:[a-zA-Z0-9_]+\\.)*${escaped}(?![a-zA-Z0-9_!?:])`);
  const capturePattern = new RegExp(`&\\s*(?:[a-zA-Z0-9_]+\\.)*${escaped}\\/\\d+`);
  const pattern = new RegExp(
    `(?<![:a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_!?:]|\\s*->|\\s*do\\b)(?:\\s*\\(|\\s+[^=,\\s])`
  );
  const prefixesWithSymbol = STANDARD_LIBRARY_MODULE_PREFIXES.map((prefix) => `${prefix}${symbol}`);

  return (line: string): boolean => {
    if (isNonCallerLine(line)) return false;

    const sanitized = sanitizeCodeLine(line);
    if (!sanitized) return false;

    for (const prefixWithSym of prefixesWithSymbol) {
      if (sanitized.includes(prefixWithSym)) {
        return false;
      }
    }

    if (pipePattern.test(sanitized)) return true;
    if (capturePattern.test(sanitized)) return true;
    return pattern.test(sanitized);
  };
}

export function lineCallsSymbol(line: string, symbol: string): boolean {
  return createSymbolMatcher(symbol)(line);
}

/**
 * Evaluates composite delta integration hazards for batched PRs or PRs with base drift:
 * 1. Conflicting Ecto migration timestamps across batched PRs and against base drift.
 * 2. Shared runtime/config file collisions (such as `mcp-servers.json` or `mix.lock`).
 * 3. Incompatible caller/callee contract changes (with word/invocation boundary matching and modification checks).
 */
export async function evaluateCompositeDeltaHazards(params: {
  owner: string;
  repo: string;
  constituentPrs: MergeQueueEntry[];
  queueBaseSha?: string;
  token: string;
  fetchFn?: typeof fetch;
  mockPrFiles?: Map<number, Array<{ filename: string; patch?: string; status?: string }>>;
  mockBaseDriftFiles?: Array<{ filename: string; patch?: string; status?: string }>;
}): Promise<HazardScanResult> {
  const { owner, repo, constituentPrs, queueBaseSha, token, fetchFn = fetch, mockPrFiles, mockBaseDriftFiles } = params;

  // Evaluate base drift across all constituent PRs
  const driftedPrs = constituentPrs.filter(
    (pr) => Boolean(queueBaseSha && pr.base_sha && queueBaseSha !== pr.base_sha)
  );
  const hasBaseDrift = driftedPrs.length > 0;
  const isSinglePr = constituentPrs.length === 1;

  // R3 Acceptance Criteria: Clean single-PR queue entries with no base drift bypass scan.
  if (isSinglePr && !hasBaseDrift) {
    return {
      passed: true,
      bypassed: true,
      hazards: [],
    };
  }

  const hazards: HazardFinding[] = [];
  const filesByPr = new Map<number, Array<{ filename: string; patch?: string; status?: string }>>();

  try {
    // Fetch changed files for all constituent PRs concurrently
    await Promise.all(
      constituentPrs.map(async (pr) => {
        if (mockPrFiles && mockPrFiles.has(pr.number)) {
          filesByPr.set(pr.number, mockPrFiles.get(pr.number)!);
        } else {
          const files = await fetchAllChangedFilesForPr({
            owner,
            repo,
            prNumber: pr.number,
            token,
            fetchFn,
          });
          filesByPr.set(pr.number, files);
        }
      })
    );

    // Fetch or mock base drift files (represented by PR 0 / main drift)
    if (hasBaseDrift || (mockPrFiles && mockPrFiles.has(0)) || mockBaseDriftFiles) {
      const driftFilesMap = new Map<string, { filename: string; patch?: string; status?: string }>();

      if (mockBaseDriftFiles) {
        for (const f of mockBaseDriftFiles) {
          driftFilesMap.set(f.filename, f);
        }
      } else if (mockPrFiles && mockPrFiles.has(0)) {
        for (const f of mockPrFiles.get(0)!) {
          driftFilesMap.set(f.filename, f);
        }
      } else if (queueBaseSha) {
        const seenBaseShas = new Set<string>();
        for (const pr of driftedPrs) {
          if (pr.base_sha && !seenBaseShas.has(pr.base_sha)) {
            seenBaseShas.add(pr.base_sha);
            const files = await fetchBaseDriftFiles({
              owner,
              repo,
              baseSha: pr.base_sha,
              queueBaseSha,
              token,
              fetchFn,
            });
            for (const f of files) {
              driftFilesMap.set(f.filename, f);
            }
          }
        }
      }

      if (driftFilesMap.size > 0) {
        filesByPr.set(0, Array.from(driftFilesMap.values()));
      }
    }
  } catch (err: any) {
    return {
      passed: false,
      bypassed: false,
      hazards: [],
      diagnosticSummary: `Failed to evaluate composite delta hazards: ${err?.message || String(err)}`,
    };
  }

  const baseLabel = queueBaseSha ? `main (${queueBaseSha.slice(0, 7)}) base drift` : 'main base drift';

  // 1. Check for conflicting Ecto migration timestamps
  const migrationTimestamps = new Map<string, { prNumber: number; file: string }>();
  for (const [prNum, files] of filesByPr.entries()) {
    for (const f of files) {
      if (f.status === 'removed') continue;
      const match = f.filename.match(ECTO_MIGRATION_PATTERN);
      if (match) {
        const timestamp = match[1];
        if (migrationTimestamps.has(timestamp)) {
          const prev = migrationTimestamps.get(timestamp)!;
          const originLabel = prev.prNumber === 0 ? baseLabel : `PR #${prev.prNumber} (${prev.file})`;
          const currentLabel = prNum === 0 ? baseLabel : `PR #${prNum} (${f.filename})`;
          hazards.push({
            type: 'migration_collision',
            file: f.filename,
            prNumber: prNum === 0 ? prev.prNumber : prNum,
            conflictingPrNumber: prNum === 0 ? 0 : prev.prNumber,
            description: `Conflicting Ecto migration timestamp "${timestamp}" between ${currentLabel} and ${originLabel}`,
          });
        } else {
          migrationTimestamps.set(timestamp, { prNumber: prNum, file: f.filename });
        }
      }
    }
  }

  // 2. Check for shared runtime/config file collisions
  const touchedSharedFiles = new Map<string, number[]>();
  for (const [prNum, files] of filesByPr.entries()) {
    for (const f of files) {
      const isSharedConfig = SHARED_RUNTIME_CONFIG_PATTERNS.some((pat) => pat.test(f.filename));
      if (isSharedConfig) {
        if (!touchedSharedFiles.has(f.filename)) {
          touchedSharedFiles.set(f.filename, []);
        }
        if (!touchedSharedFiles.get(f.filename)!.includes(prNum)) {
          touchedSharedFiles.get(f.filename)!.push(prNum);
        }
      }
    }
  }

  for (const [file, prNumbers] of touchedSharedFiles.entries()) {
    if (prNumbers.length > 1) {
      const containsDrift = prNumbers.includes(0);
      const prs = prNumbers.filter((n) => n !== 0);
      const targetPr = prs[prs.length - 1] || 0;
      const conflictingPr = containsDrift ? 0 : prs[0];
      const desc = containsDrift
        ? `Shared runtime/config file collision on "${file}" between PR #${targetPr} and ${baseLabel}`
        : `Shared runtime/config file collision on "${file}" between multiple batched PRs: [#${prs.join(', #')}]`;

      hazards.push({
        type: 'shared_config_collision',
        file,
        prNumber: targetPr,
        conflictingPrNumber: conflictingPr,
        description: desc,
      });
    }
  }

  // 3. Check for incompatible caller/callee contract changes
  const deletedOrModifiedSymbols = new Map<string, { prNumber: number; file: string }>();
  for (const [prNum, files] of filesByPr.entries()) {
    for (const f of files) {
      if (
        f.patch &&
        (f.filename.endsWith('.ex') ||
          f.filename.endsWith('.exs') ||
          f.filename.endsWith('.ts') ||
          f.filename.endsWith('.js'))
      ) {
        const removedDefs = extractDefinitions(f.patch, '-');
        const addedDefs = extractDefinitions(f.patch, '+');

        for (const [sym, removedSig] of removedDefs.entries()) {
          const addedSig = addedDefs.get(sym);
          // If symbol was removed completely, or signature/definition modified
          if (!addedSig || normalizeSignature(removedSig) !== normalizeSignature(addedSig)) {
            deletedOrModifiedSymbols.set(sym, { prNumber: prNum, file: f.filename });
          }
        }
      }
    }
  }

  if (deletedOrModifiedSymbols.size > 0) {
    // Precompile matchers and a single combined union regex for fast O(1) line rejection
    const symbolMatchers = new Map<string, (line: string) => boolean>();
    const escapedSymbols: string[] = [];
    for (const sym of deletedOrModifiedSymbols.keys()) {
      symbolMatchers.set(sym, createSymbolMatcher(sym));
      escapedSymbols.push(escapeRegex(sym));
    }
    const fastUnionRegex = new RegExp(`(?:${escapedSymbols.join('|')})`);

    for (const [prNum, files] of filesByPr.entries()) {
      for (const f of files) {
        if (!f.patch) continue;
        const addedLines = f.patch
          .split('\n')
          .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
          .map((l) => l.slice(1))
          .filter((l) => !isNonCallerLine(l));

        if (addedLines.length === 0) continue;

        const reportedSymbolsInFile = new Set<string>();

        for (const line of addedLines) {
          // Fast path: if the line doesn't match any modified symbol, skip immediately
          if (!fastUnionRegex.test(line)) continue;

          for (const [symbol, origin] of deletedOrModifiedSymbols.entries()) {
            if (origin.prNumber !== prNum && !reportedSymbolsInFile.has(symbol) && line.includes(symbol)) {
              const matcher = symbolMatchers.get(symbol)!;
              if (matcher(line)) {
                reportedSymbolsInFile.add(symbol);
                const originLabel = origin.prNumber === 0 ? baseLabel : `PR #${origin.prNumber} (${origin.file})`;
                const currentLabel = prNum === 0 ? baseLabel : `PR #${prNum} (${f.filename})`;
                hazards.push({
                  type: 'contract_break',
                  file: f.filename,
                  prNumber: prNum === 0 ? origin.prNumber : prNum,
                  conflictingPrNumber: prNum === 0 ? 0 : origin.prNumber,
                  description: `Incompatible contract change: ${currentLabel} invokes symbol "${symbol}" modified/deleted in ${originLabel}`,
                });
              }
            }
          }
        }
      }
    }
  }

  const passed = hazards.length === 0;
  const diagnosticSummary = passed
    ? 'No integration hazards or contract collisions detected.'
    : hazards.map((h) => `- [${h.type.toUpperCase()}] ${h.description}`).join('\n');

  return {
    passed,
    bypassed: false,
    hazards,
    diagnosticSummary,
  };
}

/**
 * Publishes the Review Yeti check run directly on the merge group commit.
 */
export async function publishMergeGroupCheckRun(params: {
  owner: string;
  repo: string;
  headSha: string;
  token: string;
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
  fetchFn?: typeof fetch;
}): Promise<{ success: boolean; checkRunId?: number; error?: string }> {
  const { owner, repo, headSha, token, conclusion, title, summary, fetchFn = fetch } = params;
  const endpoint = `https://api.github.com/repos/${owner}/${repo}/check-runs`;

  const payload = {
    name: REQUIRED_CHECK_NAME,
    head_sha: headSha,
    external_id: `merge-group:${headSha}`,
    status: 'completed',
    conclusion,
    output: {
      title,
      summary,
    },
  };

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ReviewYeti-Edge-Orchestrator',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        success: false,
        error: `GitHub check-runs publication failed (${res.status}): ${errText}`,
      };
    }

    const data = (await res.json()) as any;
    return {
      success: true,
      checkRunId: data?.id,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `GitHub check-runs publication error: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Helper to construct and publish a blocked failure check-run and outcome, ensuring
 * uniform check-run titles, blocker reasons, and failure telemetry across all failure paths.
 */
async function createBlockedOutcome(params: {
  owner: string;
  repo: string;
  headSha: string;
  token?: string;
  summary: string;
  constituentPrs?: number[];
  bypassedHazardScan?: boolean;
  hazards?: HazardFinding[];
  fetchFn?: typeof fetch;
  skipPublish?: boolean;
  checkRunError?: string;
}): Promise<AttestationOutcome> {
  const {
    owner,
    repo,
    headSha,
    token,
    summary,
    constituentPrs = [],
    bypassedHazardScan = false,
    hazards,
    fetchFn = fetch,
    skipPublish = false,
  } = params;

  let checkRunId: number | undefined;
  let checkRunError: string | undefined = params.checkRunError;

  if (!skipPublish && token) {
    const pubRes = await publishMergeGroupCheckRun({
      owner,
      repo,
      headSha,
      token,
      conclusion: 'failure',
      title: ATTESTATION_CHECK_TITLE,
      summary,
      fetchFn,
    });
    checkRunId = pubRes.checkRunId;
    checkRunError = pubRes.error;
  }

  return {
    status: 'blocked',
    headSha,
    conclusion: 'failure',
    title: ATTESTATION_CHECK_TITLE,
    summary,
    constituentPrs,
    bypassedHazardScan,
    hazards,
    checkRunId,
    checkRunError,
  };
}

/**
 * Master handler for `merge_group` webhook events in Review Yeti.
 * Executes constituent verification, composite delta hazard scanning, and direct check-run publication.
 */
export async function handleMergeGroupAttestation(
  payload: MergeGroupPayload,
  env: Env,
  fetchFn: typeof fetch = fetch,
  mockPrFiles?: Map<number, Array<{ filename: string; patch?: string; status?: string }>>,
  mockBaseDriftFiles?: Array<{ filename: string; patch?: string; status?: string }>
): Promise<AttestationOutcome> {
  const mergeGroup = payload.merge_group;
  const repository = payload.repository;

  if (!mergeGroup || !repository) {
    throw new Error('Bad Request: Missing merge_group or repository in payload');
  }

  const headSha = mergeGroup.head_sha?.trim();
  const headRef = mergeGroup.head_ref?.trim();
  const baseRef = mergeGroup.base_ref?.trim();
  const baseSha = mergeGroup.base_sha?.trim();

  if (!headSha || !headRef || !baseRef) {
    throw new Error('Bad Request: merge_group payload omitted required head_sha, head_ref, or base_ref');
  }

  const repoFullName = repository.full_name?.trim() || '';
  const repoParts = repoFullName.split('/');
  const owner = repository.owner?.login || repoParts[0] || '';
  const repo = repository.name || repoParts[1] || '';

  if (!owner || !repo) {
    throw new Error('Bad Request: Missing or invalid repository owner/name in payload');
  }

  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('Configuration error: GITHUB_TOKEN is not set');
  }
  const requiredAppId = env.GITHUB_APP_ID || DEFAULT_REQUIRED_APP_ID;

  const baseBranch = normalizeBaseBranch(baseRef);
  const currentPrNumber = extractPrNumberFromHeadRef(headRef);

  if (!baseBranch || !currentPrNumber) {
    return await createBlockedOutcome({
      owner,
      repo,
      headSha,
      token,
      summary: `Merge group attestation blocked: Failed to parse base_ref ("${baseRef}") or PR number from head_ref ("${headRef}")`,
      fetchFn,
    });
  }

  // 1. Resolve constituent PRs through merge queue GraphQL API
  const queueResult = await getConstituentPullRequests({
    owner,
    repo,
    baseBranch,
    currentPrNumber,
    token,
    fetchFn,
  });

  if (!queueResult.passed) {
    return await createBlockedOutcome({
      owner,
      repo,
      headSha,
      token,
      summary: `Merge group attestation blocked: ${queueResult.blockerReason}`,
      constituentPrs: queueResult.prs.map((p) => p.number),
      fetchFn,
    });
  }

  const constituentPrs = queueResult.prs;

  // 2. Verify all constituent PRs possess exact-head Review Yeti checks concurrently
  const checkResults = await Promise.all(
    constituentPrs.map(async (pr) => {
      try {
        const checks = await fetchAllCheckRunsForCommit({
          owner,
          repo,
          commitSha: pr.head_sha,
          token,
          fetchFn,
        });
        const verification = verifyConstituentChecks(checks, pr.number, pr.head_sha, requiredAppId);
        return { pr, verification, error: null };
      } catch (err: any) {
        return {
          pr,
          verification: {
            passed: false,
            blockerReason: `Failed to fetch check-runs for PR #${pr.number} at ${pr.head_sha}: ${err?.message || String(err)}`,
          },
          error: err,
        };
      }
    })
  );

  for (const res of checkResults) {
    if (!res.verification.passed) {
      return await createBlockedOutcome({
        owner,
        repo,
        headSha,
        token,
        summary: `Merge group attestation blocked: ${res.verification.blockerReason}`,
        constituentPrs: constituentPrs.map((p) => p.number),
        fetchFn,
      });
    }
  }

  // 3. Speculative composite delta hazard scan
  const hazardResult = await evaluateCompositeDeltaHazards({
    owner,
    repo,
    constituentPrs,
    queueBaseSha: baseSha,
    token,
    fetchFn,
    mockPrFiles,
    mockBaseDriftFiles,
  });

  if (!hazardResult.passed) {
    return await createBlockedOutcome({
      owner,
      repo,
      headSha,
      token,
      summary: `Merge group attestation blocked due to speculative composite delta hazards:\n\n${hazardResult.diagnosticSummary}`,
      constituentPrs: constituentPrs.map((p) => p.number),
      hazards: hazardResult.hazards,
      fetchFn,
    });
  }

  // 4. Attestation Success: Publish successful check run directly to GitHub API
  const attestedNumbers = constituentPrs.map((p) => `#${p.number}`).join(', ');
  const hazardNote = hazardResult.bypassed
    ? 'Clean single-PR queue entry with no base drift bypassed composite hazard scan.'
    : 'Speculative composite delta hazard scan verified zero schema or contract collisions.';

  const summary = `Attested constituent pull request(s) [${attestedNumbers}] possess valid Review Yeti checks from App ID ${requiredAppId}. ${hazardNote}`;

  const pubResult = await publishMergeGroupCheckRun({
    owner,
    repo,
    headSha,
    token,
    conclusion: 'success',
    title: ATTESTATION_CHECK_TITLE,
    summary,
    fetchFn,
  });

  if (!pubResult.success) {
    return await createBlockedOutcome({
      owner,
      repo,
      headSha,
      summary: `Merge group attestation failed to publish check-run: ${pubResult.error}`,
      constituentPrs: constituentPrs.map((p) => p.number),
      bypassedHazardScan: hazardResult.bypassed,
      skipPublish: true,
      checkRunError: pubResult.error,
    });
  }

  return {
    status: 'attested',
    headSha,
    conclusion: 'success',
    title: ATTESTATION_CHECK_TITLE,
    summary,
    constituentPrs: constituentPrs.map((p) => p.number),
    bypassedHazardScan: hazardResult.bypassed,
    checkRunId: pubResult.checkRunId,
  };
}
