import { createHash } from 'node:crypto';
import { shallowFetchHead } from './prepPhase';
import {
  extractFindings,
  normalizeFinding,
  sanitizeJsonString,
  type Finding,
  type FindingSeverity,
} from './findings';
import {
  CommentPublisher,
  type PublishInlineCommentRequest,
} from '../github/commentPublisher';
import {
  CHECK_CONTEXT_GATE,
  GitHubInstallationClient,
} from '../github/installationClient';
import { withGitHubRetry, githubRetryDeadlineFromEnv } from '../github/githubRetry';
import { raceWithAbort } from '../gateway/raceWithAbort';
import { flushMetrics } from '../telemetry/metrics';
import { logger } from '../utils/logger';
import { PostgresStore } from '../persistence/postgresStore';

export type ContinuationGateVerdict = 'SHIP' | 'FIX_FIRST' | 'BLOCK';
export type ContinuationGateConclusion = 'success' | 'failure';

export interface ContinuationGateResult {
  verdict: ContinuationGateVerdict;
  conclusion: ContinuationGateConclusion;
  gateTitle: string;
  summary: string;
  quorumSatisfied: boolean;
  findingsCount: number;
}

export interface ContinuationPhaseOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  argv?: string[];
  workspacePath?: string;
  runId?: string;
  repo?: string;
  prNumber?: number;
  headSha?: string;
  baseSha?: string;
  token?: string;
  db?: { query: (sql: string, params?: unknown[]) => Promise<any> };
  timeoutMs?: number; // default: 60_000
  suppressExit?: boolean;
  commentPublisher?: any;
  checkClient?: any;
}

export interface ContinuationPhaseResult {
  ok: boolean;
  runId: string;
  headSha: string;
  verdict: ContinuationGateVerdict;
  conclusion: ContinuationGateConclusion;
  findings: Finding[];
  commentPosted: boolean;
  checkUpdated: boolean;
  gateCheckId?: number;
  exitCode: number;
  alreadyCompleted?: boolean;
}

function withTimeoutGuard<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return raceWithAbort(
    operation,
    signal,
    () => (signal.reason instanceof Error ? signal.reason : new Error(`Continuation execution exceeded ${timeoutMs}ms timeout guard`)),
  );
}

/**
 * Checks whether the current process execution is targeted for the continuation phase.
 * Supports environment variable CT_PHASE=continuation or command line flag --phase=continuation.
 */
export function isContinuationPhase(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
): boolean {
  if (env.CT_PHASE === 'continuation') return true;
  if (argv.includes('--phase=continuation')) return true;
  const phaseIdx = argv.indexOf('--phase');
  if (phaseIdx !== -1 && argv[phaseIdx + 1] === 'continuation') return true;
  return false;
}


/**
 * Evaluates gate policy based on extracted findings.
 * - Any P0 or unclassified/missing severity -> BLOCK (failure) [FAIL-CLOSED]
 * - Any P1 -> FIX_FIRST (failure)
 * - P2 or clean -> SHIP (success)
 */
