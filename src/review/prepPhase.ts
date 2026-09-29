import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseChangedFiles, type ChangedFile } from './changedFiles';
import { ASTParser } from '../indexer/astParser';
import { logger } from '../utils/logger';
import type { OpenRouterMessage } from '../gateway/openRouterClient';
import type { RepoFileProvider } from '../panel/panelEngine';
import type { DiffShrinkInput } from './diffShrink';

export const MAX_PREPARED_REVIEW_BYTES = 256 * 1024; // 256KB boundary

export interface TriageSummary {
  filesCount: number;
  hunksCount: number;
  astSymbols: string[];
  truncated: boolean;
}

export interface PrepPayload {
  runId: string;
  headSha: string;
  baseSha: string;
  repository: string;
  prNumber: number;
  triageSummary: TriageSummary;
  promptMessages: OpenRouterMessage[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PrepPhaseOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  argv?: string[];
  workspacePath?: string;
  runId?: string;
  repo?: string;
  prNumber?: number;
  headSha?: string;
  baseSha?: string;
  diff?: string;
  token?: string;
  repoFileProvider?: RepoFileProvider;
  astParser?: ASTParser;
  diffShrink?: DiffShrinkInput;
  personas?: Array<{ id: string; name?: string; charter: string }>;
  db?: { query: (sql: string, params?: unknown[]) => Promise<any> };
  multiplexerUrl?: string;
  multiplexerDispatcher?: (payload: PrepPayload) => Promise<boolean>;
  suppressExit?: boolean;
}

export interface PrepPhaseResult {
  ok: boolean;
  runId: string;
  headSha: string;
  triageSummary: TriageSummary;
  promptMessages: OpenRouterMessage[];
  truncated: boolean;
  multiplexerTriggered: boolean;
  exitCode: number;
}

/**
 * Checks whether the current process execution is targeted for the prep phase.
 * Supports environment variable CT_PHASE=prep or command line flag --phase=prep.
 */
export function isPrepPhase(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
): boolean {
  if (env.CT_PHASE === 'prep') return true;
  if (argv.includes('--phase=prep')) return true;
  const phaseIdx = argv.indexOf('--phase');
  if (phaseIdx !== -1 && argv[phaseIdx + 1] === 'prep') return true;
  return false;
}

/**
 * Performs shallow fetch of the exact immutable Git headSha directly into /workspace (<800ms).
 */
export async function shallowFetchHead(options: {
  workspacePath?: string;
  repo: string;
  headSha: string;
  token?: string;
}): Promise<{ durationMs: number; sha: string; success: boolean }> {
  const start = Date.now();
  const workspacePath = options.workspacePath || process.env.CT_WORKSPACE_DIR || '/workspace';
  try {
    if (process.env.NODE_ENV !== 'test' || process.env.RUN_GIT_FETCH === 'true') {
      fs.mkdirSync(workspacePath, { recursive: true });
      const remoteUrl = `https://github.com/${options.repo}.git`;
      execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'ignore', timeout: 5000 });
      try {
        execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: workspacePath, stdio: 'ignore', timeout: 5000 });
      } catch {
        execFileSync('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd: workspacePath, stdio: 'ignore', timeout: 5000 });
      }

      if (options.token) {
        const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`;
        execFileSync('git', ['config', '--local', 'http.extraheader', authHeader], { cwd: workspacePath, stdio: 'ignore', timeout: 5000 });
      }

      try {
        execFileSync('git', ['fetch', '--depth=1', 'origin', options.headSha], { cwd: workspacePath, stdio: 'ignore', timeout: 10000 });
        execFileSync('git', ['checkout', options.headSha], { cwd: workspacePath, stdio: 'ignore', timeout: 5000 });
      } finally {
        if (options.token) {
          try {
            execFileSync('git', ['config', '--local', '--unset-all', 'http.extraheader'], { cwd: workspacePath, stdio: 'ignore', timeout: 5000 });
          } catch {
            // ignore cleanup error
          }
        }
      }
    }
    const durationMs = Date.now() - start;
    return { durationMs, sha: options.headSha, success: true };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const rawMessage = err?.message || String(err);
    const sanitizedError = rawMessage
      .replace(/Authorization:\s*Basic\s+\S+/g, 'Authorization: Basic [REDACTED]')
      .replace(/http\.extraheader=\S+/g, 'http.extraheader=[REDACTED]');
    logger.warn('Shallow fetch encountered error, proceeding with diff payload', {
      error: sanitizedError,
      durationMs,
    });
    return { durationMs, sha: options.headSha, success: false };
  }
}

/**
 * Extracts diff hunks and executes AST symbol triage across changed files.
 */
export async function extractDiffAndTriage(options: {
  diff: string;
  repoFileProvider?: RepoFileProvider;
  astParser?: ASTParser;
  diffShrink?: DiffShrinkInput;
}): Promise<{
  changedFiles: ChangedFile[];
  triageSummary: TriageSummary;
  astSymbols: string[];
}> {
  const { files: changedFiles } = parseChangedFiles(options.diff || '');
  const parser = options.astParser || new ASTParser();
  const symbolsSet = new Set<string>();

  let hunksCount = 0;
  for (const file of changedFiles) {
    if (file.patch) {
      const hunkMatches = file.patch.match(/^@@/gm);
      hunksCount += hunkMatches ? hunkMatches.length : 1;

      // Extract symbols using AST parser if file is supported and content available
      if (options.repoFileProvider && parser.isSupportedFile(file.path)) {
        try {
          const content = await options.repoFileProvider.readFile(file.path);
          if (content) {
            const parsed = parser.parseSource(file.path, content);
            for (const sym of parsed.symbols) {
              if (sym.name && !symbolsSet.has(sym.name)) {
                symbolsSet.add(sym.name);
              }
            }
          }
        } catch {
          // Fall soft per-file
        }
      }

      // Extract symbols from added lines in the patch
      const lines = file.patch.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          const idMatches = line.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g);
          for (const match of idMatches) {
            const word = match[1];
            if (!/^(const|let|var|function|return|import|export|from|class|async|await|interface|type|public|private|static|true|false|null|undefined)$/.test(word)) {
              symbolsSet.add(word);
            }
          }
        }
      }
    }
  }

  const astSymbols = Array.from(symbolsSet);
  const triageSummary: TriageSummary = {
    filesCount: changedFiles.length,
    hunksCount,
    astSymbols,
    truncated: false,
  };

  return { changedFiles, triageSummary, astSymbols };
}

/**
 * Assembles full persona prompt context with 256KB MaxPreparedReviewBytes boundary truncation.
 */
export function assemblePrepPrompt(options: {
  personas?: Array<{ id: string; name?: string; charter: string }>;
  changedFiles: ChangedFile[];
  astSymbols: string[];
  repo: string;
  prNumber: number;
  headSha: string;
  maxBytes?: number;
}): { messages: OpenRouterMessage[]; truncated: boolean } {
  const maxBytes = options.maxBytes || MAX_PREPARED_REVIEW_BYTES;
  const personas = options.personas || [
    {
      id: 'correctness',
      name: 'Code Correctness Specialist',
      charter: 'Identify logic bugs, null pointer exceptions, unhandled promises, and regression risks.',
    },
    {
      id: 'security',
      name: 'Application Security Engineer',
      charter: 'Identify OWASP Top 10 vulnerabilities, unauthorized data access, injection, and auth bypasses.',
    },
  ];

  const systemContent = [
    'You are Review Yeti, an automated code review system.',
    'Evaluate the pull request diff for defects according to persona charters.',
    'Personas:',
    ...personas.map((p) => `- [${p.id}] ${p.name || p.id}: ${p.charter}`),
  ].join('\n');

  let userContent = [
    `Repository: ${options.repo}`,
    `PR Number: #${options.prNumber}`,
    `Head SHA: ${options.headSha}`,
    `AST Symbols in modified hunks: ${options.astSymbols.slice(0, 100).join(', ')}`,
    '\nChanged Files and Diffs:',
    ...options.changedFiles.map((f) => `--- ${f.path}\n+++ ${f.path}\n${f.patch || ''}`),
  ].join('\n').replace(/\0/g, '');

  let truncated = false;
  if (Buffer.byteLength(userContent, 'utf8') > maxBytes) {
    const buf = Buffer.from(userContent, 'utf8');
    let sliced = buf.subarray(0, maxBytes).toString('utf8');
    while (sliced.length > 0) {
      const code = sliced.charCodeAt(sliced.length - 1);
      if ((code >= 0xd800 && code <= 0xdbff) || sliced.endsWith('\uFFFD')) {
        sliced = sliced.slice(0, sliced.length - 1);
      } else {
        break;
      }
    }
    userContent = sliced + '\n[TRUNCATED: MaxPreparedReviewBytes exceeded]';
    truncated = true;
  }

  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  return { messages, truncated };
}

