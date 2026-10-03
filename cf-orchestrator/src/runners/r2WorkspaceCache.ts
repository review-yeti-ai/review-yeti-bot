/**
 * r2WorkspaceCache.ts
 *
 * TypeScript helper and programmatic interface for Cloudflare R2 Workspace Caching
 * and Zoekt symbol index hydration/staging (Milestone 3 / R3, Features 25 & 26).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export interface R2WorkspaceCacheConfig {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha?: string;
  workspaceDir?: string;
  r2Endpoint?: string;
  r2CacheBucket?: string;
  githubToken?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsDefaultRegion?: string;
  dryRun?: boolean;
}

export interface R2CacheRestoreResult {
  success: boolean;
  cacheHit: boolean;
  headSha: string;
  workspaceDir: string;
  durationMs: number;
  unpackDurationMs?: number;
  zoektIndexed: boolean;
  output: string;
  error?: string;
}

export interface R2CacheStageResult {
  success: boolean;
  skipped: boolean;
  cacheKey: string;
  archiveSizeBytes?: number;
  durationMs: number;
  output: string;
  error?: string;
}

export interface UnpackBenchmarkResult {
  durationMs: number;
  isSub1500Ms: boolean;
  archiveSizeBytes: number;
  throughputMBs: number;
}

/**
 * Resolves script path across development and build environments.
 */
export function resolveScriptPath(scriptName: string): string {
  let moduleDir = '';
  try {
    moduleDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    moduleDir = '';
  }

  const candidates = [
    path.resolve(process.cwd(), 'scripts', scriptName),
    path.resolve(process.cwd(), 'packages', 'cf-orchestrator', 'scripts', scriptName),
    ...(moduleDir ? [
      path.resolve(moduleDir, '..', '..', 'scripts', scriptName),
      path.resolve(moduleDir, '..', 'scripts', scriptName),
    ] : []),
  ];

  for (const c of candidates) {
    if (fsSync.existsSync(c)) {
      return c;
    }
  }
  return candidates[0];
}

/**
 * Builds the canonical R2 cache object key: ${owner}/${repo}/pr-${prNumber}.tar.zst
 */
export function buildCanonicalCacheKey(owner: string, repo: string, prNumber: number): string {
  if (!owner || typeof owner !== 'string' || owner.trim() === '') {
    throw new Error('Cache key requires a non-empty owner');
  }
  if (!repo || typeof repo !== 'string' || repo.trim() === '') {
    throw new Error('Cache key requires a non-empty repo');
  }
  if (!prNumber || typeof prNumber !== 'number' || prNumber <= 0 || !Number.isInteger(prNumber)) {
    throw new Error('Cache key requires a positive integer prNumber');
  }
  return `${owner.trim()}/${repo.trim()}/pr-${prNumber}.tar.zst`;
}

/**
 * Alias for buildCanonicalCacheKey
 */
export const buildR2CacheKey = buildCanonicalCacheKey;

/**
 * Parses an R2 cache object key into its component owner, repo, and prNumber.
 */
export function parseR2CacheKey(cacheKey: string): { owner: string; repo: string; prNumber: number } | null {
  if (!cacheKey || typeof cacheKey !== 'string') return null;
  const match = cacheKey.match(/^([^/]+)\/([^/]+)\/pr-(\d+)\.tar\.zst$/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    prNumber: parseInt(match[3], 10),
  };
}

/**
 * Validates that all required fields for cache configuration are present.
 */
export function validateR2CacheConfig(config: Partial<R2WorkspaceCacheConfig>): {
  valid: boolean;
  missing: string[];
  errors: string[];
} {
  const missing: string[] = [];
  const errors: string[] = [];

  if (!config.owner || config.owner.trim() === '') missing.push('OWNER');
  if (!config.repo || config.repo.trim() === '') missing.push('REPO');
  if (config.prNumber === undefined || config.prNumber === null || config.prNumber <= 0) {
    missing.push('PR_NUMBER');
  }
  if (!config.headSha || config.headSha.trim() === '') missing.push('HEAD_SHA');

  if (config.headSha && !/^[0-9a-fA-F]{7,40}$/.test(config.headSha.trim())) {
    errors.push(`HEAD_SHA '${config.headSha}' is not a valid commit SHA format`);
  }

  return {
    valid: missing.length === 0 && errors.length === 0,
    missing,
    errors,
  };
}

/**
 * Generates the complete environment dictionary required by the shell scripts
 * and worker container execution plane.
 */