export function evaluateGatePolicy(rawFindings: Finding[]): ContinuationGateResult {
  const findings = Array.isArray(rawFindings) ? rawFindings : [];
  const normalized = findings.map(normalizeFinding);

  const hasP0 = normalized.some((f) => f.severity === 'P0');
  const hasUnclassified = findings.some(
    (f) => !f || !f.severity || !['P0', 'P1', 'P2'].includes(String(f.severity).toUpperCase().trim()),
  );
  const hasP1 = normalized.some((f) => f.severity === 'P1');

  let verdict: ContinuationGateVerdict = 'SHIP';
  let conclusion: ContinuationGateConclusion = 'success';
  let gateTitle = 'Review Yeti Gate: Approved (SHIP)';
  let summary = 'Review Yeti Gate approved: no blocking defects found.';
  let quorumSatisfied = true;

  if (hasUnclassified) {
    verdict = 'BLOCK';
    conclusion = 'failure';
    gateTitle = 'Review Yeti Gate: Blocked (Unclassified)';
    summary = 'Review Yeti Gate blocked: found unclassified defect(s) with missing or unrecognized severity. Quorum unmet.';
    quorumSatisfied = false;
  } else if (hasP0) {
    verdict = 'BLOCK';
    conclusion = 'failure';
    gateTitle = 'Review Yeti Gate: Blocked (P0)';
    summary = 'Review Yeti Gate blocked: found P0 critical blocker(s).';
  } else if (hasP1) {
    verdict = 'FIX_FIRST';
    conclusion = 'failure';
    gateTitle = 'Review Yeti Gate: Failed (FIX_FIRST)';
    summary = 'Review Yeti Gate failed: found P1 major finding(s). Remediate before merging.';
  }

  return {
    verdict,
    conclusion,
    gateTitle,
    summary,
    quorumSatisfied,
    findingsCount: normalized.length,
  };
}

/**
 * Formats Markdown PR summary body from findings and gate verdict.
 */
export function formatContinuationSummary(options: {
  repo: string;
  prNumber: number;
  headSha: string;
  verdict: ContinuationGateVerdict;
  conclusion: ContinuationGateConclusion;
  findings: Finding[];
}): string {
  const { repo, prNumber, headSha, verdict, findings } = options;
  const emoji = verdict === 'SHIP' ? '✅' : verdict === 'FIX_FIRST' ? '⚠️' : '🛑';
  const lines: string[] = [
    `## ${emoji} Review Yeti Gate: ${verdict}`,
    '',
    `**Repository:** \`${repo}\` | **PR:** #${prNumber} | **Commit:** \`${(headSha || '').slice(0, 8)}\``,
    '',
  ];

  if (!findings || findings.length === 0) {
    lines.push('No blocking defects or issues were identified during automated triage and reasoning.');
  } else {
    lines.push(`### Findings Breakdown (${findings.length})`);
    lines.push('');
    lines.push('| Severity | File:Line | Title | Description |');
    lines.push('| :--- | :--- | :--- | :--- |');
    for (const f of findings) {
      const rawTitle = f?.title || 'Review finding';
      const rawDesc = f?.description || '';
      const escapedTitle = String(rawTitle).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const escapedDesc = String(rawDesc).slice(0, 120).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const severity = f?.severity || 'P0';
      const file = f?.file || 'unknown';
      const escapedFile = String(file).replace(/`/g, "'").replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const line = f?.line ?? 1;
      lines.push(`| **${severity}** | \`${escapedFile}:${line}\` | ${escapedTitle} | ${escapedDesc} |`);
    }
  }

  lines.push('', '---', '_Generated by Review Yeti Ephemeral Continuation Runner_');
  return lines.join('\n');
}

/**
 * Loads continuation review state from PostgreSQL review_runs and review_run_artifacts.
 */
