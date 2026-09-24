import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChangedFiles, type ChangedFile } from '../review/changedFiles';

/**
 * REL-1080 (plan 2026-09-23, W3): a git-derived diff for pull requests GitHub
 * will not render. GitHub's diff media type returns HTTP 406 above roughly
 * 20,000 lines or 300 files, and its compare API lists at most 300 files. For
 * those pull requests both the worker and the trusted completion side compute
 * the SAME three-dot diff from the SAME pinned commits with this one module,
 * so the two sides cannot disagree about the file set or which lines were
 * added (REL-1056).
 *
 * Identity guarantees, identical to the GitHub-rendered paths:
 * - exact SHAs: only the merge base and the head commit are fetched, by object
 *   id. Git verifies every object against its id, so the diff is a pure function
 *   of those two commits. The caller brackets the read with pull request reads
 *   that must report the admitted base and head.
 * - closed hunks: every hunk must end exactly where its header says it does
 *   (`verifyGitDerivedDiff`). Output over the byte bound is rejected, never
 *   truncated.
 * - same file set: the parsed file count must equal GitHub's own
 *   `changed_files` counter for the pull request, and paths must be unique.
 *
 * Repository content is untrusted. The scratch repository is bare, so no
 * checkout happens and the candidate's `.gitattributes` is never read; external
 * diff drivers and textconv are disabled; system and global git configuration
 * are ignored; only HTTPS transport is allowed. The installation token travels
 * in an environment-supplied header, never in argv or the remote URL, and no
 * git output is ever placed in an error message.
 */

/** Same bound the trusted side applies to per-file compare evidence. */
export const GIT_DIFF_MAX_BYTES = 4_000_000;
/** Kill switch. The fallback is on unless this is set to a false-like value. */
export const GIT_DIFF_FALLBACK_ENV = 'REVIEW_YETI_GIT_DIFF_FALLBACK';

const SHA = /^[0-9a-f]{40}$/u;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/u;

export type GitDiffFailureReason =
  | 'disabled' | 'unavailable' | 'timeout' | 'bounds' | 'identity' | 'unclosed-hunk' | 'file-count' | 'unreadable';

/** A fixed, service-owned reason. Never carries git output, paths, or tokens. */
export class GitDiffSourceError extends Error {
  constructor(readonly reason: GitDiffFailureReason) {
    super(`Git diff source unavailable (${reason})`);
    this.name = 'GitDiffSourceError';
  }
}

export interface GitDiffRequest {
  owner: string;
  repo: string;
  /** Repository-scoped read token (installation token). */
  token: string;
  /** GitHub's merge base for the pull request's exact base and head (three-dot). */
  mergeBaseSha: string;
  headSha: string;
  signal?: AbortSignal;
}

/** Returns the raw unified diff (`git diff` format, the same shape as GitHub's diff media type). */
export type GitDiffSource = (request: GitDiffRequest) => Promise<string>;

export interface GitDiffSourceOptions {
  /** GitHub REST API base, used to derive the git remote host. Defaults to api.github.com. */
  apiBaseUrl?: string;
  /** Test seam: remote URL for a repository. Production derives it from `apiBaseUrl`. */
  remoteUrlFor?: (owner: string, repo: string) => string;
  /** Test seam: also allow the `file` transport (a local bare repository). Never set in production. */
  allowLocalRemote?: boolean;
  gitBinary?: string;
  /** Whole operation: fetch plus diff. */
  timeoutMs: number;
  /** Largest diff accepted. Larger output is rejected, never truncated. */
  maxOutputBytes?: number;
  /** Largest on-disk scratch repository. Protects a size-limited emptyDir from eviction. */
  maxScratchBytes: number;
  scratchRoot?: string;
  /** Poll interval of the scratch-size watchdog. */
  scratchPollMs?: number;
}

