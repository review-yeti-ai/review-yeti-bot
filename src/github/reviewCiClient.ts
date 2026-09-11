import { z } from 'zod';
import { BoundedCiTransport, ciUnavailable, type CiTransportOptions } from './boundedCiTransport';
import { REVIEW_CI_EVENT, reviewCiRunName, reviewCiRequestEventSchema, reviewCiCoordinatesSchema,
  reviewCiExecutionSchema, normalizeReviewCiBinding,
  reviewCiTerminalReceiptSchema, type ReviewCiExecution, type ReviewCiTerminalReceipt,
  type ReviewCiDispatchReceipt, type ReviewCiRequestEvent, type ReviewCiRunCorrelation,
  type ReviewCiRunReadback, type ReviewCiValidationBinding } from '../review/reviewCi';
export { REVIEW_CI_EVENT, reviewCiRunName, reviewCiRequestEventSchema as reviewCiRequestSchema } from '../review/reviewCi';

export const REVIEW_CI_APP_ID = 4385771;
export const MAX_CI_PAGES = 10;
const positive = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
export const ciRepositorySchema = reviewCiCoordinatesSchema.innerType().pick({ repositoryId: true, owner: true, repo: true });
export type CiRepository = z.infer<typeof ciRepositorySchema>;

export type ReviewCiRequest = ReviewCiRequestEvent;
const correlationSchema = reviewCiExecutionSchema.innerType().pick({ requestId: true, epoch: true });
export type CiRunCorrelation = ReviewCiRunCorrelation;
const nonempty = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u);
const repositoryResponse = z.object({ id: positive, full_name: z.string().max(201) });
const baseRef = z.string().min(1).max(255)
  .regex(/^[^\u0000-\u0020\u007f~^:?*\[\]\\]+$/u)
  .refine((value) => value !== '@' && !value.includes('@{') && !value.includes('//') && !value.endsWith('/')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'
      && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')));
const branchTipSchema = z.object({ name: baseRef, commit: z.object({ sha }) });
const conclusion = z.enum(['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure']).nullable();
const status = z.enum(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed']);
const runSchema = z.object({ id: positive, workflow_id: positive, run_attempt: positive,
  head_sha: sha, head_branch: z.string().max(256), event: z.string().max(64), path: z.string().max(600),
  display_title: z.string().max(512), repository: repositoryResponse,
  status, conclusion }).refine((v) => (v.status === 'completed') === (v.conclusion !== null));
type Run = z.infer<typeof runSchema>;
const jobSchema = z.object({ id: positive, run_id: positive, head_sha: sha, name: nonempty, status, conclusion,
  started_at: z.string().datetime({ offset: true }).nullable(), completed_at: z.string().datetime({ offset: true }).nullable() });

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  try { return schema.parse(input); } catch { throw ciUnavailable(); }
}

export type CiDispatchReceipt = ReviewCiDispatchReceipt;
export type CiRunReadback = ReviewCiRunReadback;

/** Unwired, explicit service capability. All paths/ref/job expectations come
 * from trusted configuration; responses never supply a URL for another call. */
export class GitHubReviewCiClient {
  private readonly repository: CiRepository;
  private readonly configuredBinding?: ReviewCiValidationBinding;
  private readonly namedRef: string;
  private readonly transport: BoundedCiTransport;
  private readonly token: string;
  private readonly route: string;
  constructor(options: CiTransportOptions & { token: string; expectedAppId: number;
    repository: CiRepository; binding?: ReviewCiValidationBinding }) {
    if (options.expectedAppId !== REVIEW_CI_APP_ID || !/^ghs_[A-Za-z0-9_]+$/u.test(options.token)) throw ciUnavailable();
    this.repository = parse(ciRepositorySchema, options.repository);
    try { this.configuredBinding = options.binding === undefined ? undefined : normalizeReviewCiBinding(options.binding); } catch { throw ciUnavailable(); }
    this.namedRef = this.configuredBinding?.workflowRef.replace(/^refs\/(heads|tags)\//u, '') ?? '';
    if (/^[a-fA-F0-9]{40,64}$/u.test(this.namedRef)
      || this.namedRef.split('/').some((part) => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw ciUnavailable();
    this.token = options.token;
    this.transport = new BoundedCiTransport(options);
    this.route = `/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.repo)}`;
  }

  private get binding(): ReviewCiValidationBinding {
    if (!this.configuredBinding) throw ciUnavailable();
    return this.configuredBinding;
  }

  private assertRepository(actual: z.infer<typeof repositoryResponse>): void {
    if (actual.id !== this.repository.repositoryId || actual.full_name !== `${this.repository.owner}/${this.repository.repo}`) throw ciUnavailable();
  }

  private assertRun(value: unknown, binding: CiRunCorrelation, expectedId?: number, expectedAttempt?: number): Run {
    const run = parse(runSchema, value);
    this.assertRepository(run.repository);
    if (run.workflow_id !== this.binding.workflowId || run.head_sha !== this.binding.workflowSha
      || run.head_branch !== this.namedRef
      || run.event !== 'workflow_dispatch' || run.display_title !== reviewCiRunName(binding.requestId, binding.epoch)
      || ![this.binding.workflowPath, `${this.binding.workflowPath}@${this.namedRef}`, `${this.binding.workflowPath}@${this.binding.workflowRef}`].includes(run.path)
      || (expectedId !== undefined && run.id !== expectedId)
      || (expectedAttempt !== undefined && run.run_attempt !== expectedAttempt)) throw ciUnavailable();
    return run;
  }

  /** A 204 acknowledges event delivery only. It is never a workflow result. */
  async dispatchRepository(input: ReviewCiRequest): Promise<CiDispatchReceipt> {
    const payload = parse(reviewCiRequestEventSchema, input);
    this.assertRepository({ id: payload.repository_id, full_name: payload.repository });
    try {
      return await this.transport.run(async (request) => {
        const reply = await request(`${this.route}/dispatches`, this.token, 'POST', { event_type: REVIEW_CI_EVENT, client_payload: payload });
        return reply.status === 204 ? { status: 'accepted' } : this.dispatchFailure(reply.status);
      });
    } catch { return { status: 'uncertain' }; }
  }

  /** API 2022-11-28: request returned run details. Empty/late acknowledgement
   * stays uncertain and must be correlated; this method never retries POST. */
  async dispatchWorkflow(input: CiRunCorrelation): Promise<CiDispatchReceipt> {
    const binding = parse(correlationSchema, input);
    const workflow = this.binding; // Missing trusted binding fails before dispatch, not "uncertain".
    try {
      return await this.transport.run(async (request) => {
        const reply = await request(`${this.route}/actions/workflows/${workflow.workflowId}/dispatches`, this.token, 'POST', {
          ref: this.namedRef, inputs: { requestId: binding.requestId, epoch: String(binding.epoch) }, return_run_details: true,
        });
        if (reply.status !== 200) return this.dispatchFailure(reply.status);
        const receipt = parse(z.object({ workflow_run_id: positive }), reply.data);
        return { status: 'accepted', runId: receipt.workflow_run_id };
      });
    } catch { return { status: 'uncertain' }; }
  }

  private dispatchFailure(httpStatus: number): CiDispatchReceipt {
    return { status: [400, 401, 403, 404, 422].includes(httpStatus) ? 'rejected' : 'uncertain' };
  }

  private async pages(request: Parameters<Parameters<BoundedCiTransport['run']>[0]>[0], path: string, key: 'workflow_runs' | 'jobs'): Promise<unknown[]> {
    const found: unknown[] = [];
    const ids = new Set<number>();
    let total: number | undefined;
    for (let page = 1; page <= MAX_CI_PAGES; page++) {
      const reply = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, this.token);
      if (reply.status !== 200) throw ciUnavailable();
      const data = parse(z.object({ total_count: z.number().int().min(0).max(MAX_CI_PAGES * 100),
        [key]: z.array(z.unknown()).max(100), incomplete_results: z.literal(false).optional(), truncated: z.literal(false).optional() }), reply.data);
      const entries = data[key] as unknown[];
      if (total !== undefined && total !== data.total_count) throw ciUnavailable();
      total = data.total_count as number;
      for (const value of entries) {
        const { id } = parse(z.object({ id: positive }), value);
        if (ids.has(id)) throw ciUnavailable();
        ids.add(id); found.push(value);
      }
      if (found.length > total) throw ciUnavailable();
      if (found.length === total) return found;
      if (entries.length !== 100) throw ciUnavailable();
    }
    throw ciUnavailable();
  }

  /** Null is a bounded observation, NOT permission to send another dispatch. */
  async correlateRun(input: CiRunCorrelation): Promise<{ runId: number; runAttempt: number } | null> {
    const binding = parse(correlationSchema, input);
    return this.transport.run(async (request) => {
      const entries = await this.pages(request, `${this.route}/actions/workflows/${this.binding.workflowId}/runs?event=workflow_dispatch&head_sha=${this.binding.workflowSha}`, 'workflow_runs');
      const matched = entries.filter((entry) => parse(z.object({ display_title: z.string().max(512) }), entry).display_title === reviewCiRunName(binding.requestId, binding.epoch));
      if (matched.length > 1) throw ciUnavailable();
      if (!matched.length) return null;
      const run = this.assertRun(matched[0], binding);
      return { runId: run.id, runAttempt: run.run_attempt };
    });
  }

  async readRun(input: CiRunCorrelation & { runId: number; runAttempt: number }): Promise<CiRunReadback> {
    const { runId, runAttempt, ...binding } = parse(correlationSchema.extend({ runId: positive, runAttempt: positive }), input);
    return this.transport.run(async (request) => {
      const getRun = async () => {
        const reply = await request(`${this.route}/actions/runs/${runId}`, this.token);
        if (reply.status !== 200) throw ciUnavailable();
        return this.assertRun(reply.data, binding, runId, runAttempt);
      };
      const before = await getRun();
      const output: CiRunReadback = { ...binding, runId, runAttempt, workflowSha: this.binding.workflowSha,
        status: before.status, conclusion: before.conclusion, requiredJobsPassed: false, requiredJobs: [] };
      if (before.status !== 'completed') return output;
      const jobs = (await this.pages(request, `${this.route}/actions/runs/${runId}/attempts/${runAttempt}/jobs`, 'jobs'))
        .map((value) => parse(jobSchema, value));
      if (jobs.some((job) => job.run_id !== runId || job.head_sha !== this.binding.workflowSha)) throw ciUnavailable();
      const required = this.binding.lanePlan.requiredJobs.map((name) => {
        const matches = jobs.filter((job) => job.name === name);
        if (matches.length !== 1) throw ciUnavailable();
        return matches[0];
      });
      const after = await getRun();
      if (after.status !== before.status || after.conclusion !== before.conclusion) throw ciUnavailable();
      output.requiredJobs = required.map(({ id, name, status, conclusion }) => ({ id, name, status, conclusion }));
      output.requiredJobsPassed = before.conclusion === 'success' && required.every((job) => job.status === 'completed'
        && job.conclusion === 'success' && job.started_at !== null && job.completed_at !== null
        && Date.parse(job.started_at) <= Date.parse(job.completed_at));
      return output;
    });
  }

  /** Requires an already service-bound execution. No candidate artifact, URL or
   * job-supplied verdict participates. The pinned workflow is responsible for
   * checking out the durable request's C; Actions head_sha is its workflow SHA. */
  async readTerminalReceipt(input: ReviewCiExecution): Promise<ReviewCiTerminalReceipt> {
    const execution = parse(reviewCiExecutionSchema, input);
    if (execution.repositoryId !== this.repository.repositoryId || execution.workflowId !== this.binding.workflowId
      || execution.workflowSha !== this.binding.workflowSha || execution.candidateSha !== this.binding.candidateSha) throw ciUnavailable();
    const result = await this.readRun({ requestId: execution.requestId, epoch: execution.epoch,
      runId: execution.runId, runAttempt: execution.runAttempt });
    if (result.status !== 'completed' || (result.conclusion === 'success' && !result.requiredJobsPassed)) throw ciUnavailable();
    return parse(reviewCiTerminalReceiptSchema, { version: 'ReviewCiTerminalReceipt.v1', execution,
      conclusion: result.conclusion, jobs: result.requiredJobs.map((job) => ({ ...job,
        runId: result.runId, runAttempt: result.runAttempt })) });
  }

  /** GitHub's current test-merge C is distinct from both PR H and workflow SHA.
   * Verify the exact base-ref tip is B, ordered parents are B,H, and the PR plus
   * base ref remain unchanged around the immutable candidate read. */
  async verifyMergeCandidate(input: { prNumber: number; baseSha: string; headSha: string; candidateSha: string }):
    Promise<CiRepository & typeof input> {
    const target = parse(z.object({ prNumber: positive, baseSha: sha, headSha: sha, candidateSha: sha }).strict(), input);
    if (this.configuredBinding && target.candidateSha !== this.configuredBinding.candidateSha) throw ciUnavailable();
    return this.inspectMergeCandidate(target, target.candidateSha);
  }

  /** Resolve C before admission. Requires no workflow binding or fabricated C;
   * a cached PR payload cannot bypass the independent base-ref tip check. */
  async currentMergeCandidate(input: { prNumber: number; baseSha: string; headSha: string }):
    Promise<CiRepository & typeof input & { candidateSha: string }> {
    const target = parse(z.object({ prNumber: positive, baseSha: sha, headSha: sha }).strict(), input);
    return this.inspectMergeCandidate(target);
  }

  private async inspectMergeCandidate(target: { prNumber: number; baseSha: string; headSha: string }, expectedCandidate?: string):
    Promise<CiRepository & typeof target & { candidateSha: string }> {
    return this.transport.run(async (request) => {
      let candidateSha = expectedCandidate;
      let currentBaseRef: string | undefined;
      const current = async () => {
        const reply = await request(`${this.route}/pulls/${target.prNumber}`, this.token);
        if (reply.status !== 200) throw ciUnavailable();
        const pr = parse(z.object({ number: positive, state: z.literal('open'), draft: z.literal(false), merged: z.literal(false),
          mergeable: z.literal(true), merge_commit_sha: sha, head: z.object({ sha }),
          base: z.object({ ref: baseRef, sha, repo: repositoryResponse }) }), reply.data);
        this.assertRepository(pr.base.repo);
        if (pr.number !== target.prNumber || pr.head.sha !== target.headSha || pr.base.sha !== target.baseSha
          || (candidateSha !== undefined && pr.merge_commit_sha !== candidateSha)) throw ciUnavailable();
        if (currentBaseRef !== undefined && pr.base.ref !== currentBaseRef) throw ciUnavailable();
        currentBaseRef = pr.base.ref;
        const branch = await request(`${this.route}/branches/${encodeURIComponent(pr.base.ref)}`, this.token);
        if (branch.status !== 200) throw ciUnavailable();
        const tip = parse(branchTipSchema, branch.data);
        if (tip.name !== pr.base.ref || tip.commit.sha !== target.baseSha) throw ciUnavailable();
        candidateSha = pr.merge_commit_sha;
      };
      await current();
      const reply = await request(`${this.route}/git/commits/${candidateSha}`, this.token);
      if (reply.status !== 200) throw ciUnavailable();
      const commit = parse(z.object({ sha, parents: z.array(z.object({ sha })).length(2) }), reply.data);
      if (commit.sha !== candidateSha || commit.parents[0].sha !== target.baseSha || commit.parents[1].sha !== target.headSha
        || candidateSha === target.baseSha || candidateSha === target.headSha) throw ciUnavailable();
      await current();
      return { ...this.repository, ...target, candidateSha: commit.sha };
    });
  }
}