export async function loadContinuationState(
  db: { query: (sql: string, params?: unknown[]) => Promise<any> },
  runId: string,
  options?: {
    expectedRepo?: string;
    expectedPrNumber?: number;
    expectedHeadSha?: string;
  },
): Promise<{
  run: {
    runId: string;
    repo?: string;
    prNumber?: number;
    headSha?: string;
    baseSha?: string;
    status: string;
    artifacts?: any;
    resultDigest?: string;
  };
  llmCompletion: any;
  alreadyCompleted?: boolean;
}> {
  const res = await db.query(
    'SELECT run_id, repo, pr_number, head_sha, base_sha, status, artifacts, result_digest FROM review_runs WHERE run_id = $1',
    [runId],
  );
  const rows = res?.rows || (Array.isArray(res) ? res : []);
  if (rows.length === 0) {
    throw new Error(`PRECONDITION_FAILED: Missing review triage/LLM state for run ${runId}`);
  }

  const row = rows[0];
  const status = row.status || '';

  // Validate identity bounds if provided
  if (options?.expectedRepo && row.repo && row.repo !== options.expectedRepo) {
    throw new Error(`PRECONDITION_FAILED: Repository mismatch for run ${runId}: expected ${options.expectedRepo}, found ${row.repo}`);
  }
  if (options?.expectedHeadSha && row.head_sha && row.head_sha !== options.expectedHeadSha) {
    throw new Error(`PRECONDITION_FAILED: HeadSha mismatch for run ${runId}: expected ${options.expectedHeadSha}, found ${row.head_sha}`);
  }
  if (options?.expectedPrNumber && row.pr_number && Number(row.pr_number) !== Number(options.expectedPrNumber)) {
    throw new Error(`PRECONDITION_FAILED: PR number mismatch for run ${runId}: expected ${options.expectedPrNumber}, found ${row.pr_number}`);
  }

  let artifacts = row.artifacts;
  if (typeof artifacts === 'string') {
    try {
      artifacts = JSON.parse(artifacts);
    } catch {
      artifacts = {};
    }
  }

  const run = {
    runId: row.run_id,
    repo: row.repo,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    status,
    artifacts,
    resultDigest: row.result_digest,
  };

  if (status === 'completed') {
    return {
      run,
      llmCompletion: artifacts?.llmCompletion || artifacts?.llm_completion || {},
      alreadyCompleted: true,
    };
  }

  let llmCompletion = artifacts?.llmCompletion || artifacts?.llm_completion;
  if (!llmCompletion) {
    try {
      const artRes = await db.query(
        'SELECT payload FROM review_run_artifacts WHERE run_id = $1 AND stage = $2',
        [runId, 'llm_completion'],
      );
      const artRows = artRes?.rows || (Array.isArray(artRes) ? artRes : []);
      if (artRows.length > 0) {
        const rawPayload = artRows[0].payload;
        llmCompletion = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
      }
    } catch {
      // ignore
    }
  }

  if (!llmCompletion) {
    throw new Error(`PRECONDITION_FAILED: Missing review triage/LLM state for run ${runId}`);
  }

  if (typeof llmCompletion === 'string') {
    try {
      llmCompletion = JSON.parse(llmCompletion);
    } catch {
      // keep as string
    }
  }

  if (row.result_digest && typeof llmCompletion === 'object' && llmCompletion !== null) {
    const sanitized = sanitizeJsonString(llmCompletion);
    const computed = createHash('sha256').update(sanitized, 'utf8').digest('hex');
    if (computed !== row.result_digest) {
      logger.warn('State integrity verification: completion digest mismatch', {
        runId,
        expected: row.result_digest,
        computed,
      });
    }
  }

  return {
    run,
    llmCompletion,
    alreadyCompleted: false,
  };
}

/**
 * Executes the entire continuation phase lifecycle:
 * 1. Shallow fetch headSha directly into /workspace using shallowFetchHead (<800ms).
 * 2. Connect to PostgreSQL and load review_runs and review_run_artifacts by runId.
 * 3. Idempotency: if review status is already 'completed', log and return cleanly without re-posting.
 * 4. Extract findings from llmCompletion / llm_completion using extractFindings.
 * 5. Evaluate gate policy: any P0 -> BLOCK (failure), any P1 -> FIX_FIRST (failure), P2 / clean -> SHIP (success).
 * 6. Post comments using CommentPublisher and update Review Yeti Gate check run on GitHub via publishGateCheck wrapped in withGitHubRetry.
 * 7. Enforce a 60s execution timeout guard.
 * 8. Update PostgreSQL review_runs to status = 'completed' and completed_at = CURRENT_TIMESTAMP.
 * 9. Flush telemetry via flushMetrics() and return/exit 0 cleanly.
 */