export function isGitDiffFallbackEnabled(env: Record<string, string | undefined>): boolean {
  const raw = String(env[GIT_DIFF_FALLBACK_ENV] ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

/** `https://api.github.com` -> `https://github.com`; GHES `https://host/api/v3` -> `https://host`. */
export function gitRemoteBaseFromApi(apiBaseUrl = 'https://api.github.com'): string {
  const url = new URL(apiBaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new GitDiffSourceError('unavailable');
  }
  if (url.hostname === 'api.github.com') return 'https://github.com';
  const path = url.pathname.replace(/\/+$/u, '').replace(/\/api\/v3$/u, '');
  return `${url.origin}${path}`;
}

/**
 * GitHub's merge base for the admitted base/head, read from the compare API
 * response pinned to both SHAs. The compare response must name the exact base.
 */
export function mergeBaseFromComparison(input: unknown, baseSha: string): string {
  const value = input as { base_commit?: { sha?: unknown }; merge_base_commit?: { sha?: unknown } } | null;
  const base = value?.base_commit?.sha; const mergeBase = value?.merge_base_commit?.sha;
  if (base !== baseSha || typeof mergeBase !== 'string' || !SHA.test(mergeBase)) {
    throw new GitDiffSourceError('identity');
  }
  return mergeBase;
}

/** Every hunk in one file chunk ends exactly where its header says. Chunks without hunks
 * (binary, pure rename, mode-only) have no line evidence and are left to the caller's
 * existing no-hunk handling, exactly as for GitHub's own diff. */
export function hunksClosed(chunk: string): boolean {
  const lines = chunk.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldLeft = 0; let newLeft = 0; let inHunks = false; let mayMarkNoNewline = false;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) {
      if (oldLeft !== 0 || newLeft !== 0) return false;
      oldLeft = Number(header[2] ?? 1); newLeft = Number(header[4] ?? 1);
      if (!Number.isSafeInteger(oldLeft) || !Number.isSafeInteger(newLeft) || (oldLeft === 0 && newLeft === 0)) return false;
      inHunks = true; mayMarkNoNewline = false;
      continue;
    }
    if (!inHunks) continue;
    if (line === '\\ No newline at end of file') {
      if (!mayMarkNoNewline) return false;
      mayMarkNoNewline = false;
      continue;
    }
    if (line.startsWith('+')) newLeft--;
    else if (line.startsWith('-')) oldLeft--;
    else if (line.startsWith(' ')) { oldLeft--; newLeft--; }
    else return false;
    if (oldLeft < 0 || newLeft < 0) return false;
    mayMarkNoNewline = true;
  }
  return oldLeft === 0 && newLeft === 0;
}

/**
 * The single acceptance rule for a git-derived diff, applied by BOTH the worker
 * and the trusted completion side. Throws a fixed-reason error; returns the
 * parsed per-file evidence otherwise.
 */
export function verifyGitDerivedDiff(diff: string, options: { expectedFileCount: number | undefined;
  maxBytes?: number; }): ChangedFile[] {
  if (typeof diff !== 'string' || diff.length === 0) throw new GitDiffSourceError('file-count');
  if (Buffer.byteLength(diff, 'utf8') > (options.maxBytes ?? GIT_DIFF_MAX_BYTES)) throw new GitDiffSourceError('bounds');
  const { files, unreadable } = parseChangedFiles(diff);
  if (unreadable.length > 0) throw new GitDiffSourceError('unreadable');
  const expected = options.expectedFileCount;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1
    || files.length !== expected || new Set(files.map((file) => file.path)).size !== files.length) {
    throw new GitDiffSourceError('file-count');
  }
  if (files.some((file) => !hunksClosed(file.patch))) throw new GitDiffSourceError('unclosed-hunk');
  return files;
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: string[];
    try { entries = await readdir(current); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry);
      try {
        const stat = await lstat(path);
        if (stat.isDirectory()) pending.push(path);
        else total += stat.size;
      } catch { /* a file git removed between readdir and lstat */ }
    }
  }
  return total;
}

interface RunContext {
  gitBinary: string;
  env: Record<string, string>;
  signal: AbortSignal;
  deadline: number;
  scratch: string;
  maxScratchBytes: number;
  scratchPollMs: number;
}

function runGit(context: RunContext, args: string[], maxStdoutBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const remaining = context.deadline - Date.now();
    if (context.signal.aborted || remaining <= 0) {
      reject(new GitDiffSourceError('timeout'));
      return;
    }
    let settled = false; let stdoutBytes = 0; let failure: GitDiffSourceError | undefined;
    const chunks: Buffer[] = [];
    // Own process group: git fetch runs helpers (remote-https, index-pack) that can
    // hold stdout open, so a stop kills the whole group and settles immediately
    // instead of waiting for every descendant to close the pipe.
    const child = spawn(context.gitBinary, args, {
      cwd: context.scratch, env: context.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'], shell: false,
      detached: true,
    });
    const stop = (error: GitDiffSourceError) => {
      if (!failure) failure = error;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
      finish(failure);
    };
    const onAbort = () => stop(new GitDiffSourceError('timeout'));
    const timer = setTimeout(onAbort, remaining);
    context.signal.addEventListener('abort', onAbort, { once: true });
    let polling = false;
    const watchdog = setInterval(() => {
      if (polling) return;
      polling = true;
      void directoryBytes(context.scratch).then((bytes) => {
        if (bytes > context.maxScratchBytes) stop(new GitDiffSourceError('bounds'));
      }).finally(() => { polling = false; });
    }, context.scratchPollMs);
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(watchdog);
      context.signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(output ?? '');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) { stop(new GitDiffSourceError('bounds')); return; }
      chunks.push(chunk);
    });
    child.on('error', () => finish(new GitDiffSourceError('unavailable')));
    child.on('close', (code) => {
      if (failure) { finish(failure); return; }
      if (code !== 0) { finish(new GitDiffSourceError('unavailable')); return; }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { finish(new GitDiffSourceError('unreadable')); return; }
      // The scratch size is checked once more at exit: a fast fetch can finish between polls.
      void directoryBytes(context.scratch).then((bytes) => {
        if (bytes > context.maxScratchBytes) finish(new GitDiffSourceError('bounds'));
        else finish(undefined, text);
      }, () => finish(new GitDiffSourceError('unavailable')));
    });
  });
}