export function buildR2CacheEnv(config: R2WorkspaceCacheConfig): Record<string, string> {
  const env: Record<string, string> = {
    OWNER: config.owner,
    REPO: config.repo,
    PR_NUMBER: String(config.prNumber),
    HEAD_SHA: config.headSha,
    WORKSPACE_DIR: config.workspaceDir || '/workspace',
    R2_ENDPOINT: config.r2Endpoint || '',
    R2_CACHE_BUCKET: config.r2CacheBucket || 'review-yeti-workspace-cache',
    AWS_DEFAULT_REGION: config.awsDefaultRegion || 'auto',
    DRY_RUN: config.dryRun ? '1' : '0',
  };

  if (config.baseSha) env.BASE_SHA = config.baseSha;
  if (config.githubToken) env.GITHUB_TOKEN = config.githubToken;
  if (config.r2AccessKeyId) env.R2_ACCESS_KEY_ID = config.r2AccessKeyId;
  if (config.r2SecretAccessKey) env.R2_SECRET_ACCESS_KEY = config.r2SecretAccessKey;
  if (config.awsAccessKeyId) env.AWS_ACCESS_KEY_ID = config.awsAccessKeyId;
  else if (config.r2AccessKeyId) env.AWS_ACCESS_KEY_ID = config.r2AccessKeyId;
  if (config.awsSecretAccessKey) env.AWS_SECRET_ACCESS_KEY = config.awsSecretAccessKey;
  else if (config.r2SecretAccessKey) env.AWS_SECRET_ACCESS_KEY = config.r2SecretAccessKey;

  return env;
}

/**
 * Redacts secrets, tokens, and authorization credentials from logs, outputs, and errors.
 */
export function redactTokens(
  raw: string | undefined | null,
  extraTokens: (string | undefined | null)[] = []
): string {
  if (!raw || typeof raw !== 'string') return '';
  let sanitized = raw
    // Redact embedded HTTP Basic credentials in URLs: https://user:pass@host or https://x-access-token:token@host
    .replace(/https?:\/\/[^@/\s]+:[^@/\s]+@/gi, (match) => {
      if (match.toLowerCase().includes('x-access-token:')) {
        return 'https://x-access-token:[REDACTED]@';
      }
      return 'https://[REDACTED]@';
    })
    // Redact standalone x-access-token credentials
    .replace(/x-access-token:[^\s@,;]+/gi, 'x-access-token:[REDACTED]')
    // Redact GitHub Personal Access Tokens and OAuth tokens
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, '[REDACTED_GH_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[REDACTED_GH_TOKEN]')
    // Redact Authorization headers and high-entropy Bearer/Basic credentials
    .replace(/((?:Authorization:\s*)?(?:Bearer|Basic)\s+)[A-Za-z0-9_\-\.\=\+\/]{12,}/gi, '$1[REDACTED]')
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)\S+/gi, '$1[REDACTED]');

  // Redact specific known tokens if passed
  for (const token of extraTokens) {
    if (token && typeof token === 'string' && token.trim().length >= 8) {
      sanitized = sanitized.split(token.trim()).join('[REDACTED_SECRET]');
    }
  }

  return sanitized;
}

/**
 * Filter utility enforcing that staging archives ONLY include .git and .zoekt.
 * Strictly excludes node_modules, dist, and source code.
 *
 * Normalizes input paths to prevent directory traversal exploits (e.g. '.git/../.env')
 * and handles cross-platform path separator inconsistencies (Windows '\' vs POSIX '/').
 */
export function isAllowedCacheTarget(target: string): boolean {
  if (!target || typeof target !== 'string' || target.trim() === '') {
    return false;
  }
  if (target.includes('\0')) {
    return false;
  }

  // 1. Unify backslashes to forward slashes for cross-platform POSIX normalization
  const unified = target.trim().replace(/\\/g, '/');

  // 2. Normalize path using POSIX semantics (resolves '.' and '..' segments)
  const normalized = path.posix.normalize(unified);

  // 3. Strip leading slashes ('/') and current directory references ('./')
  const stripped = normalized.replace(/^(\.\/|\/)+/, '');

  // 4. Reject paths that traverse upwards or resolve to root / empty
  if (
    stripped === '' ||
    stripped === '.' ||
    stripped === '..' ||
    stripped.startsWith('../') ||
    stripped.includes('/../')
  ) {
    return false;
  }

  // 5. Extract root segment and ensure it is strictly '.git' or '.zoekt'
  const rootSegment = stripped.split('/')[0];
  return rootSegment === '.git' || rootSegment === '.zoekt';
}

/**
 * Filters a list of files or directories strictly to allowed cache targets (.git and .zoekt).
 */
export function filterCacheTargets(candidates: string[]): string[] {
  return candidates.filter((item) => isAllowedCacheTarget(item));
}

/**
 * Alias for filterCacheTargets
 */
export const filterAllowedCacheTargets = filterCacheTargets;

/**
 * Benchmarks unpacking of a .tar.zst archive to verify sub-1.5s constraint.
 */
