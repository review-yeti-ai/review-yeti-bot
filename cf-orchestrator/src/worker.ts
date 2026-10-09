import { RepoGateDO } from './repoGateDO.js';
import { ReviewRunDO } from './reviewRunDO.js';
import { ReviewJobWorkflow } from './reviewJobWorkflow.js';
import { handleMergeGroupAttestation } from './mergeGroupAttestation.js';
import type { DebounceMessagePayload, Env, ReviewRunSpec } from './types.js';
import { isPassthroughMode } from './types.js';
import { purgeExpiredR2WorkspaceCaches } from './runners/r2WorkspaceCache.js';
import { defaultMcpRouter, constantTimeEquals } from './mcp/mcpRouter.js';
import { handleDashboardApi } from './api/dashboardRoutes.js';
import { handleActionDispatch } from './api/actionDispatchRoute.js';
import { isPilotRepository } from './pilotRepository.js';

export { RepoGateDO, ReviewRunDO, ReviewJobWorkflow, handleMergeGroupAttestation };
export { defaultMcpRouter, handleDashboardApi, handleActionDispatch };
export { isPilotRepository };

/**
 * Validates incoming GitHub webhook HMAC-SHA256 signature against secret using Web Crypto API.
 * Uses native constant-time crypto.subtle.verify to protect against timing attacks.
 */
export async function verifyGitHubSignature(
  secret: string,
  signatureHeader: string | null,
  body: string
): Promise<boolean> {
  if (!secret || !signatureHeader || !signatureHeader.startsWith('sha256=') || typeof body !== 'string') {
    return false;
  }
  const hex = signatureHeader.slice(7).trim();
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    return false;
  }

  const sigBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sigBytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body));
}

/**
 * Queries RepoGateDO for the active in-flight runId associated with a pull request.
 */
export async function getActiveRunForPR(
  env: Env,
  repoKey: string,
  prNumber: number
): Promise<string | null> {
  try {
    if (!env?.REPO_GATE?.idFromName || !env?.REPO_GATE?.get) return null;
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);
    const res = await repoGate.fetch(`http://do/active-run/${prNumber}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { activeRunId?: string };
    return data.activeRunId || null;
  } catch (err) {
    console.error(`Error querying active run for PR #${prNumber}:`, err);
    return null;
  }
}

/**
 * Queries RepoGateDO for the latest registered runId (active or pending debounce) for a PR.
 */
export async function getLatestRunForPR(
  env: Env,
  repoKey: string,
  prNumber: number
): Promise<string | null> {
  try {
    if (!env?.REPO_GATE?.idFromName || !env?.REPO_GATE?.get) return null;
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);
    const res = await repoGate.fetch(`http://do/active-run/${prNumber}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { latestRunId?: string };
    return data.latestRunId || null;
  } catch (err) {
    console.error(`Error querying latest run for PR #${prNumber}:`, err);
    return null;
  }
}

/**
 * Invokes cancellation on a specific ReviewRunDO instance.
 */
export async function cancelRun(
  env: Env,
  runId: string,
  reason: string
): Promise<{ cancelled: boolean; previousPhase?: string }> {
  try {
    if (!env?.REVIEW_RUN?.idFromName || !env?.REVIEW_RUN?.get) return { cancelled: false };
    const runDOId = env.REVIEW_RUN.idFromName(runId);
    const runDO = env.REVIEW_RUN.get(runDOId);
    const res = await runDO.fetch('http://do/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) return { cancelled: false };
    return (await res.json()) as { cancelled: boolean; previousPhase: string };
  } catch (err) {
    console.error(`Error cancelling run ${runId}:`, err);
    return { cancelled: false };
  }
}

/**
 * Evicts any queued runs in RepoGateDO for a specific pull request and returns their run IDs.
 */
export async function evictQueuedRunsForPR(
  env: Env,
  repoKey: string,
  prNumber: number,
  tombstone: boolean = true
): Promise<{ evicted: boolean; count: number; evictedRunIds: string[] }> {
  try {
    if (!env?.REPO_GATE?.idFromName || !env?.REPO_GATE?.get) {
      return { evicted: false, count: 0, evictedRunIds: [] };
    }
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);
    const res = await repoGate.fetch('http://do/evict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prNumber, tombstone }),
    });
    if (!res.ok) return { evicted: false, count: 0, evictedRunIds: [] };
    const data = (await res.json()) as {
      evicted?: boolean;
      count?: number;
      evictedRunIds?: string[];
    };
    return {
      evicted: Boolean(data.evicted),
      count: typeof data.count === 'number' ? data.count : 0,
      evictedRunIds: Array.isArray(data.evictedRunIds) ? data.evictedRunIds : [],
    };
  } catch (err) {
    console.error(`Error evicting queued runs for PR #${prNumber}:`, err);
    return { evicted: false, count: 0, evictedRunIds: [] };
  }
}