/** Deterministic `git diff` flags. Both sides must use exactly these; never read them from config. */
export const GIT_DIFF_ARGS = Object.freeze([
  'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', '--diff-algorithm=myers',
  '--indent-heuristic', '--find-renames=50%', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/',
  '--no-relative', '--ignore-submodules=none',
]);

export function createGitDiffSource(options: GitDiffSourceOptions): GitDiffSource {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_DIFF_MAX_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000
    || !Number.isSafeInteger(options.maxScratchBytes) || options.maxScratchBytes < 1
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error('Git diff source configuration invalid');
  }
  const remoteBase = options.remoteUrlFor ? undefined : gitRemoteBaseFromApi(options.apiBaseUrl);
  const remoteUrlFor = options.remoteUrlFor
    ?? ((owner: string, repo: string) => `${remoteBase}/${owner}/${repo}.git`);

  return async (request) => {
    if (!NAME.test(request.owner) || !NAME.test(request.repo) || request.owner === '.' || request.owner === '..'
      || request.repo === '.' || request.repo === '..' || !SHA.test(request.mergeBaseSha) || !SHA.test(request.headSha)
      || typeof request.token !== 'string' || request.token.length === 0 || /[\r\n]/u.test(request.token)) {
      throw new GitDiffSourceError('identity');
    }
    const remoteUrl = remoteUrlFor(request.owner, request.repo);
    if (!/^https:\/\//u.test(remoteUrl) && !(options.allowLocalRemote && /^file:\/\//u.test(remoteUrl))) {
      throw new GitDiffSourceError('unavailable');
    }
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) abort.abort();
    let scratch: string | undefined;
    try {
      scratch = await mkdtemp(join(options.scratchRoot ?? tmpdir(), 'review-yeti-gitdiff-'));
      const config: Array<[string, string]> = [
        ['http.extraHeader', `Authorization: Basic ${Buffer.from(`x-access-token:${request.token}`).toString('base64')}`],
        ['protocol.allow', 'never'],
        ['protocol.https.allow', 'always'],
        ...(options.allowLocalRemote ? [['protocol.file.allow', 'always'] as [string, string]] : []),
        ['credential.helper', ''],
        ['core.hooksPath', '/dev/null'],
        ['core.quotePath', 'true'],
        ['core.fsmonitor', 'false'],
        ['diff.renameLimit', '1000'],
        ['gc.auto', '0'],
        ['maintenance.auto', 'false'],
        ['fetch.recurseSubmodules', 'false'],
      ];
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: scratch,
        LANG: 'C', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        GIT_CONFIG_COUNT: String(config.length),
        ...Object.fromEntries(config.flatMap(([key, value], index) => [
          [`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
      };
      const context: RunContext = {
        gitBinary: options.gitBinary ?? 'git', env, signal: abort.signal, deadline: Date.now() + timeoutMs,
        scratch, maxScratchBytes: options.maxScratchBytes, scratchPollMs: options.scratchPollMs ?? 100,
      };
      const gitDir = join(scratch, 'repository.git');
      await runGit(context, ['init', '--quiet', '--bare', gitDir]);
      await runGit(context, ['--git-dir', gitDir, 'remote', 'add', 'origin', remoteUrl]);
      // Only the two commits, by object id. Trees now; changed blobs are fetched lazily,
      // in one batch, by the diff below.
      await runGit(context, ['--git-dir', gitDir, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head',
        '--no-recurse-submodules', '--depth=1', '--filter=blob:none', 'origin', request.mergeBaseSha, request.headSha]);
      return await runGit(context, ['--git-dir', gitDir, ...GIT_DIFF_ARGS, request.mergeBaseSha, request.headSha, '--'],
        maxOutputBytes);
    } catch (error) {
      if (error instanceof GitDiffSourceError) throw error;
      throw new GitDiffSourceError('unavailable');
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