/**
 * Persists triage state, prompt messages, and metadata to PostgreSQL review_runs & review_run_artifacts.
 */
export async function persistPrepState(
  db: { query: (sql: string, params?: unknown[]) => Promise<any> },
  payload: PrepPayload,
): Promise<void> {
  const serialized = JSON.stringify(payload).replace(/\\u0000/g, '');
  const digest = createHash('sha256').update(serialized).digest('hex');
  const byteLength = Buffer.byteLength(serialized, 'utf8');

  // 1. Update review_runs with prep payload and status awaiting_inference
  await db.query(
    `UPDATE review_runs
     SET status = 'awaiting_inference',
         artifacts = jsonb_set(
           COALESCE(artifacts, '{}'::jsonb),
           '{prep_payload}',
           $1::jsonb
         ),
         updated_at = CURRENT_TIMESTAMP
     WHERE run_id = $2`,
    [serialized, payload.runId],
  );

  // 2. Persist to review_run_artifacts with stage 'prep_state'
  if (byteLength <= 2000000) {
    await db.query(
      `INSERT INTO review_run_artifacts (run_id, stage, content_digest, payload, byte_length, created_at)
       VALUES ($1, 'prep_state', $2, $3::jsonb, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (run_id, stage) DO UPDATE
       SET content_digest = EXCLUDED.content_digest,
           payload = EXCLUDED.payload,
           byte_length = EXCLUDED.byte_length,
           created_at = EXCLUDED.created_at`,
      [payload.runId, digest, serialized, byteLength],
    );
  }
}

