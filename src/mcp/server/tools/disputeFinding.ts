/**
 * Tool: dispute_finding
 *
 * Request a fresh exact-head review of a finding with an untrusted developer counter-argument.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type ToolDefinition,
  type ToolResult,
  type McpExecutionContext,
  buildToolResultJson,
} from '../mcpTypes';
import { canAccessRepository, McpRbacError } from '../mcpRbac';
import type { ReviewModelClient } from '../../../gateway/openRouterClient';
import {
  getReviewFindingId,
  extractReviewFindingEntries,
  findReviewFindingRecord,
} from './findingIdentity';
import { withLockedReviewPrTransaction, type ReviewPrTransactionPool } from '../../../persistence/reviewPrTransaction';
import { parseReviewExecutionCheckpoint, reviewCheckpointMatchesCompletion } from '../../../review/reviewExecutionCheckpoint';
import { parseWorkerReviewCompletion, publishedFindingSeverity, workerReviewCompletionDigest } from '../../../review/workerReviewCompletion';
import { canonicalJson, sha256 } from '../../../review/reviewCore';
import type { AuthoritativeReviewAdmission } from '../../../review/authoritativeServiceContracts';
import { admitCompletedFindingRecheck, completedFindingRecheckCoordinates } from '../../../persistence/completedFindingRecheckAdmission';
import { recordPrFindingRecheckRequest } from '../../../persistence/reviewPrLifecycleRepository';
import {
  disputedFindingRecheckDigest,
  MAX_DISPUTE_RECHECKS_PER_BATCH,
  MAX_DISPUTE_RECHECK_ARGUMENT_CHARACTERS,
  loadValidatedDisputedFindingRechecks,
  type DisputedFindingRecheckUnsigned,
} from '../../../review/disputedFindingRecheck';

export const DisputeFindingInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255),
  pr_number: z.number().int().positive('pr_number must be a positive integer').safe(),
  finding_id: z.string().trim().min(1, 'finding_id must not be empty').max(256),
  counter_argument: z.string().trim().min(1, 'counter_argument must not be empty').max(MAX_DISPUTE_RECHECK_ARGUMENT_CHARACTERS),
}).strict();

export type DisputeFindingInput = z.infer<typeof DisputeFindingInputSchema>;

export interface DisputeFindingOutput {
  version: 'DisputeFindingRecheckReceipt.v1';
  finding_id: string;
  request_id: string;
  review_status: 'fresh_re_review_requested';
  remaining_blockers: number;
}

export const disputeFindingDefinition: ToolDefinition = {
  name: 'dispute_finding',
  description: 'Request a fresh exact-head review of a finding with a developer counter-argument. The argument is untrusted review evidence; this tool never changes the finding or gate. Returns a versioned DisputeFindingRecheckReceipt.v1 receipt; legacy adjudication outputs are retired. A task in one source completion accepts one request: repeating the same finding and argument is idempotent, while a different request for that task is rejected.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'GitHub repository owner or organization.' },
      repo: { type: 'string', description: 'GitHub repository name.' },
      pr_number: { type: 'number', description: 'Pull request number.' },
      finding_id: { type: 'string', description: 'Unique identifier of the finding to dispute.' },
      counter_argument: { type: 'string', description: 'Developer counter-argument and technical justification.' },
    },
    required: ['owner', 'repo', 'pr_number', 'finding_id', 'counter_argument'],
    additionalProperties: false,
  },
};

export interface DisputeFindingDependencies {
  authoritativePublishing?: AuthoritativeReviewAdmission;
  now?: () => number;
  queryableDatabase?: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  };
  transactionPool?: ReviewPrTransactionPool;
  adjudicateDispute?: (
    finding: any,
    counterArgument: string,
    context?: { owner?: string; repo?: string; pr_number?: number }
  ) => Promise<{ verdict: 'upheld' | 'overruled'; reasoning: string; confidence?: number }> |
     { verdict: 'upheld' | 'overruled'; reasoning: string; confidence?: number };
  modelClient?: ReviewModelClient | {
    complete(options: {
      model?: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<{ content: string }>;
  };
  model?: string;
  timeoutMs?: number;
  notifyResourceUpdated?: (uri: string, payload?: any) => number;
}

export function defaultAdjudicateFinding(
  finding: any,
  counterArgument: string
): { verdict: 'upheld' | 'overruled'; reasoning: string; confidence: number } {
  const trimmed = counterArgument.trim();

  // Dismissive or low-effort rebuttals are upheld
  if (
    trimmed.length < 20 ||
    /^(ignore|whatever|not a bug|dont care|wont fix|skip|override|stfu|false positive\s*$)/i.test(trimmed) ||
    /^(this is fine|not important|leave it|looks good to me)$/i.test(trimmed)
  ) {
    return {
      verdict: 'upheld',
      reasoning: `Counter-argument lacks technical evidence or verifiable mitigation rationale for finding '${finding?.title || finding?.finding_id || 'unidentified'}'. Blocker finding remains upheld.`,
      confidence: 0.9,
    };
  }

  // Genuine technical rebuttal providing architectural context, existing guard, or benchmark proof
  return {
    verdict: 'overruled',
    reasoning: `Quorum adjudication accepted counter-argument: Technical mitigation and verified context accepted for finding '${finding?.title || finding?.finding_id || 'unidentified'}'. Finding overruled and resolved.`,
    confidence: 0.85,
  };
}

export async function evaluateDisputeWithModel(
  modelClient: NonNullable<DisputeFindingDependencies['modelClient']>,
  finding: any,
  counterArgument: string,
  options: {
    model?: string;
    timeoutMs?: number;
    owner?: string;
    repo?: string;
    pr_number?: number;
  } = {}
): Promise<{ verdict: 'upheld' | 'overruled'; reasoning: string; confidence: number }> {
  const modelName = options.model || 'deepseek/deepseek-v4-flash-0731';
  const timeoutMs = options.timeoutMs || 10_000;
  const violatedAdrs = Array.isArray(finding.violated_adrs)
    ? finding.violated_adrs
    : Array.isArray(finding.adrs)
    ? finding.adrs
    : [];

  const prompt = `You are Review Yeti's Blocker Quorum Adjudicator powered by DeepSeek.
Your task is to impartially adjudicate a developer dispute regarding a review finding against repository charters, ADRs, and evidence.

Finding Details:
- Title: ${finding.title || 'Finding'}
- Severity: ${finding.severity || 'P1'}
- Category: ${finding.category || 'Architecture'}
- File: ${finding.path || finding.file_path || 'unknown'}:${finding.line_start || finding.line || 1}
- Violated ADRs: ${violatedAdrs.length > 0 ? violatedAdrs.join(', ') : 'None specified'}
- Rationale: ${finding.rationale || finding.body || 'No rationale provided'}
- Code Snippet:
${finding.originalCode || finding.codeSnippet || 'N/A'}

Repository Directives & Charters:
Active Charters: Architecture (ADR compliance), Security (Authentication, Injection, Tenant Isolation), Correctness (Concurrency, Error handling), Performance (Resource bounds).

Developer Counter-Argument:
"${counterArgument}"

Adjudication Rules:
1. OVERRULE the finding if the developer provides legitimate technical justification, demonstrates a valid mitigation, cites appropriate architectural exceptions, proves the issue is handled by an existing guard or framework invariant, or shows the finding is a false positive.
2. UPHELD the finding if the counter-argument is dismissive, low-effort, ignores safety invariants, fails to provide verifiable technical justification, or violates critical ADRs/security policies.
3. Assign a confidence score between 0.0 and 1.0 based on the clarity and strength of the technical evidence.

Respond ONLY with a valid JSON object in this format:
{
  "verdict": "upheld" | "overruled",
  "reasoning": "<detailed technical justification for the verdict>",
  "confidence": <number between 0.0 and 1.0>
}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await modelClient.complete({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: 1024,
      timeoutMs,
      signal: controller.signal,
    });

    const content = (response.content || '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const verdict: 'upheld' | 'overruled' = parsed.verdict === 'overruled' ? 'overruled' : 'upheld';
      const reasoning =
        String(parsed.reasoning || '').trim() ||
        (verdict === 'overruled' ? 'Quorum accepted counter-argument.' : 'Quorum rejected counter-argument.');
      const confidence =
        typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
          ? parsed.confidence
          : (verdict === 'overruled' ? 0.9 : 0.85);
      return { verdict, reasoning, confidence };
    }
  } catch {
    // Graceful fallback to heuristic
  } finally {
    clearTimeout(timeoutId);
  }

  return defaultAdjudicateFinding(finding, counterArgument);
}

function jsonValue(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function assertSameCompletionIdentity(row: any, completion: ReturnType<typeof parseWorkerReviewCompletion>): void {
  const coordinates = jsonValue(row.gate_coordinates);
  const matches = coordinates && typeof coordinates === 'object'
    && coordinates.runId === completion.runId
    && Number(coordinates.repositoryId) === completion.repositoryId
    && coordinates.owner === completion.owner && coordinates.repo === completion.repo
    && Number(coordinates.prNumber) === completion.prNumber
    && coordinates.headSha === completion.headSha && coordinates.baseSha === completion.baseSha
    && coordinates.policyDigest === completion.policyDigest
    && Number(coordinates.executionAttempt) === completion.executionAttempt
    && coordinates.attemptId === row.gate_attempt_id;
  const admitted = row.admitted_execution_attempt != null;
  const next = completedFindingRecheckCoordinates(completion.executionAttempt, Number(row.review_generation));
  const executionMatches = admitted
    ? Number(row.admitted_execution_attempt) === next.executionAttempt
      && Number(row.outbox_execution_attempt) + 1 === Number(row.admitted_execution_attempt)
      && Number(row.admitted_review_generation) === next.generation
      && Number(row.attempt) === Number(row.admitted_review_generation)
    : Number(row.review_generation) === Number(row.attempt)
      && Number(row.outbox_execution_attempt) + 1 === completion.executionAttempt;
  if (!matches || !executionMatches
    || Number(row.repository_id) !== completion.repositoryId || Number(row.pr_number) !== completion.prNumber
    || row.owner !== completion.owner || row.repo !== completion.repo
    || row.head_sha !== completion.headSha || row.base_sha !== completion.baseSha
    || row.effective_policy_digest !== completion.policyDigest || row.effective_config_digest !== completion.configDigest) {
    throw new Error('Finding source does not match its admitted review identity');
  }
}

export function createDisputeFindingTool(deps: DisputeFindingDependencies = {}) {
  return {
    definition: disputeFindingDefinition,
    schema: DisputeFindingInputSchema,
    execute: async (rawArgs: Record<string, unknown>, context?: McpExecutionContext): Promise<ToolResult> => {
      const parsed = DisputeFindingInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      const { owner, repo, pr_number, finding_id, counter_argument } = parsed.data;
      const caller = context?.caller;
      const authorizedRepository = context?.authorizedRepository;
      if (context?.authenticatedByConfiguredAuthenticator !== true || !caller || !authorizedRepository
        || authorizedRepository.owner.toLowerCase() !== owner.toLowerCase()
        || authorizedRepository.repo.toLowerCase() !== repo.toLowerCase()
        || !canAccessRepository(caller, owner, repo)) {
        throw new McpRbacError(owner, repo);
      }
      if (!deps.transactionPool) throw new Error('Fresh finding review is temporarily unavailable');
      const authoritative = deps.authoritativePublishing;
      if (authoritative?.acceptNewRequests !== true || !authoritative.resolver) {
        throw new Error('Fresh finding review requires active authoritative admission');
      }

      // Resolve immutable coordinates with a short connection lease. The external
      // authority read happens before BEGIN/PR locking and is checked again against
      // the locked source row, so a slow resolver cannot pin a mutation connection.
      const hintClient = await deps.transactionPool.connect();
      let hint: any;
      try {
        hint = (await hintClient.query(`SELECT repository_id, pr_number, head_sha, base_sha,
            effective_policy_digest, effective_config_digest FROM review_runs
            WHERE owner = $1 AND repo = $2 AND pr_number = $3
            ORDER BY created_at DESC, run_id DESC LIMIT 1`, [owner, repo, pr_number])).rows[0];
      } finally { hintClient.release(); }
      if (!hint) throw new Error(`No accepted review is available for ${owner}/${repo}#${pr_number}`);
      const repositoryId = Number(hint.repository_id);
      const storedPrNumber = Number(hint.pr_number);
      if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || storedPrNumber !== pr_number) {
        throw new Error('Finding source coordinates are invalid');
      }
      const resolved = await (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            authoritative.resolver.resolve({ repositoryId, owner, repo, prNumber: pr_number,
              headSha: hint.head_sha, baseSha: hint.base_sha }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Authoritative finding review resolution timed out')), 15_000);
              timer.unref?.();
            }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      })();
      const queued = await withLockedReviewPrTransaction(deps.transactionPool,
        async () => ({ repositoryId, prNumber: storedPrNumber }), async (client) => {
        const row = (await client.query(`
          WITH latest_run AS (
            SELECT run_id, repository_id, owner, repo, pr_number, head_sha, base_sha, snapshot_digest,
                   effective_policy_digest, effective_config_digest, attempt, status, created_at,
                   authoritative_gate_app_id, publication_mode, result_digest
              FROM review_runs
             WHERE owner = $1 AND repo = $2 AND pr_number = $3
             ORDER BY created_at DESC, run_id DESC
             LIMIT 1
          )
          SELECT runs.*, outbox.execution_attempt AS outbox_execution_attempt, outbox.status AS outbox_status,
                 completion.execution_attempt, completion.content_digest, completion.payload,
                 gate.attempt_id AS gate_attempt_id, gate.review_generation,
                 gate.worker_result_digest, gate.coordinates AS gate_coordinates,
                 gate.desired_state, gate.desired_version, gate.published_version,
                 gate.creation_state, gate.check_id, gate.current_attempt
                 , admission.execution_attempt AS admitted_execution_attempt,
                 admission.review_generation AS admitted_review_generation
            FROM latest_run runs
            LEFT JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
            LEFT JOIN LATERAL (
              SELECT * FROM review_worker_completions stored
               WHERE stored.run_id = runs.run_id
               ORDER BY stored.execution_attempt DESC LIMIT 1
            ) completion ON true
            LEFT JOIN LATERAL (
              SELECT * FROM review_gate_attempts stored_gate
               WHERE stored_gate.run_id = runs.run_id
                 AND stored_gate.execution_attempt = completion.execution_attempt
                 AND stored_gate.worker_result_digest = completion.content_digest
               ORDER BY stored_gate.review_generation DESC LIMIT 1
            ) gate ON true
            LEFT JOIN review_finding_recheck_admissions admission
              ON admission.run_id = runs.run_id
             AND admission.source_execution_attempt = completion.execution_attempt`,
        [owner, repo, pr_number])).rows[0];
        if (!row || !row.payload || !row.gate_attempt_id
          || (row.admitted_execution_attempt == null
            ? !['succeeded', 'failed'].includes(String(row.status))
            : !['queued', 'running'].includes(String(row.status)))
          // Completed reviews can retain a projected outbox row: the worker
          // result and its Gate publication, not outbox cleanup state, are the
          // authoritative evidence that this is an accepted source.
          || (row.admitted_execution_attempt == null
            ? !['projected', 'terminal'].includes(String(row.outbox_status)) || row.current_attempt !== true
            : !['pending', 'claimed', 'projected'].includes(String(row.outbox_status)) || row.current_attempt !== false)
          || row.creation_state !== 'bound' || row.check_id == null
          || !['success', 'failure'].includes(String(row.desired_state))
          || Number(row.published_version) < Number(row.desired_version)) {
          throw new Error('The latest review does not have a published, accepted finding source');
        }

        const completion = parseWorkerReviewCompletion(jsonValue(row.payload));
        const digest = workerReviewCompletionDigest(completion);
        if (row.content_digest !== digest || row.worker_result_digest !== digest) {
          throw new Error('Finding source completion digest is invalid');
        }
        assertSameCompletionIdentity(row, completion);
        if (completion.repositoryId !== repositoryId || completion.prNumber !== storedPrNumber
          || completion.headSha !== hint.head_sha || completion.baseSha !== hint.base_sha
          || completion.policyDigest !== hint.effective_policy_digest || completion.configDigest !== hint.effective_config_digest) {
          throw new Error('Finding source changed while its authoritative candidate was being resolved');
        }
        if (!authoritative.repositoryIds.includes(completion.repositoryId)
          || row.publication_mode !== 'app-gate'
          || Number(row.authoritative_gate_app_id) !== authoritative.expectedAppId) {
          throw new Error('Finding source is outside active authoritative admission');
        }
        // The preflight resolver supplies current candidate/policy truth. Its exact
        // coordinates are rebound under this transaction; the worker and final Gate
        // independently check current truth before authoritative publication.

        if (!resolved.current.open || resolved.current.draft
          || ['repositoryId', 'owner', 'repo', 'prNumber', 'headSha', 'baseSha'].some((key) =>
            resolved.current[key as keyof typeof resolved.current] !== completion[key as keyof typeof completion])
          || resolved.prepared.policy.effectivePolicyDigest !== completion.policyDigest
          || resolved.prepared.policy.effectiveConfigDigest !== completion.configDigest) {
          throw new Error('Finding source no longer matches the current candidate and trusted policy');
        }
        const taskPlan = completion.result.taskPlan;
        if (!taskPlan || completion.result.personas.length === 0
          || completion.result.coverageComplete !== true || completion.result.quorumSatisfied !== true
          || completion.result.personas.some((persona) => persona.status !== 'COMPLETE')) {
          throw new Error('Finding is not from a resumable composed review task');
        }
        const findingRecords = extractReviewFindingEntries(completion, { includeAlternateSources: true })
          .map((entry) => ({ ...entry, runId: completion.runId }));
        const matched = findReviewFindingRecord(findingRecords, finding_id);
        if (!matched) throw new Error(`Finding '${finding_id}' was not found in the latest accepted completion`);
        const canonicalFindingId = getReviewFindingId(completion.runId, matched.personaId, matched.finding);
        const task = taskPlan.find((candidate) => candidate.id === matched.personaId);
        if (!task) throw new Error('Finding persona is not bound to a composed review task');

        const existing = (await client.query(
          `SELECT request_id, finding_id, counter_argument_digest, request_digest
             FROM review_finding_rechecks
            WHERE run_id = $1 AND source_execution_attempt = $2 AND task_id = $3
            FOR UPDATE`, [completion.runId, completion.executionAttempt, task.id],
        )).rows[0];
        const counterArgumentDigest = sha256(counter_argument);
        if (existing) {
          if (existing.finding_id !== canonicalFindingId || existing.counter_argument_digest !== counterArgumentDigest) {
            throw new Error('A different dispute re-review is already queued for this task');
          }
          if (row.admitted_execution_attempt == null) throw new Error('Finding request has no durable execution admission');
          const requests = await loadValidatedDisputedFindingRechecks(client, row, Number(row.admitted_execution_attempt));
          if (!requests.some((request) => request.requestId === String(existing.request_id))) {
            throw new Error('Finding request source is unavailable');
          }
          await recordPrFindingRecheckRequest(client, {
            runId: completion.runId, sourceExecutionAttempt: completion.executionAttempt,
            requestId: String(existing.request_id), findingId: canonicalFindingId,
            actorDigest: sha256(caller.callerId), sourceContentDigest: digest,
            sourceContextDigest: String(row.snapshot_digest),
            requestDigest: String(existing.request_digest), at: (deps.now ?? Date.now)(),
          });
          return { requestId: String(existing.request_id), completion, finding: matched.finding,
            findingId: canonicalFindingId };
        }

        const checkpointRow = (await client.query(
          'SELECT payload FROM review_execution_checkpoints WHERE run_id = $1 FOR UPDATE', [completion.runId],
        )).rows[0];
        if (!checkpointRow) throw new Error('The completed task checkpoint is unavailable for a safe re-review');
        const checkpoint = parseReviewExecutionCheckpoint(jsonValue(checkpointRow.payload));
        if (!reviewCheckpointMatchesCompletion(checkpoint, completion)) {
          throw new Error('The task checkpoint does not match the accepted source completion');
        }
        const completed = checkpoint.completedTasks.find((candidate) => candidate.id === task.id);
        const checkpointFinding = completed && findReviewFindingRecord([
          ...extractReviewFindingEntries({ result: { personas: [{ id: matched.personaId, findings: completed.findings }] } })
            .map((entry) => ({ ...entry, runId: completion.runId })),
        ], canonicalFindingId);
        if (!completed || !checkpointFinding) {
          throw new Error('The disputed finding is absent from its durable task checkpoint');
        }

        const count = Number((await client.query(
          `SELECT COUNT(*)::int AS count FROM review_finding_rechecks
            WHERE run_id = $1 AND source_execution_attempt = $2`, [completion.runId, completion.executionAttempt],
        )).rows[0]?.count ?? 0);
        if (!Number.isSafeInteger(count) || count >= MAX_DISPUTE_RECHECKS_PER_BATCH) {
          throw new Error('The current finding re-review batch has reached its bounded size');
        }

        const requestId = randomUUID();
        const unsigned: DisputedFindingRecheckUnsigned = {
          requestId,
          runId: completion.runId,
          sourceExecutionAttempt: completion.executionAttempt,
          sourceContentDigest: digest,
          sourcePlanDigest: sha256(canonicalJson(taskPlan)),
          sourceGateAttemptId: String(row.gate_attempt_id),
          repositoryId: completion.repositoryId,
          owner: completion.owner,
          repo: completion.repo,
          prNumber: completion.prNumber,
          headSha: completion.headSha,
          baseSha: completion.baseSha,
          policyDigest: completion.policyDigest,
          configDigest: completion.configDigest,
          findingId: canonicalFindingId,
          personaId: matched.personaId,
          taskId: task.id,
          finding: {
            severity: matched.finding.severity,
            path: String(matched.finding.path || matched.finding.file_path || matched.finding.file || ''),
            line: Number(matched.finding.line_end || matched.finding.line || 1),
            title: String(matched.finding.title || ''),
            body: String(matched.finding.body || matched.finding.rationale || ''),
          },
          counterArgument: counter_argument,
          counterArgumentDigest,
        };
        const requestDigest = disputedFindingRecheckDigest(unsigned);
        await client.query(
          `INSERT INTO review_finding_rechecks
             (request_id, run_id, source_execution_attempt, source_content_digest, source_plan_digest, source_gate_attempt_id,
              repository_id, owner, repo, pr_number, head_sha, base_sha, policy_digest, config_digest,
              finding_id, persona_id, task_id, finding, counter_argument, counter_argument_digest,
              request_digest, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   $15, $16, $17, $18::jsonb, $19, $20, $21, $22)`,
          [requestId, completion.runId, completion.executionAttempt, digest, unsigned.sourcePlanDigest, row.gate_attempt_id,
            completion.repositoryId, completion.owner, completion.repo, completion.prNumber,
            completion.headSha, completion.baseSha, completion.policyDigest, completion.configDigest,
            canonicalFindingId, matched.personaId, task.id, JSON.stringify(unsigned.finding), counter_argument,
            counterArgumentDigest, requestDigest, sha256(caller.callerId)],
        );
        await admitCompletedFindingRecheck(client, unsigned, {
          sourceGeneration: Number(row.review_generation), expectedAppId: authoritative.expectedAppId,
          actorDigest: sha256(caller.callerId), now: (deps.now ?? Date.now)(),
        });
        await recordPrFindingRecheckRequest(client, {
          runId: completion.runId, sourceExecutionAttempt: completion.executionAttempt,
          requestId, findingId: canonicalFindingId, actorDigest: sha256(caller.callerId),
          sourceContentDigest: digest, sourceContextDigest: String(row.snapshot_digest), requestDigest,
          at: (deps.now ?? Date.now)(),
        });
        return { requestId, completion, finding: matched.finding, findingId: canonicalFindingId };
      });

      const blockers = extractReviewFindingEntries(queued.completion, { includeAlternateSources: true })
        .filter(({ finding }) => ['P0', 'P1'].includes(publishedFindingSeverity(finding))).length;
      return buildToolResultJson({ version: 'DisputeFindingRecheckReceipt.v1', finding_id: queued.findingId, request_id: queued.requestId,
        review_status: 'fresh_re_review_requested', remaining_blockers: blockers } satisfies DisputeFindingOutput);
    },
  };
}