export async function benchmarkUnpackSpeed(
  archivePath: string,
  targetDir: string
): Promise<UnpackBenchmarkResult> {
  const stat = await fs.stat(archivePath);
  const archiveSizeBytes = stat.size;
  await fs.mkdir(targetDir, { recursive: true });

  const start = performance.now();
  // Safe streaming pipe without shell command string interpolation: zstd -dc -T0 | tar -xf - -C <targetDir>
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let zstdCode: number | null = null;
    let tarCode: number | null = null;

    const maybeFinish = () => {
      if (settled) return;
      if (zstdCode !== null && tarCode !== null) {
        settled = true;
        if (zstdCode === 0 && tarCode === 0) {
          resolve();
        } else {
          const err =
            zstdCode !== 0
              ? new Error(`zstd decompression failed with code ${zstdCode}`)
              : new Error(`tar extraction failed with code ${tarCode}`);
          reject(err);
        }
      }
    };

    const zstd = spawn('zstd', ['-dc', '-T0', archivePath]);
    const tar = spawn('tar', ['-xf', '-', '-C', targetDir]);

    zstd.stdout.pipe(tar.stdin);

    zstd.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    tar.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    zstd.on('close', (code) => {
      zstdCode = code ?? 0;
      maybeFinish();
    });

    tar.on('close', (code) => {
      tarCode = code ?? 0;
      maybeFinish();
    });
  });
  const durationMs = performance.now() - start;
  const isSub1500Ms = durationMs < 1500;
  const throughputMBs = archiveSizeBytes / (1024 * 1024) / (durationMs / 1000);

  return {
    durationMs,
    isSub1500Ms,
    archiveSizeBytes,
    throughputMBs,
  };
}

/**
 * Programmatic invocation wrapper for restore-r2-cache.sh
 */
export async function restoreWorkspaceCache(
  config: R2WorkspaceCacheConfig,
  options?: {
    scriptPath?: string;
    extraEnv?: Record<string, string>;
  }
): Promise<R2CacheRestoreResult> {
  const validation = validateR2CacheConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      cacheHit: false,
      headSha: config.headSha,
      workspaceDir: config.workspaceDir || '/workspace',
      durationMs: 0,
      zoektIndexed: false,
      output: '',
      error: `Config validation failed: missing [${validation.missing.join(', ')}]`,
    };
  }

  const scriptPath =
    options?.scriptPath || resolveScriptPath('restore-r2-cache.sh');
  const env = {
    ...process.env,
    ...buildR2CacheEnv(config),
    ...(options?.extraEnv || {}),
  };

  const knownSecrets = [config.githubToken, config.r2SecretAccessKey, config.r2AccessKeyId];
  const start = performance.now();
  try {
    const { stdout, stderr } = await execFileAsync('bash', [scriptPath], { env });
    const durationMs = performance.now() - start;
    const combinedOutput = redactTokens(`${stdout}\n${stderr}`, knownSecrets);

    const cacheHit = combinedOutput.includes('[r2-cache] Cache hit!');
    const zoektIndexed = combinedOutput.includes('Updating Zoekt symbol index');

    // Extract unpack duration if logged
    let unpackDurationMs: number | undefined;
    const unpackMatch = combinedOutput.match(/Unpack completed in (\d+)ms/);
    if (unpackMatch) {
      unpackDurationMs = parseInt(unpackMatch[1], 10);
    }

    return {
      success: true,
      cacheHit,
      headSha: config.headSha,
      workspaceDir: config.workspaceDir || '/workspace',
      durationMs,
      unpackDurationMs,
      zoektIndexed,
      output: combinedOutput,
    };
  } catch (err: any) {
    const durationMs = performance.now() - start;
    return {
      success: false,
      cacheHit: false,
      headSha: config.headSha,
      workspaceDir: config.workspaceDir || '/workspace',
      durationMs,
      zoektIndexed: false,
      output: redactTokens(err.stdout || '', knownSecrets),
      error: redactTokens(err.stderr || err.message || String(err), knownSecrets),
    };
  }
}

/**
 * Programmatic invocation wrapper for stage-r2-cache.sh
 */