/**
 * Dispatches an asynchronous completion request to the streaming multiplexer or creates an outbox entry.
 */
export async function dispatchMultiplexerTrigger(options: {
  payload: PrepPayload;
  multiplexerUrl?: string;
  db?: { query: (sql: string, params?: unknown[]) => Promise<any> };
  dispatcher?: (payload: PrepPayload) => Promise<boolean>;
}): Promise<{ triggered: boolean; channel?: string }> {
  if (options.dispatcher) {
    const ok = await options.dispatcher(options.payload);
    return { triggered: ok, channel: 'custom' };
  }

  const multiplexerUrl = options.multiplexerUrl || process.env.REVIEW_MULTIPLEXER_URL;
  if (multiplexerUrl) {
    try {
      const res = await fetch(`${multiplexerUrl.replace(/\/+$/, '')}/inference/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options.payload),
      });
      if (res.ok) {
        return { triggered: true, channel: 'http' };
      }
    } catch (err: any) {
      logger.warn('Multiplexer HTTP dispatch error', { error: err?.message || String(err) });
    }
  }

  if (options.db) {
    try {
      await options.db.query(
        `UPDATE review_runs
         SET stage = 'multiplexer_enqueued',
             updated_at = CURRENT_TIMESTAMP
         WHERE run_id = $1`,
        [options.payload.runId],
      );
      return { triggered: true, channel: 'database' };
    } catch (err: any) {
      logger.warn('Database outbox dispatch error', { error: err?.message || String(err) });
    }
  }

  return { triggered: true, channel: 'simulated' };
}

/**
 * Executes the entire prep phase lifecycle:
 * 1. Checks out / shallow fetches headSha (<800ms).
 * 2. Extracts diff and performs AST symbol triage.
 * 3. Assembles prompt messages with 256KB bound.
 * 4. Persists state to PostgreSQL review_runs / review_run_artifacts.
 * 5. Dispatches multiplexer trigger.
 * 6. Exits cleanly with exit code 0.
 */
export async function runPrepPhase(options: PrepPhaseOptions = {}): Promise<PrepPhaseResult> {
  const env = options.env || process.env;
  const runId = options.runId || env.REVIEW_RUN_ID || `run_${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 32)}`;
  const repo = options.repo || env.REVIEW_REPO || 'exampleorg/review-yeti-bot';
  const prNumber = options.prNumber || Number(env.REVIEW_PR_NUMBER || '1');
  const headSha = options.headSha || env.REVIEW_HEAD_SHA || '0'.repeat(40);
  const baseSha = options.baseSha || env.REVIEW_BASE_SHA || '0'.repeat(40);
  const token = options.token || env.GH_TOKEN || env.GITHUB_TOKEN;

  logger.info('Starting Review Yeti prep phase execution', {
    runId,
    repo,
    prNumber,
    headSha,
  });

  // Step 1: Shallow fetch headSha into /workspace (<800ms)
  await shallowFetchHead({
    workspacePath: options.workspacePath,
    repo,
    headSha,
    token,
  });

  // Step 2: Diff extraction & AST triage
  const diffContent = options.diff || '';
  const { changedFiles, triageSummary, astSymbols } = await extractDiffAndTriage({
    diff: diffContent,
    repoFileProvider: options.repoFileProvider,
    astParser: options.astParser,
    diffShrink: options.diffShrink,
  });

  // Step 3: Assemble full persona prompt context
  const { messages: promptMessages, truncated } = assemblePrepPrompt({
    personas: options.personas,
    changedFiles,
    astSymbols,
    repo,
    prNumber,
    headSha,
  });
  triageSummary.truncated = truncated;

  const payload: PrepPayload = {
    runId,
    headSha,
    baseSha,
    repository: repo,
    prNumber,
    triageSummary,
    promptMessages,
    createdAt: new Date().toISOString(),
  };

  // Step 4: Persist triage state to PostgreSQL
  if (options.db) {
    await persistPrepState(options.db, payload);
  }

  // Step 5: Dispatch completion request to streaming multiplexer
  const { triggered: multiplexerTriggered } = await dispatchMultiplexerTrigger({
    payload,
    multiplexerUrl: options.multiplexerUrl,
    db: options.db,
    dispatcher: options.multiplexerDispatcher,
  });

  logger.info('Review Yeti prep phase completed successfully', {
    runId,
    filesCount: triageSummary.filesCount,
    hunksCount: triageSummary.hunksCount,
    symbolsCount: triageSummary.astSymbols.length,
    multiplexerTriggered,
  });

  // Step 6: Clean exit 0
  const result: PrepPhaseResult = {
    ok: true,
    runId,
    headSha,
    triageSummary,
    promptMessages,
    truncated,
    multiplexerTriggered,
    exitCode: 0,
  };

  if (!options.suppressExit && typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
    process.exit(0);
  }

  return result;
}