/**
 * Clears any '__EVICTED__' tombstone in RepoGateDO for a pull request (e.g. when reopened).
 */
export async function clearPrEviction(
  env: Env,
  repoKey: string,
  prNumber: number
): Promise<{ cleared: boolean }> {
  try {
    if (!env?.REPO_GATE?.idFromName || !env?.REPO_GATE?.get) {
      return { cleared: false };
    }
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);
    const res = await repoGate.fetch('http://do/clear-eviction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prNumber }),
    });
    if (!res.ok) return { cleared: false };
    const data = (await res.json()) as { cleared?: boolean };
    return { cleared: Boolean(data.cleared) };
  } catch (err) {
    console.error(`Error clearing eviction for PR #${prNumber}:`, err);
    return { cleared: false };
  }
}

/**
 * Registers a debounced pending run in RepoGateDO for a pull request.
 */
export async function registerPendingRunForPR(
  env: Env,
  repoKey: string,
  prNumber: number,
  runId: string
): Promise<void> {
  try {
    if (!env?.REPO_GATE?.idFromName || !env?.REPO_GATE?.get) return;
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);
    await repoGate.fetch('http://do/register-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prNumber, runId }),
    });
  } catch (err) {
    // Non-fatal if mock doesn't support /register-run
  }
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Health / Ready probe
      if (url.pathname === '/health' || url.pathname === '/ready') {
        return Response.json({
          status: 'ok',
          environment: env.ENVIRONMENT,
          parallelMode: env.PARALLEL_MODE,
        });
      }

      // Live Swarm Command Center shortcut / alias: /l redirects directly to /
      if (url.pathname === '/l' || url.pathname === '/live-swarm') {
        return Response.redirect(new URL('/', request.url).toString(), 302);
      }

      // Pull-path worker status poller: /api/dispatch/runs/:runId/status
      const statusMatch = url.pathname.match(/^\/api\/dispatch\/runs\/([^/]+)\/status$/);
      if (statusMatch && request.method === 'GET') {
        const runId = statusMatch[1];
        if (!/^run_[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
          return new Response('Bad Request: Invalid runId format', { status: 400 });
        }
        const runDOId = env.REVIEW_RUN.idFromName(runId);
        const runDO = env.REVIEW_RUN.get(runDOId);
        return await runDO.fetch('http://do/status');
      }

      // GitHub Actions OIDC Action Dispatch: /api/dispatch/action, /action, /api/qualification/dispatch/action
      if (
        url.pathname === '/api/dispatch/action' ||
        url.pathname === '/action' ||
        url.pathname === '/api/qualification/dispatch/action'
      ) {
        return await handleActionDispatch(request, env, ctx);
      }

      // Maintenance endpoint: Purge expired R2 workspace cache (>1 hour old)
      if (url.pathname === '/api/cache/purge-expired') {
        if (request.method !== 'POST') {
          return new Response('Method Not Allowed: POST required', { status: 405 });
        }

        // 1. Authentication check: require valid REVIEW_YETI_MCP_AUTH_TOKEN
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : (request.headers.get('x-api-key') || '').trim();
        const configuredToken = (env.REVIEW_YETI_MCP_AUTH_TOKEN || '').trim();

        if (!configuredToken || !constantTimeEquals(token, configuredToken)) {
          return new Response('Unauthorized: Purge endpoint requires valid authorization token', { status: 401 });
        }

        if (!env.WORKSPACE_CACHE_BUCKET) {
          return Response.json({ status: 'skipped', reason: 'WORKSPACE_CACHE_BUCKET not bound' }, { status: 400 });
        }

        // 2. Safe bound: enforce minimum floor of 1800s (30m) to prevent malicious or accidental full wipe
        const requestedAge = parseInt(url.searchParams.get('maxAgeSeconds') || '3600', 10);
        const maxAgeSeconds = Math.max(1800, isNaN(requestedAge) ? 3600 : requestedAge);

        const result = await purgeExpiredR2WorkspaceCaches(env.WORKSPACE_CACHE_BUCKET, maxAgeSeconds);
        return Response.json({ status: 'ok', maxAgeSeconds, ...result });
      }

      // Review Yeti MCP Gateway: /api/mcp, /mcp, and subpaths (/sse, /messages)
      if (
        url.pathname === '/api/mcp' ||
        url.pathname === '/mcp' ||
        url.pathname === '/api/mcp/sse' ||
        url.pathname === '/mcp/sse' ||
        url.pathname === '/api/mcp/messages' ||
        url.pathname === '/mcp/messages'
      ) {
        return await defaultMcpRouter.handleHttpRequest(request, env);
      }

      // Review Yeti Dashboard & Analytics REST API (Edge)
      const dashboardResponse = await handleDashboardApi(request, env);
      if (dashboardResponse) {
        return dashboardResponse;
      }

      // Webhook Ingest: /api/webhooks/github
      if (url.pathname === '/api/webhooks/github' && request.method === 'POST') {
        const rawBody = await request.text();
        const eventName = request.headers.get('X-GitHub-Event');
        const signature = request.headers.get('X-Hub-Signature-256');

        // 1. Web Crypto HMAC-SHA256 signature verification
        // Strict fail-closed verification: GITHUB_WEBHOOK_SECRET is required.
        if (!env.GITHUB_WEBHOOK_SECRET) {
          return new Response('Unauthorized: Webhook secret not configured', { status: 500 });
        }
        if (!signature) {
          return new Response('Unauthorized: Invalid HMAC signature', { status: 401 });
        }
        const valid = await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, signature, rawBody);
        if (!valid) {
          return new Response('Unauthorized: Invalid HMAC signature', { status: 401 });
        }

        // 2. Parallel Mode Non-Blocking Fanout to DOKS Ingress
        // Only active when PARALLEL_MODE is enabled ('true') and DOKS_FALLBACK_URL is configured.
        // When PARALLEL_MODE is 'false' or DOKS_FALLBACK_URL is unset, dual-dispatch is completely disabled.
        if (env.PARALLEL_MODE !== 'false' && env.DOKS_FALLBACK_URL) {
          const fanoutPromise = fetch(env.DOKS_FALLBACK_URL, {
            method: 'POST',
            headers: request.headers,
            body: rawBody,
          }).catch((err) => {
            console.error('DOKS fanout error:', err);
          });

          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(fanoutPromise);
          }
        }

        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response('Bad Request: Invalid JSON', { status: 400 });
        }

        // Defensive validation: ensure payload is a valid non-null, non-array object
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          if (eventName === 'pull_request') {
            return new Response(
              'Bad Request: Missing or invalid repository / pull_request payload',
              { status: 400 }
            );
          }
          return new Response('Bad Request: Invalid JSON payload object', { status: 400 });
        }

        // Handle pull_request events
        if (eventName === 'pull_request') {
          const repo = payload.repository;
          const pr = payload.pull_request;

          // Strict defensive validation: require valid repository and pull_request objects
          if (
            !repo ||
            typeof repo !== 'object' ||
            Array.isArray(repo) ||
            typeof repo.full_name !== 'string' ||
            !repo.full_name.trim() ||
            !pr ||
            typeof pr !== 'object' ||
            Array.isArray(pr) ||
            typeof pr.number !== 'number' ||
            Number.isNaN(pr.number)
          ) {
            return new Response(
              'Bad Request: Missing or invalid repository / pull_request payload',
              { status: 400 }
            );
          }

          const action = payload.action;
          const repoFullName = repo.full_name.trim();
          const repoKey = repoFullName.toLowerCase();
          const prNumber = pr.number;

          // 3. Pilot repository filtering
          if (!isPilotRepository(repoFullName, env.PILOT_REPOSITORIES)) {
            return Response.json({ status: 'ignored', reason: 'not_pilot_repository' });
          }

          // 4. Immediate triggers: opened, ready_for_review
          if (action === 'opened' || action === 'ready_for_review') {
            if (pr.draft) {
              return Response.json({ status: 'ignored', reason: 'draft_pr' });
            }

            const runId = `run_${crypto.randomUUID().replace(/-/g, '')}`;
            const repoParts = repoFullName.split('/');
            const spec: ReviewRunSpec = {
              runId,
              owner: repo.owner?.login || repoParts[0] || '',
              repo: repo.name || repoParts[1] || '',
              prNumber,
              headSha: pr.head?.sha || '',
              baseSha: pr.base?.sha || '',
              installationId: payload.installation?.id ?? 0,
            };

            // Trigger Workflow directly
            if (env.REVIEW_JOB_WORKFLOW && typeof env.REVIEW_JOB_WORKFLOW.create === 'function') {
              await env.REVIEW_JOB_WORKFLOW.create({
                id: runId,
                params: spec,
              });
            }

            return Response.json({ status: 'dispatched_immediate', runId });
          }

          // 5. Commit supersession & debounced trigger: synchronize (60s trailing quiet window)
          if (action === 'synchronize') {
            // Immediately discover active in-flight run for this PR and request cancellation (<3s)
            const activeRunId = await getActiveRunForPR(env, repoKey, prNumber);

            // Also evict and discover any queued pending runs for this PR waiting in RepoGateDO
            const evictResult = await evictQueuedRunsForPR(env, repoKey, prNumber, false);

            // Also, if latestRunIdByPr had '__EVICTED__', clear it
            await clearPrEviction(env, repoKey, prNumber);

            const runsToCancel = new Set<string>();
            if (activeRunId) {
              runsToCancel.add(activeRunId);
            }
            for (const rId of evictResult.evictedRunIds) {
              runsToCancel.add(rId);
            }

            // Discover previously registered pending run for this PR before debounce window
            const latestRunId = await getLatestRunForPR(env, repoKey, prNumber);
            if (latestRunId && latestRunId !== '__EVICTED__') {
              runsToCancel.add(latestRunId);
            }

            // Cancel all discovered active, queued, and pending runs in parallel
            if (runsToCancel.size > 0) {
              await Promise.all(
                Array.from(runsToCancel).map((rId) =>
                  cancelRun(env, rId, 'superseded_by_commit')
                )
              );
            }

            const supersededRunId =
              activeRunId ||
              (evictResult.evictedRunIds.length > 0 ? evictResult.evictedRunIds[0] : null);

            // Enqueue new commit with 60s delay
            const runId = `run_${crypto.randomUUID().replace(/-/g, '')}`;
            await registerPendingRunForPR(env, repoKey, prNumber, runId);
            const repoParts = repoFullName.split('/');
            const spec: ReviewRunSpec = {
              runId,
              owner: repo.owner?.login || repoParts[0] || '',
              repo: repo.name || repoParts[1] || '',
              prNumber,
              headSha: pr.head?.sha || '',
              baseSha: pr.base?.sha || '',
              installationId: payload.installation?.id ?? 0,
            };

            // In passthrough mode, bypass the 60s debounce queue and trigger the workflow immediately
            if (isPassthroughMode(env)) {
              if (env.REVIEW_JOB_WORKFLOW && typeof env.REVIEW_JOB_WORKFLOW.create === 'function') {
                await env.REVIEW_JOB_WORKFLOW.create({
                  id: runId,
                  params: spec,
                });
              }

              return Response.json({
                status: 'dispatched_immediate',
                runId,
                passthrough: true,
                supersededRunId,
                supersededRunIds: Array.from(runsToCancel),
              });
            }

            const debounceItem: DebounceMessagePayload = {
              ...spec,
              burstStartedAt: Date.now(),
              enqueuedAt: Date.now(),
            };

            const debounceWindow = env.DEBOUNCE_WINDOW_SECONDS
              ? parseInt(env.DEBOUNCE_WINDOW_SECONDS, 10)
              : 60;
            const delaySeconds = !isNaN(debounceWindow) && debounceWindow >= 0 ? debounceWindow : 60;

            await env.REVIEW_DEBOUNCE_QUEUE.send(debounceItem, {
              delaySeconds,
            });

            return Response.json({
              status: 'queued_debounced',
              runId,
              delaySeconds,
              supersededRunId,
              supersededRunIds: Array.from(runsToCancel),
            });
          }

          // 6. Ingress cancellation routing: closed, converted_to_draft
          if (action === 'closed' || action === 'converted_to_draft') {
            const activeRunId = await getActiveRunForPR(env, repoKey, prNumber);

            // Clean up and retrieve any queued pending runs in the concurrency queue for this PR
            const evictResult = await evictQueuedRunsForPR(env, repoKey, prNumber, true);

            const runsToCancel = new Set<string>();
            if (activeRunId) {
              runsToCancel.add(activeRunId);
            }
            for (const rId of evictResult.evictedRunIds) {
              runsToCancel.add(rId);
            }

            let anyCancelled = false;
            if (runsToCancel.size > 0) {
              const cancelResults = await Promise.all(
                Array.from(runsToCancel).map((rId) =>
                  cancelRun(env, rId, `pr_${action}`)
                )
              );
              anyCancelled = cancelResults.some((res) => res.cancelled);
            }

            const primaryRunId =
              activeRunId ||
              (evictResult.evictedRunIds.length > 0 ? evictResult.evictedRunIds[0] : null);

            return Response.json({
              status: 'cancelled',
              action,
              runId: primaryRunId,
              cancelled: anyCancelled,
              cancelledRunIds: Array.from(runsToCancel),
            });
          }

          // 7. PR reopened: clear __EVICTED__ tombstone and return ignored per spec
          if (action === 'reopened') {
            await clearPrEviction(env, repoKey, prNumber);
            return Response.json({ status: 'ignored' });
          }
        }

        // Handle issue_comment events (Phase 2: PR ChatOps Ingress)
        if (eventName === 'issue_comment') {
          const action = payload.action;
          const issue = payload.issue;
          const comment = payload.comment;
          const repo = payload.repository;

          // Only process comments created on Pull Requests by authorized members/collaborators
          const allowedAssociations = ['OWNER', 'MEMBER', 'COLLABORATOR'];
          const authorAssoc = typeof comment?.author_association === 'string' ? comment.author_association.toUpperCase() : undefined;
          if (
            action !== 'created' ||
            !issue?.pull_request ||
            !comment?.body ||
            !repo?.full_name ||
            (authorAssoc !== undefined && !allowedAssociations.includes(authorAssoc))
          ) {
            return Response.json({ status: 'ignored', reason: 'not_applicable_issue_comment', event: eventName });
          }

          const repoFullName = repo.full_name.trim();
          if (!isPilotRepository(repoFullName, env.PILOT_REPOSITORIES)) {
            return Response.json({ status: 'ignored', reason: 'not_pilot_repository', event: eventName });
          }

          const commentText = comment.body.trim();
          // Support @review-yeti, /review-yeti, @yeti, /yeti
          const commandMatch = commentText.match(/^(?:@review-yeti|\/review-yeti|@yeti|\/yeti)\s+(re-review|review|deep-scan|explain(?:\s+[^\s]+)?)/i);

          if (!commandMatch) {
            return Response.json({ status: 'ignored', reason: 'not_review_command', event: eventName });
          }

          const commandFull = commandMatch[1].trim();
          const commandParts = commandFull.split(/\s+/);
          const verb = commandParts[0].toLowerCase();
          const prNumber = issue.number;
          const runId = `run_chatops_${crypto.randomUUID().replace(/-/g, '')}`;
          const repoParts = repoFullName.split('/');

          let thinkingEffort: 'low' | 'medium' | 'high' | 'max' | undefined = undefined;
          let explainTarget: string | undefined = undefined;

          if (verb === 'deep-scan') {
            thinkingEffort = 'max';
          } else if (verb === 'explain') {
            explainTarget = commandParts.slice(1).join(' ').trim() || undefined;
          }

          const spec: ReviewRunSpec = {
            runId,
            owner: repo.owner?.login || repoParts[0] || '',
            repo: repo.name || repoParts[1] || '',
            prNumber,
            headSha: issue.pull_request?.head?.sha || '',
            baseSha: issue.pull_request?.base?.sha || '',
            installationId: payload.installation?.id ?? 0,
            thinkingEffort,
            explainTarget,
          };

          if (env.REVIEW_JOB_WORKFLOW && typeof env.REVIEW_JOB_WORKFLOW.create === 'function') {
            await env.REVIEW_JOB_WORKFLOW.create({
              id: runId,
              params: spec,
            });
          }

          return Response.json({
            status: 'dispatched_chatops',
            command: verb,
            runId,
            prNumber,
            thinkingEffort: thinkingEffort || 'standard',
            explainTarget,
          });
        }

        if (eventName === 'merge_group') {
          const action = payload.action;
          const repo = payload.repository;
          const mergeGroup = payload.merge_group;
          if (
            !repo ||
            typeof repo !== 'object' ||
            Array.isArray(repo) ||
            !repo.full_name ||
            !mergeGroup ||
            typeof mergeGroup !== 'object' ||
            Array.isArray(mergeGroup)
          ) {
            return new Response('Bad Request: Missing or invalid repository / merge_group payload', { status: 400 });
          }
          if (action !== 'checks_requested') {
            return Response.json({ status: 'ignored', reason: `unsupported_action_${action}`, event: eventName });
          }
          const repoFullName = repo.full_name.trim();
          if (!isPilotRepository(repoFullName, env.PILOT_REPOSITORIES)) {
            return Response.json({ status: 'ignored', reason: 'not_pilot_repository', event: eventName });
          }
          if (!mergeGroup.head_sha || !mergeGroup.head_ref || !mergeGroup.base_ref) {
            return new Response('Bad Request: Missing or invalid repository / merge_group payload', { status: 400 });
          }
          const outcome = await handleMergeGroupAttestation(payload, env);
          return Response.json(outcome);
        }

        return Response.json({ status: 'ignored', event: eventName });
      }

      // 8. Fallback to Static Portal Assets (Next.js Dashboard)
      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('Unhandled ingress error in worker.fetch:', err);
      return new Response('Bad Request: Ingress webhook processing failure', { status: 400 });
    }
  },

  /**
   * Queue Consumer for commit debouncing (60s quiet window)
   */
  async queue(batch: MessageBatch<DebounceMessagePayload>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const payload = message.body;

      if (env.REVIEW_JOB_WORKFLOW && typeof env.REVIEW_JOB_WORKFLOW.create === 'function') {
        await env.REVIEW_JOB_WORKFLOW.create({
          id: payload.runId,
          params: payload,
        });
      }

      message.ack();
    }
  },

  /**
   * Scheduled cron handler for 1-hour aggressive R2 workspace cache expiration
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.WORKSPACE_CACHE_BUCKET) {
      ctx.waitUntil(
        purgeExpiredR2WorkspaceCaches(env.WORKSPACE_CACHE_BUCKET, 3600)
          .then((res) => {
            if (res.deletedCount > 0) {
              console.log(`[r2-cache-cron] Purged ${res.deletedCount} expired workspace cache archives (>1h old)`);
            }
          })
          .catch((err) => {
            console.error('[r2-cache-cron] Error during scheduled cache purge:', err);
          })
      );
    }
  },
};