export async function stageWorkspaceCache(
  config: R2WorkspaceCacheConfig,
  options?: {
    scriptPath?: string;
    extraEnv?: Record<string, string>;
  }
): Promise<R2CacheStageResult> {
  const cacheKey = buildCanonicalCacheKey(config.owner, config.repo, config.prNumber);
  const scriptPath =
    options?.scriptPath || resolveScriptPath('stage-r2-cache.sh');
  const env = {
    ...process.env,
    ...buildR2CacheEnv(config),
    ...(options?.extraEnv || {}),
  };

  const knownSecrets = [config.githubToken, config.r2SecretAccessKey, config.r2AccessKeyId];
  const start = performance.now();
  try {
    const { stdout, stderr } = await execFileAsync('bash', [scriptPath], { env });
    const durationMs = performance.now() - start;
    const combinedOutput = redactTokens(`${stdout}\n${stderr}`, knownSecrets);

    const skipped = combinedOutput.includes('skipping cache upload');
    let archiveSizeBytes: number | undefined;
    const sizeMatch = combinedOutput.match(/Archive size: (\d+) bytes/);
    if (sizeMatch) {
      archiveSizeBytes = parseInt(sizeMatch[1], 10);
    }

    return {
      success: true,
      skipped,
      cacheKey,
      archiveSizeBytes,
      durationMs,
      output: combinedOutput,
    };
  } catch (err: any) {
    const durationMs = performance.now() - start;
    return {
      success: false,
      skipped: false,
      cacheKey,
      durationMs,
      output: redactTokens(err.stdout || '', knownSecrets),
      error: redactTokens(err.stderr || err.message || String(err), knownSecrets),
    };
  }
}

/**
 * Evaluates whether an R2 cache object has exceeded its TTL (default: 3600 seconds / 1 hour).
 */
export function isCacheExpired(
  timestamp: Date | string | number | null | undefined,
  maxAgeSeconds: number = 3600,
  nowMs: number = Date.now()
): boolean {
  if (!timestamp) return false;
  let timeMs: number;
  if (timestamp instanceof Date) {
    timeMs = timestamp.getTime();
  } else if (typeof timestamp === 'number') {
    timeMs = timestamp < 1e11 ? timestamp * 1000 : timestamp;
  } else if (typeof timestamp === 'string') {
    if (/^\d+$/.test(timestamp.trim())) {
      const num = parseInt(timestamp.trim(), 10);
      timeMs = num < 1e11 ? num * 1000 : num;
    } else {
      timeMs = Date.parse(timestamp);
    }
  } else {
    return false;
  }

  if (Number.isNaN(timeMs) || timeMs <= 0) return false;
  const ageMs = nowMs - timeMs;
  return ageMs > (maxAgeSeconds * 1000);
}

export interface PurgeExpiredResult {
  scannedCount: number;
  deletedCount: number;
  deletedKeys: string[];
}

/**
 * Iterates through an R2 bucket and purges all workspace cache objects older than maxAgeSeconds (default 1 hour / 3600s).
 */
export async function purgeExpiredR2WorkspaceCaches(
  bucket: any,
  maxAgeSeconds: number = 3600,
  nowMs: number = Date.now()
): Promise<PurgeExpiredResult> {
  if (!bucket || typeof bucket.list !== 'function') {
    return { scannedCount: 0, deletedCount: 0, deletedKeys: [] };
  }

  let scannedCount = 0;
  let deletedCount = 0;
  const deletedKeys: string[] = [];
  const MAX_SWEEP_PAGES = 50; // Limit sweep to 50 pages (max 25,000 objects) per run
  const MAX_DELETED_KEYS_RETAINED = 1000; // Bound memory footprint of returned key list
  let pageCount = 0;
  let truncated = true;
  let cursor: string | undefined;
  let prevCursor: string | undefined;

  while (truncated && pageCount < MAX_SWEEP_PAGES) {
    pageCount++;
    const listResult: any = await bucket.list({ cursor, limit: 500 });
    const objects: any[] = listResult?.objects || [];
    scannedCount += objects.length;

    const toDelete: string[] = [];
    for (const obj of objects) {
      // Scope sweep strictly to canonical workspace cache archive keys (${owner}/${repo}/pr-${N}.tar.zst)
      if (!parseR2CacheKey(obj.key)) continue;

      const uploaded = obj.uploaded || obj.lastModified;
      if (!uploaded) continue; // Fail-safe: do not sweep objects lacking timestamp metadata
      if (isCacheExpired(uploaded, maxAgeSeconds, nowMs)) {
        toDelete.push(obj.key);
      }
    }

    if (toDelete.length > 0) {
      if (typeof bucket.delete === 'function') {
        try {
          await bucket.delete(toDelete);
          deletedCount += toDelete.length;
          if (deletedKeys.length < MAX_DELETED_KEYS_RETAINED) {
            deletedKeys.push(...toDelete.slice(0, MAX_DELETED_KEYS_RETAINED - deletedKeys.length));
          }
        } catch (batchErr) {
          console.error('Error deleting batch of expired cache keys from R2:', batchErr);
        }
      } else {
        throw new Error('R2 workspace cache bucket does not support deletion (bucket.delete is not a function)');
      }
    }

    truncated = Boolean(listResult?.truncated);
    prevCursor = cursor;
    cursor = truncated ? listResult?.cursor : undefined;
    if (truncated && (!cursor || cursor === prevCursor)) {
      break; // Infinite pagination loop guard
    }
  }

  return {
    scannedCount,
    deletedCount,
    deletedKeys,
  };
}