export async function runContinuationPhase(
  options: ContinuationPhaseOptions = {},
): Promise<ContinuationPhaseResult> {
  const env = options.env || process.env;
  const runId = options.runId || env.REVIEW_RUN_ID || `run_${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 32)}`;
  const repo = options.repo || env.REVIEW_REPO || 'exampleorg/review-yeti-bot';
  const prNumber = options.prNumber || Number(env.REVIEW_PR_NUMBER || '1');
  const headSha = options.headSha || env.REVIEW_HEAD_SHA || env.GIT_HEAD_SHA || '0'.repeat(40);
  const token = options.token || env.GITHUB_PUBLISH_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  const timeoutMs = options.timeoutMs ?? 60_000;

  logger.info('Starting Review Yeti continuation phase execution', {
    runId,
    repo,
    prNumber,
    headSha,
  });

  // Timeout Guard: enforce 60s execution boundary
  const abortController = new AbortController();
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    abortController.abort(new Error(`Continuation execution exceeded ${timeoutMs}ms timeout guard`));
  }, timeoutMs);

  let localPool: any = null;

  try {
    if (abortController.signal.aborted || timedOut) {
      throw abortController.signal.reason || new Error(`Continuation execution timed out (${timeoutMs}ms)`);
    }

    // Step 1: Shallow fetch headSha directly into /workspace (<800ms)
    await withTimeoutGuard(
      shallowFetchHead({
        workspacePath: options.workspacePath,
        repo,
        headSha,
        token,
      }),
      abortController.signal,
      timeoutMs,
    );

    if (abortController.signal.aborted || timedOut) {
      throw abortController.signal.reason || new Error(`Continuation execution timed out (${timeoutMs}ms)`);
    }

    // Resolve DB queryable
    let db = options.db;
    if (!db) {
      const postgresStore = new PostgresStore();
      if (postgresStore.isConfigured()) {
        localPool = postgresStore.getPool();
        db = localPool;
      }
    }

    if (!db) {
      throw new Error(`PRECONDITION_FAILED: Missing review triage/LLM state for run ${runId}`);
    }

    // Step 2: Connect to PostgreSQL and load review_runs and review_run_artifacts by runId
    const { run, llmCompletion, alreadyCompleted } = await withTimeoutGuard(
      loadContinuationState(db, runId, {
        expectedRepo: options.repo || (repo !== 'exampleorg/review-yeti-bot' ? repo : undefined),
        expectedPrNumber: options.prNumber || (prNumber !== 1 ? prNumber : undefined),
        expectedHeadSha: options.headSha || (headSha !== '0'.repeat(40) ? headSha : undefined),
      }),
      abortController.signal,
      timeoutMs,
    );

    const effectiveRepo = options.repo || run.repo || repo;
    const effectivePrNumber = options.prNumber || run.prNumber || prNumber;
    const effectiveHeadSha = options.headSha || run.headSha || headSha;

    // Step 3: Idempotency check: if review status is already 'completed', return cleanly without re-posting
    if (alreadyCompleted || run.status === 'completed') {
      logger.info('Review run is already marked completed; exiting cleanly without re-posting', { runId });
      await withTimeoutGuard(flushMetrics(), abortController.signal, timeoutMs);
      const idempotentResult: ContinuationPhaseResult = {
        ok: true,
        runId,
        headSha: effectiveHeadSha,
        verdict: 'SHIP',
        conclusion: 'success',
        findings: [],
        commentPosted: false,
        checkUpdated: false,
        exitCode: 0,
        alreadyCompleted: true,
      };
      if (!options.suppressExit && typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
        process.exit(0);
      }
      return idempotentResult;
    }

    if (abortController.signal.aborted || timedOut) {
      throw abortController.signal.reason || new Error(`Continuation execution exceeded ${timeoutMs}ms timeout guard`);
    }

    // Step 4: Extract findings from llmCompletion / llm_completion using extractFindings
    let findings: Finding[] = [];
    if (Array.isArray(llmCompletion?.findings)) {
      findings = llmCompletion.findings.map(normalizeFinding);
    } else if (typeof llmCompletion?.rawOutput === 'string' && llmCompletion.rawOutput.trim()) {
      findings = extractFindings(llmCompletion.rawOutput);
    } else if (typeof llmCompletion === 'string') {
      findings = extractFindings(llmCompletion);
    }

    // Step 5: Evaluate gate policy (any P0 -> BLOCK, any P1 -> FIX_FIRST, P2/clean -> SHIP)
    const gateResult = evaluateGatePolicy(findings);
    const { verdict, conclusion, gateTitle, summary } = gateResult;

    logger.info('Continuation phase gate policy evaluated', {
      runId,
      findingsCount: findings.length,
      verdict,
      conclusion,
    });

    if (abortController.signal.aborted || timedOut) {
      throw abortController.signal.reason || new Error(`Continuation execution exceeded ${timeoutMs}ms timeout guard`);
    }

    // Step 6: Post comments using CommentPublisher and update Review Yeti Gate check run on GitHub
    const [repoOwner, repoName] = effectiveRepo.split('/');
    const summaryMarkdown = formatContinuationSummary({
      repo: effectiveRepo,
      prNumber: effectivePrNumber,
      headSha: effectiveHeadSha,
      verdict,
      conclusion,
      findings,
    });

    const inlineComments: PublishInlineCommentRequest[] = findings
      .filter((f) => f.file && f.line)
      .map((f) => ({
        path: f.file,
        line: f.line,
        finding: {
          persona: 'continuation-gate',
          severity: f.severity,
          filePath: f.file,
          lineNumber: f.line,
          title: f.title,
          comment: f.description + (f.suggestedPatch ? `\n\n\`\`\`suggestion\n${f.suggestedPatch}\n\`\`\`` : ''),
        },
      }));

    let commentPosted = false;
    let checkUpdated = false;
    let gateCheckId: number | undefined;

    // 6a: Post PR Review Comment
    if (options.commentPublisher) {
      await withTimeoutGuard(
        options.commentPublisher.publishReview({
          owner: repoOwner,
          repo: repoName,
          prNumber: effectivePrNumber,
          commitSha: effectiveHeadSha,
          event: verdict === 'SHIP' ? 'APPROVE' : 'REQUEST_CHANGES',
          body: summaryMarkdown,
          inlineComments,
          idempotencyKey: `continuation:${effectiveRepo}#${effectivePrNumber}:${effectiveHeadSha}`,
        }),
        abortController.signal,
        timeoutMs,
      );
      commentPosted = true;
    } else if (token) {
      try {
        const publisher = new CommentPublisher({
          githubToken: token,
          allowUserToken: true,
        });
        await withTimeoutGuard(
          publisher.publishReview({
            owner: repoOwner,
            repo: repoName,
            prNumber: effectivePrNumber,
            commitSha: effectiveHeadSha,
            event: verdict === 'SHIP' ? 'APPROVE' : 'REQUEST_CHANGES',
            body: summaryMarkdown,
            inlineComments,
            idempotencyKey: `continuation:${effectiveRepo}#${effectivePrNumber}:${effectiveHeadSha}`,
          }),
          abortController.signal,
          timeoutMs,
        );
        commentPosted = true;
      } catch (err: any) {
        if (abortController.signal.aborted || timedOut) throw err;
        logger.warn('Failed to publish review comment to PR', { error: err?.message || String(err) });
      }
    }

    if (abortController.signal.aborted || timedOut) {
      throw abortController.signal.reason || new Error(`Continuation execution timed out (${timeoutMs}ms)`);
    }

    // 6b: Post / update Review Yeti Gate check run wrapped in withGitHubRetry
    const deadlineAtMs = githubRetryDeadlineFromEnv(env);
    const checkClient = options.checkClient || (token ? new GitHubInstallationClient({
      token,
      ...(deadlineAtMs !== undefined ? { retry: { deadlineAtMs } } : {}),
    }) : undefined);
    if (checkClient) {
      gateCheckId = await withTimeoutGuard(
        withGitHubRetry(
          {
            operation: `POST /repos/${repoOwner}/${repoName}/check-runs`,
            method: 'POST',
            attempt: async () => {
              return await checkClient.publishGateCheck(repoOwner, repoName, effectiveHeadSha, {
                title: gateTitle,
                conclusion,
                summary,
                text: summaryMarkdown,
              });
            },
            ...(typeof checkClient.findGateCheck === 'function' ? {
              reconcile: async () => {
                try {
                  const check = await checkClient.findGateCheck!(repoOwner, repoName, effectiveHeadSha);
                  if (check) {
                    return typeof check === 'number' ? check : Number(check.id);
                  }
                } catch {
                  // ignore lookup error and proceed to retry attempt
                }
                return undefined;
              },
            } : {}),
          },
          { signal: abortController.signal, maxAttempts: 4 },
        ),
        abortController.signal,
        timeoutMs,
      );
      checkUpdated = true;
    }

    if (abortController.signal.aborted || timedOut) {
      throw abortController.signal.reason || new Error(`Continuation execution timed out (${timeoutMs}ms)`);
    }

    // Step 8: Update PostgreSQL review_runs to status = 'completed' and completed_at = CURRENT_TIMESTAMP
    const continuationArtifact = JSON.stringify({
      verdict,
      conclusion,
      gateTitle,
      findingsCount: findings.length,
      gateCheckId,
      completedAt: new Date().toISOString(),
    });

    try {
      await withTimeoutGuard(
        db.query(
          `UPDATE review_runs
           SET status = 'completed',
               stage = 'continuation_completed',
               completed_at = CURRENT_TIMESTAMP,
               artifacts = jsonb_set(
                 COALESCE(artifacts, '{}'::jsonb),
                 '{continuation_result}',
                 $1::jsonb
               ),
               updated_at = CURRENT_TIMESTAMP
           WHERE run_id = $2`,
          [continuationArtifact, runId],
        ),
        abortController.signal,
        timeoutMs,
      );
    } catch (err: any) {
      if (err?.message && String(err.message).includes('completed_at')) {
        await withTimeoutGuard(
          db.query(
            `UPDATE review_runs
             SET status = 'completed',
                 stage = 'continuation_completed',
                 artifacts = jsonb_set(
                   COALESCE(artifacts, '{}'::jsonb),
                   '{continuation_result}',
                   $1::jsonb
                 ),
                 updated_at = CURRENT_TIMESTAMP
             WHERE run_id = $2`,
            [continuationArtifact, runId],
          ),
          abortController.signal,
          timeoutMs,
        );
      } else {
        throw err;
      }
    }

    // Step 9: Flush telemetry via flushMetrics() and return/exit 0 cleanly
    await withTimeoutGuard(flushMetrics(), abortController.signal, timeoutMs);

    logger.info('Review Yeti continuation phase completed successfully', {
      runId,
      verdict,
      conclusion,
      commentPosted,
      checkUpdated,
    });

    const result: ContinuationPhaseResult = {
      ok: true,
      runId,
      headSha: effectiveHeadSha,
      verdict,
      conclusion,
      findings,
      commentPosted,
      checkUpdated,
      gateCheckId,
      exitCode: 0,
    };

    if (!options.suppressExit && typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
      process.exit(0);
    }

    return result;
  } catch (err: any) {
    if (timedOut || abortController.signal.aborted) {
      throw abortController.signal.reason || new Error(`Continuation execution exceeded ${timeoutMs}ms timeout guard`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
    if (localPool && typeof localPool.end === 'function') {
      try {
        await localPool.end();
      } catch {
        // ignore
      }
    }
  }
}
