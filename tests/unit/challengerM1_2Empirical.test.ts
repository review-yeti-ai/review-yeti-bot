import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PostgresReviewDispatchRepository as DurablePostgresReviewDispatchRepository,
  type ReviewDispatchRepositoryOptions,
} from '../../src/persistence/reviewDispatchRepository';
import {
  createGitHubWebhookAdmissionHandler,
  extractLabelNames,
  hasOptInLabel,
  hasOptOutLabel,
  isOptInLabel,
  isOptOutLabel,
  OPT_IN_LABELS,
  OPT_OUT_LABELS,
} from '../../src/review/githubWebhookAdmission';
import { buildReviewRunIdentity } from '../../src/review/reviewAdmission';
import { DEFAULT_AUTO_REVIEW_TRIGGERS } from '../../src/config/schema';
import { isTriggerActionAllowed, normalizeRawConfigToV3 } from '../../src/config/configLoader';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

class PostgresReviewDispatchRepository extends DurablePostgresReviewDispatchRepository {
  constructor(pool: any, queryable?: any, options: Partial<ReviewDispatchRepositoryOptions> = {}) {
    super(pool, queryable, { lifecycleEvents: 'disabled', ...options });
  }
}

const SECRET = 'empirical-test-webhook-secret-32-bytes-long';
const BASE_NOW = Date.parse('2026-09-18T12:00:00.000Z');
const HEAD_SHA_1 = '1111111111111111111111111111111111111111';
const HEAD_SHA_2 = '2222222222222222222222222222222222222222';
const HEAD_SHA_3 = '3333333333333333333333333333333333333333';
const BASE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface MockDbState {
  runs: Map<string, any>;
  outbox: Map<string, any>;
  deliveries: Map<string, any>;
}

function createMockDb() {
  const state: MockDbState = {
    runs: new Map(),
    outbox: new Map(),
    deliveries: new Map(),
  };

  const query = vi.fn(async (sql: string, values?: any[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql) || /SELECT pg_advisory_xact_lock/u.test(sql)) {
      return { rows: [] };
    }

    if (/SELECT run_id, attempt, status, authoritative_gate_app_id, received_at FROM review_runs WHERE delivery_id = \$1/u.test(sql)) {
      const deliveryId = values?.[0];
      for (const run of state.runs.values()) {
        if (run.delivery_id === deliveryId) return { rows: [run] };
      }
      return { rows: [] };
    }

    if (/SELECT burst_started_at, received_at\s+FROM review_runs\s+WHERE owner = \$1 AND repo = \$2 AND pr_number = \$3/u.test(sql)) {
      const [owner, repo, prNumber] = values || [];
      const matching = Array.from(state.runs.values()).filter(
        r => r.owner === owner && r.repo === repo && r.pr_number === prNumber
      );
      matching.sort((a, b) => {
        const aRec = a.received_at ? new Date(a.received_at).getTime() : 0;
        const bRec = b.received_at ? new Date(b.received_at).getTime() : 0;
        if (bRec !== aRec) return bRec - aRec;
        const aCre = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bCre = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bCre - aCre;
      });
      return { rows: matching.slice(0, 1) };
    }

    if (/INSERT INTO github_deliveries/u.test(sql)) {
      const deliveryId = values?.[0];
      state.deliveries.set(deliveryId, { delivery_id: deliveryId });
      return { rows: [{ delivery_id: deliveryId }] };
    }

    if (/INSERT INTO review_runs/u.test(sql)) {
      const [
        runId, identityDigest, owner, repo, prNumber, headSha, baseSha,
        snapshotDigest, configDigest, effectivePolicyDigest, indexEpoch,
        identityStr, repositoryId, installationId, deliveryId, receivedAt,
        terminalDeadline, publicationMode, authoritativeGateAppId,
        retryRequested, retryAfterExecutionAttempt, reaperFailureText, burstStartedAt,
      ] = values || [];

      let run = state.runs.get(identityDigest);
      if (!run) {
        run = {
          run_id: runId,
          identity_digest: identityDigest,
          owner, repo, pr_number: prNumber, head_sha: headSha, base_sha: baseSha,
          snapshot_digest: snapshotDigest,
          config_digest: configDigest,
          effective_policy_digest: effectivePolicyDigest,
          effective_config_digest: configDigest,
          index_epoch: indexEpoch,
          identity: typeof identityStr === 'string' ? JSON.parse(identityStr) : identityStr,
          status: 'queued',
          stage: 'admission',
          attempt: 0,
          artifacts: {},
          repository_id: repositoryId,
          installation_id: installationId,
          delivery_id: deliveryId,
          received_at: new Date(receivedAt),
          terminal_deadline: new Date(terminalDeadline),
          publication_mode: publicationMode,
          authoritative_gate_app_id: authoritativeGateAppId,
          burst_started_at: new Date(burstStartedAt),
          created_at: new Date(receivedAt),
          updated_at: new Date(receivedAt),
          error_text: null,
        };
        state.runs.set(identityDigest, run);
      } else {
        run.updated_at = new Date(receivedAt);
        if (!run.burst_started_at) {
          run.burst_started_at = new Date(burstStartedAt);
        }
      }
      return { rows: [{ ...run, retry_from_reaper_failure: false }] };
    }

    if (/WITH superseded AS/u.test(sql)) {
      const [owner, repo, prNumber, identityDigest, nowMs] = values || [];
      const supersededRunIds: string[] = [];
      for (const run of state.runs.values()) {
        if (
          run.owner === owner &&
          run.repo === repo &&
          run.pr_number === prNumber &&
          run.identity_digest !== identityDigest &&
          ['queued', 'running', 'publishing', 'failed', 'terminal'].includes(run.status)
        ) {
          run.status = 'superseded';
          run.error_text = 'superseded by a newer review identity';
          run.updated_at = new Date(nowMs);
          supersededRunIds.push(run.run_id);
          const outboxEntry = state.outbox.get(run.run_id);
          if (outboxEntry) {
            outboxEntry.status = 'terminal';
            outboxEntry.updated_at = new Date(nowMs);
          }
        }
      }
      return { rows: supersededRunIds.map(run_id => ({ run_id })) };
    }

    if (/UPDATE github_deliveries SET run_id/u.test(sql)) {
      return { rows: [] };
    }

    if (/INSERT INTO review_dispatch_outbox/u.test(sql)) {
      const [runId, deliveryId, receivedAt, terminalDeadline, availableAt] = values || [];
      let entry = state.outbox.get(runId);
      if (!entry) {
        entry = {
          run_id: runId,
          delivery_id: deliveryId,
          status: 'pending',
          available_at: new Date(availableAt),
          created_at: new Date(receivedAt),
          updated_at: new Date(receivedAt),
          execution_attempt: 0,
        };
        state.outbox.set(runId, entry);
      } else {
        entry.status = 'pending';
        entry.delivery_id = deliveryId;
        entry.available_at = new Date(availableAt);
        entry.updated_at = new Date(receivedAt);
      }
      return { rows: [] };
    }

    if (/SELECT outbox\.run_id\s+FROM review_dispatch_outbox AS outbox\s+JOIN review_runs AS runs/u.test(sql)) {
      const [repositoryId, prNumber, headSha] = values || [];
      for (const run of state.runs.values()) {
        if (
          run.repository_id === repositoryId &&
          run.pr_number === prNumber &&
          (!headSha || run.head_sha === headSha) &&
          run.status === 'queued'
        ) {
          const ob = state.outbox.get(run.run_id);
          if (ob && ob.status === 'pending') {
            return { rows: [{ run_id: run.run_id }] };
          }
        }
      }
      return { rows: [] };
    }

    if (/UPDATE review_dispatch_outbox\s+SET available_at = to_timestamp\(\$2 \/ 1000\.0\)/u.test(sql)) {
      const [runId, nowMs] = values || [];
      const ob = state.outbox.get(runId);
      if (ob) {
        ob.available_at = new Date(nowMs);
        ob.updated_at = new Date(nowMs);
      }
      return { rows: [] };
    }

    if (/UPDATE review_runs AS runs\s+SET status = 'cancelled'/u.test(sql)) {
      const [repositoryId, prNumber, nowMs, cancelReason] = values || [];
      const cancelledRunIds: string[] = [];
      for (const run of state.runs.values()) {
        if (
          run.repository_id === repositoryId &&
          run.pr_number === prNumber &&
          ['queued', 'running', 'publishing'].includes(run.status)
        ) {
          run.status = 'cancelled';
          run.stage = 'complete';
          run.error_text = cancelReason;
          run.updated_at = new Date(nowMs);
          cancelledRunIds.push(run.run_id);
          const ob = state.outbox.get(run.run_id);
          if (ob) {
            ob.status = 'terminal';
            ob.updated_at = new Date(nowMs);
          }
        }
      }
      return { rows: cancelledRunIds.map(run_id => ({ run_id })) };
    }

    if (/SELECT runs\.run_id/u.test(sql) || /SELECT .* FROM review_runs WHERE run_id/u.test(sql)) {
      const runId = values?.[0];
      for (const run of state.runs.values()) {
        if (run.run_id === runId) return { rows: [run] };
      }
      return { rows: [] };
    }

    return { rows: [] };
  });

  const pool = {
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
    query,
  };

  return { state, query, pool };
}

function sampleInput(overrides: Record<string, any> = {}) {
  const headSha = overrides.headSha || HEAD_SHA_1;
  const identity = buildReviewRunIdentity({
    owner: 'calltelemetry',
    repo: 'dashboard',
    prNumber: overrides.prNumber || 42,
    headSha,
    baseSha: BASE_SHA,
  });
  return {
    deliveryId: overrides.deliveryId || `delivery-${headSha.slice(0, 8)}-${Date.now()}`,
    eventName: 'pull_request',
    repositoryId: 614653796,
    installationId: 456,
    receivedAt: overrides.receivedAt ?? BASE_NOW,
    terminalDeadline: (overrides.receivedAt ?? BASE_NOW) + TERMINAL_DEADLINE_MS,
    payloadDigest: 'a'.repeat(64),
    publicationMode: 'app-gate' as const,
    centralActionDispatch: false,
    debounce: overrides.debounce,
    identity,
    ...overrides,
  };
}

function makeWebhookEvent(eventName: string, action: string, overrides: Record<string, any> = {}) {
  const delivery = overrides.delivery || `delivery-${action}-${Date.now()}-${Math.random()}`;
  const body = {
    action,
    number: overrides.prNumber || 42,
    installation: overrides.hasInstallation === false ? undefined : { id: 456 },
    repository: overrides.hasRepo === false ? undefined : {
      id: 614653796,
      name: 'dashboard',
      full_name: 'calltelemetry/dashboard',
      owner: { id: 57884877, login: 'calltelemetry' },
    },
    pull_request: overrides.hasPr === false ? undefined : {
      number: overrides.prNumber || 42,
      state: overrides.prState || 'open',
      draft: overrides.draft ?? false,
      head: { sha: overrides.headSha || HEAD_SHA_1 },
      base: { sha: BASE_SHA, repo: { full_name: 'calltelemetry/dashboard' } },
      labels: overrides.rawLabels !== undefined ? overrides.rawLabels : (overrides.labels || []).map((name: string) => ({ name })),
    },
    ...overrides.extraPayload,
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature256 = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  return { deliveryId: delivery, delivery, eventName, rawBody, body, signature256 };
}

describe('Challenger M1-2 Empirical Stress & Adversarial Suite', () => {
  const webhookConfig = {
    secret: SECRET,
    admissionEnabled: true,
    repositoryIds: new Set(['614653796']),
    ownerIds: new Set(['57884877']),
  };

  describe('Suite 1: On-Demand /review and Opt-In Label Debounce Advance Verification', () => {
    it('advances pending debounced outbox row immediately on exact /review comment', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Step 1: establish debounced synchronize push
      const admissionRes = await repo.admit(sampleInput({ debounce: true, receivedAt: BASE_NOW }));
      const runId = admissionRes.run.runId;
      const initialOutbox = state.outbox.get(runId);
      expect(initialOutbox.available_at.getTime()).toBe(BASE_NOW + 60_000);

      // Step 2: comment with /review arrives 15 seconds later
      const advanceTime = BASE_NOW + 15_000;
      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => advanceTime,
      });

      const commentEvent = makeWebhookEvent('issue_comment', 'created', {
        extraPayload: {
          comment: { body: 'Please take a look:\n/review\nThanks!' },
          issue: {
            number: 42,
            state: 'open',
            pull_request: { head: { sha: HEAD_SHA_1 } },
          },
        },
      });

      const res = await handler(commentEvent);
      expect(res.status).toBe('accepted');
      expect((res as any).reason).toBe('debounce_advanced');
      expect((res as any).headSha).toBe(HEAD_SHA_1);

      // Verify outbox was advanced to advanceTime
      const updatedOutbox = state.outbox.get(runId);
      expect(updatedOutbox.available_at.getTime()).toBe(advanceTime);
    });

    it('handles /review case-insensitively and with leading/trailing whitespace and punctuation', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const variants = [
        '/REVIEW',
        '   /review   ',
        '\n\t/review\t\n',
        'Hey team, /review please!',
        '@review-yeti',
        '@REVIEW-YETI',
        '@ct-review',
        '@CT-REVIEW-BOT',
        '@review-yeti-bot review this PR',
      ];

      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        const sha = `11111111111111111111111111111111111111${String(i).padStart(2, '0')}`;
        await repo.admit(sampleInput({ headSha: sha, debounce: true, receivedAt: BASE_NOW }));

        const advanceTime = BASE_NOW + 10_000 + i * 1000;
        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => advanceTime,
        });

        const event = makeWebhookEvent('issue_comment', 'created', {
          extraPayload: {
            comment: { body: variant },
            issue: {
              number: 42,
              state: 'open',
              pull_request: { head: { sha } },
            },
          },
        });

        const res = await handler(event);
        expect(res.status).toBe('accepted');
        expect((res as any).reason).toBe('debounce_advanced');
      }
    });

    it('rejects regular comments or pseudo-commands without advancing debounce', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      await repo.admit(sampleInput({ debounce: true, receivedAt: BASE_NOW }));

      const nonCommands = [
        'LGTM',
        'Looks good to me!',
        '/preview',
        'review this please',
        'can we get a review?',
        '/reviews are cool',
      ];

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW + 10_000,
      });

      for (const body of nonCommands) {
        const event = makeWebhookEvent('issue_comment', 'created', {
          extraPayload: {
            comment: { body },
            issue: {
              number: 42,
              state: 'open',
              pull_request: { head: { sha: HEAD_SHA_1 } },
            },
          },
        });

        const res = await handler(event);
        expect(res.status).toBe('ignored');
        expect((res as any).reason).toBe('not_review_command');
      }

      // Outbox remains at original 60s debounce
      const outbox = state.outbox.values().next().value;
      expect(outbox.available_at.getTime()).toBe(BASE_NOW + 60_000);
    });

    it('advances pending debounced outbox row when opt-in label is added', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      await repo.admit(sampleInput({ debounce: true, receivedAt: BASE_NOW }));

      const optInVariants = [
        'review-yeti',
        'REVIEW-YETI',
        '  ct-review  ',
        'CT-REVIEW',
        'ai-review',
        'AI-REVIEW',
      ];

      for (let i = 0; i < optInVariants.length; i++) {
        const label = optInVariants[i];
        const sha = `22222222222222222222222222222222222222${String(i).padStart(2, '0')}`;
        const input = sampleInput({ headSha: sha, debounce: true, receivedAt: BASE_NOW });
        const adm = await repo.admit(input);

        const advanceTime = BASE_NOW + 20_000;
        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => advanceTime,
        });

        const event = makeWebhookEvent('pull_request', 'labeled', {
          headSha: sha,
          extraPayload: {
            label: { name: label },
          },
        });

        const res = await handler(event);
        expect(res.status).toBe('accepted');
        expect((res as any).reason).toBe('debounce_advanced');
        expect(state.outbox.get(adm.run.runId).available_at.getTime()).toBe(advanceTime);
      }
    });

    it('admits immediately with debounce: false when /review or opt-in label arrives and NO outbox row is pending', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      // On-demand comment on a PR that has no prior run
      const commentEvent = makeWebhookEvent('issue_comment', 'created', {
        headSha: HEAD_SHA_2,
        extraPayload: {
          comment: { body: '/review' },
          issue: {
            number: 42,
            state: 'open',
            pull_request: { head: { sha: HEAD_SHA_2 }, base: { sha: BASE_SHA } },
          },
        },
      });

      const res = await handler(commentEvent);
      expect(res.status).toBe('accepted');
      expect(res.headSha).toBe(HEAD_SHA_2);

      // Verify outbox entry was created with available_at = BASE_NOW (zero delay)
      const outboxRows = Array.from(state.outbox.values());
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].available_at.getTime()).toBe(BASE_NOW);
    });

    it('rejects /review on closed pull requests', async () => {
      const { pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      const closedEvent = makeWebhookEvent('issue_comment', 'created', {
        extraPayload: {
          comment: { body: '/review' },
          issue: {
            number: 42,
            state: 'closed',
            pull_request: { head: { sha: HEAD_SHA_1 } },
          },
        },
      });

      const res = await handler(closedEvent);
      expect(res.status).toBe('ignored');
      expect((res as any).reason).toBe('pull_request_not_open');
    });

    it('empirically examines behavior when opt-in label is added to a closed PR', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      const closedEvent = makeWebhookEvent('pull_request', 'labeled', {
        prState: 'closed',
        extraPayload: {
          label: { name: 'review-yeti' },
        },
      });

      const res = await handler(closedEvent);
      // githubWebhookAdmission:461-538 checks pr.draft === true, but does not check pr.state === 'closed'
      expect(res.status).toBe('accepted');
    });

    it('rejects /review on non-PR issue comments', async () => {
      const { pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      const issueOnlyEvent = makeWebhookEvent('issue_comment', 'created', {
        hasPr: false,
        extraPayload: {
          comment: { body: '/review' },
          issue: {
            number: 99,
            state: 'open',
            // Notice: no pull_request property
          },
        },
      });

      const res = await handler(issueOnlyEvent);
      expect(res.status).toBe('ignored');
      expect((res as any).reason).toBe('comment_not_on_pull_request');
    });
  });

  describe('Suite 2: Repository Config auto_review.triggers Matrix Stress Tests', () => {
    describe('triggers: [pr_ready]', () => {
      const readyOnly = ['pr_ready'];

      it('allows ready_for_review and pr_ready actions', () => {
        expect(isTriggerActionAllowed(readyOnly, 'ready_for_review')).toBe(true);
        expect(isTriggerActionAllowed(readyOnly, 'pr_ready')).toBe(true);
      });

      it('rejects synchronize, opened, reopened, comment, and labeled actions', () => {
        expect(isTriggerActionAllowed(readyOnly, 'synchronize')).toBe(false);
        expect(isTriggerActionAllowed(readyOnly, 'opened')).toBe(false);
        expect(isTriggerActionAllowed(readyOnly, 'reopened')).toBe(false);
        expect(isTriggerActionAllowed(readyOnly, 'issue_comment', { isCommand: true })).toBe(false);
        expect(isTriggerActionAllowed(readyOnly, 'labeled', { isTag: true })).toBe(false);
      });

      it('end-to-end webhook admission respects pr_ready trigger gating', async () => {
        const { pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);

        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => BASE_NOW,
          resolveRepositoryConfig: async () => ({
            auto_review: { enabled: true, triggers: readyOnly },
          } as any),
        });

        // 1. synchronize should be ignored
        const syncRes = await handler(makeWebhookEvent('pull_request', 'synchronize'));
        expect(syncRes.status).toBe('ignored');
        expect((syncRes as any).reason).toBe('trigger_not_configured');

        // 2. opened should be ignored
        const openRes = await handler(makeWebhookEvent('pull_request', 'opened'));
        expect(openRes.status).toBe('ignored');
        expect((openRes as any).reason).toBe('trigger_not_configured');

        // 3. ready_for_review should be accepted
        const readyRes = await handler(makeWebhookEvent('pull_request', 'ready_for_review'));
        expect(readyRes.status).toBe('accepted');
      });
    });

    describe('triggers: [@ct-review]', () => {
      const ctReviewOnly = ['@ct-review'];

      it('allows issue_comment command and labeled action', () => {
        expect(isTriggerActionAllowed(ctReviewOnly, 'issue_comment', { isCommand: true })).toBe(true);
        expect(isTriggerActionAllowed(ctReviewOnly, 'labeled', { isTag: true })).toBe(true);
      });

      it('rejects automatic PR events', () => {
        expect(isTriggerActionAllowed(ctReviewOnly, 'synchronize')).toBe(false);
        expect(isTriggerActionAllowed(ctReviewOnly, 'opened')).toBe(false);
        expect(isTriggerActionAllowed(ctReviewOnly, 'reopened')).toBe(false);
        expect(isTriggerActionAllowed(ctReviewOnly, 'ready_for_review')).toBe(false);
      });

      it('end-to-end webhook admission respects @ct-review trigger gating', async () => {
        const { pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);

        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => BASE_NOW,
          resolveRepositoryConfig: async () => ({
            auto_review: { enabled: true, triggers: ctReviewOnly },
          } as any),
        });

        // Push should be ignored
        const syncRes = await handler(makeWebhookEvent('pull_request', 'synchronize'));
        expect(syncRes.status).toBe('ignored');
        expect((syncRes as any).reason).toBe('trigger_not_configured');

        // /review comment should be admitted
        const commentEvent = makeWebhookEvent('issue_comment', 'created', {
          extraPayload: {
            comment: { body: '/review' },
            issue: {
              number: 42,
              state: 'open',
              pull_request: { head: { sha: HEAD_SHA_1 }, base: { sha: BASE_SHA } },
            },
          },
        });
        const commentRes = await handler(commentEvent);
        expect(commentRes.status).toBe('accepted');
      });
    });

    describe('triggers: [tag]', () => {
      const tagOnly = ['tag'];

      it('allows labeled action with isTag: true', () => {
        expect(isTriggerActionAllowed(tagOnly, 'labeled', { isTag: true })).toBe(true);
      });

      it('rejects synchronize, opened, ready_for_review, and comments', () => {
        expect(isTriggerActionAllowed(tagOnly, 'synchronize')).toBe(false);
        expect(isTriggerActionAllowed(tagOnly, 'opened')).toBe(false);
        expect(isTriggerActionAllowed(tagOnly, 'reopened')).toBe(false);
        expect(isTriggerActionAllowed(tagOnly, 'ready_for_review')).toBe(false);
        expect(isTriggerActionAllowed(tagOnly, 'issue_comment', { isCommand: true })).toBe(false);
      });
    });

    describe('triggers: [pr_opened]', () => {
      const prOpenedOnly = ['pr_opened'];

      it('allows opened, reopened, and ready_for_review', () => {
        expect(isTriggerActionAllowed(prOpenedOnly, 'opened')).toBe(true);
        expect(isTriggerActionAllowed(prOpenedOnly, 'pr_opened')).toBe(true);
        expect(isTriggerActionAllowed(prOpenedOnly, 'reopened')).toBe(true);
        expect(isTriggerActionAllowed(prOpenedOnly, 'ready_for_review')).toBe(true);
      });

      it('rejects synchronize, comments, and labeled events', () => {
        expect(isTriggerActionAllowed(prOpenedOnly, 'synchronize')).toBe(false);
        expect(isTriggerActionAllowed(prOpenedOnly, 'issue_comment', { isCommand: true })).toBe(false);
        expect(isTriggerActionAllowed(prOpenedOnly, 'labeled', { isTag: true })).toBe(false);
      });
    });

    describe('triggers: [] (empty triggers array - empirical evaluation)', () => {
      it('empirically demonstrates that triggers: [] falls back to DEFAULT_AUTO_REVIEW_TRIGGERS', () => {
        // Line 342 of configLoader.ts:
        // const effective = (!triggers || triggers.length === 0) ? DEFAULT_AUTO_REVIEW_TRIGGERS : triggers;
        expect(isTriggerActionAllowed([], 'synchronize')).toBe(true);
        expect(isTriggerActionAllowed([], 'opened')).toBe(true);
        expect(isTriggerActionAllowed([], 'ready_for_review')).toBe(true);
        expect(isTriggerActionAllowed([], 'issue_comment', { isCommand: true })).toBe(true);
        expect(isTriggerActionAllowed([], 'labeled', { isTag: true })).toBe(true);
      });

      it('end-to-end webhook admission with triggers: [] allows default triggers', async () => {
        const { pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);

        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => BASE_NOW,
          resolveRepositoryConfig: async () => ({
            auto_review: { enabled: true, triggers: [] },
          } as any),
        });

        const syncRes = await handler(makeWebhookEvent('pull_request', 'synchronize'));
        expect(syncRes.status).toBe('accepted');
      });
    });
  });

  describe('Suite 3: Unlabeled Event Re-Admitting Open PR When Opt-Out Label Removed', () => {
    it('admits immediately with debounce: false when wip opt-out label is removed', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      const unlabeledEvent = makeWebhookEvent('pull_request', 'unlabeled', {
        headSha: HEAD_SHA_1,
        labels: [], // No remaining labels
        extraPayload: {
          label: { name: 'wip' },
        },
      });

      const res = await handler(unlabeledEvent);
      expect(res.status).toBe('accepted');
      expect((res as any).reason).toBe('opt_out_label_removed');
      expect((res as any).prNumber).toBe(42);

      // Verify outbox entry created with zero debounce delay
      const outboxRows = Array.from(state.outbox.values());
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].available_at.getTime()).toBe(BASE_NOW);
    });

    it('admits when review-yeti:skip or skip-review is removed case-insensitively', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      const labelsToTest = [
        'REVIEW-YETI:SKIP',
        '  review-yeti:skip  ',
        'SKIP-REVIEW',
        'Skip-Review',
      ];

      for (let i = 0; i < labelsToTest.length; i++) {
        const labelName = labelsToTest[i];
        const sha = `33333333333333333333333333333333333333${String(i).padStart(2, '0')}`;

        const event = makeWebhookEvent('pull_request', 'unlabeled', {
          headSha: sha,
          labels: [],
          extraPayload: {
            label: { name: labelName },
          },
        });

        const res = await handler(event);
        expect(res.status).toBe('accepted');
        expect((res as any).reason).toBe('opt_out_label_removed');
      }
    });

    it('suppresses admission if another opt-out label remains on the PR', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      // 'wip' is removed, but 'review-yeti:skip' is still in pull_request.labels
      const event = makeWebhookEvent('pull_request', 'unlabeled', {
        labels: ['review-yeti:skip'],
        extraPayload: {
          label: { name: 'wip' },
        },
      });

      const res = await handler(event);
      expect(res.status).toBe('ignored');
      expect((res as any).reason).toBe('opt_out_label_present');
      expect(state.runs.size).toBe(0);
    });

    it('ignores unlabeled event when an unrelated label (e.g. bug) is removed', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'unlabeled', {
        labels: [],
        extraPayload: {
          label: { name: 'bug' },
        },
      });

      const res = await handler(event);
      expect(res.status).toBe('ignored');
      expect((res as any).reason).toBe('unsupported_pull_request_state');
      expect(state.runs.size).toBe(0);
    });

    it('suppresses admission on unlabeled event if PR is a draft', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'unlabeled', {
        draft: true,
        labels: [],
        extraPayload: {
          label: { name: 'wip' },
        },
      });

      const res = await handler(event);
      expect(res.status).toBe('ignored');
      expect((res as any).reason).toBe('draft_pr');
      expect(state.runs.size).toBe(0);
    });

    it('empirically examines behavior when opt-out label is removed on a closed PR', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'unlabeled', {
        prState: 'closed',
        labels: [],
        extraPayload: {
          label: { name: 'wip' },
        },
      });

      const res = await handler(event);
      // Documenting empirical observation: githubWebhookAdmission:541-601
      // does not check pr.state === 'closed', so it admits!
      expect(res.status).toBe('accepted');
      expect((res as any).reason).toBe('opt_out_label_removed');
    });

    it('suppresses admission on unlabeled event if auto_review.enabled is false', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
        resolveRepositoryConfig: async () => ({
          auto_review: { enabled: false },
        } as any),
      });

      const event = makeWebhookEvent('pull_request', 'unlabeled', {
        labels: [],
        extraPayload: {
          label: { name: 'wip' },
        },
      });

      const res = await handler(event);
      expect(res.status).toBe('ignored');
      expect((res as any).reason).toBe('auto_review_disabled');
      expect(state.runs.size).toBe(0);
    });

    it('suppresses admission on unlabeled event if repo triggers do not include synchronize', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const handler = createGitHubWebhookAdmissionHandler({
        config: webhookConfig,
        admission: repo,
        now: () => BASE_NOW,
        resolveRepositoryConfig: async () => ({
          auto_review: { enabled: true, triggers: ['pr_ready'] },
        } as any),
      });

      const event = makeWebhookEvent('pull_request', 'unlabeled', {
        labels: [],
        extraPayload: {
          label: { name: 'wip' },
        },
      });

      const res = await handler(event);
      expect(res.status).toBe('ignored');
      expect((res as any).reason).toBe('trigger_not_configured');
      expect(state.runs.size).toBe(0);
    });
  });

  describe('Suite 4: Edge Cases: Clock Skew, Malformed Labels & Case Sensitivity', () => {
    describe('Clock Skew & Negative Intervals in Repository Debounce', () => {
      it('handles negative clock skew (incoming commit with earlier receivedAt timestamp) without crash', async () => {
        const { state, pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);

        // Commit 1 at T=100_000
        const c1 = await repo.admit(sampleInput({
          headSha: HEAD_SHA_1,
          debounce: true,
          receivedAt: BASE_NOW + 100_000,
        }));
        expect(state.outbox.get(c1.run.runId).available_at.getTime()).toBe(BASE_NOW + 160_000);

        // Commit 2 arrives with clock skew: receivedAt is 10s earlier than Commit 1 (T=90_000)
        // (input.receivedAt - priorBurst) = -10_000 < 0
        const c2 = await repo.admit(sampleInput({
          headSha: HEAD_SHA_2,
          debounce: true,
          receivedAt: BASE_NOW + 90_000,
        }));

        // Because interval is negative, it treats it as a new burst starting at T=90_000
        // available_at = receivedAt + 60s = BASE_NOW + 150_000
        expect(state.outbox.get(c2.run.runId).available_at.getTime()).toBe(BASE_NOW + 150_000);
      });

      it('handles exact zero delta between subsequent pushes', async () => {
        const { state, pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);

        // Commit 1 at BASE_NOW
        await repo.admit(sampleInput({
          headSha: HEAD_SHA_1,
          debounce: true,
          receivedAt: BASE_NOW,
        }));

        // Commit 2 at identical millisecond BASE_NOW
        const c2 = await repo.admit(sampleInput({
          headSha: HEAD_SHA_2,
          debounce: true,
          receivedAt: BASE_NOW,
        }));

        expect(state.outbox.get(c2.run.runId).available_at.getTime()).toBe(BASE_NOW + 60_000);
      });

      it('resets burst window at boundary conditions (300,000ms vs 300,001ms)', async () => {
        const { state, pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);

        // Burst starts at BASE_NOW
        await repo.admit(sampleInput({
          headSha: HEAD_SHA_1,
          debounce: true,
          receivedAt: BASE_NOW,
        }));

        // Push exactly at 300,000ms (5m 0s) -> still within burst window, clamped to burst + 300s
        const pushBoundary = await repo.admit(sampleInput({
          headSha: HEAD_SHA_2,
          debounce: true,
          receivedAt: BASE_NOW + 300_000,
        }));
        expect(state.outbox.get(pushBoundary.run.runId).available_at.getTime()).toBe(BASE_NOW + 300_000);

        // Push at 300,001ms -> exceeds burst window, resets burst_started_at
        const pushAfter = await repo.admit(sampleInput({
          headSha: HEAD_SHA_3,
          debounce: true,
          receivedAt: BASE_NOW + 300_001,
        }));
        // New burst started at BASE_NOW + 300_001 -> available_at = receivedAt + 60s
        expect(state.outbox.get(pushAfter.run.runId).available_at.getTime()).toBe(BASE_NOW + 300_001 + 60_000);
      });
    });

    describe('Empty and Malformed Labels Array Handling', () => {
      it('extractLabelNames handles non-array and empty inputs safely', () => {
        expect(extractLabelNames(null)).toEqual([]);
        expect(extractLabelNames(undefined)).toEqual([]);
        expect(extractLabelNames('')).toEqual([]);
        expect(extractLabelNames(123)).toEqual([]);
        expect(extractLabelNames({})).toEqual([]);
        expect(extractLabelNames([])).toEqual([]);
      });

      it('extractLabelNames extracts string and object labels and filters falsy values', () => {
        const input = [
          'direct-string',
          { name: 'object-label' },
          null,
          undefined,
          42,
          {},
          { name: '' },
          { other: 'value' },
          { name: 'valid-label' },
        ];
        expect(extractLabelNames(input)).toEqual([
          'direct-string',
          'object-label',
          'valid-label',
        ]);
      });

      it('hasOptOutLabel and hasOptInLabel handle empty arrays without throwing', () => {
        expect(hasOptOutLabel([])).toBe(false);
        expect(hasOptInLabel([])).toBe(false);
      });

      it('admission handler processes PR with empty labels array', async () => {
        const { state, pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);

        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => BASE_NOW,
        });

        const event = makeWebhookEvent('pull_request', 'synchronize', {
          labels: [],
        });

        const res = await handler(event);
        expect(res.status).toBe('accepted');
        expect(state.runs.size).toBe(1);
      });

      it('admission handler processes PR with undefined labels array', async () => {
        const { state, pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);

        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => BASE_NOW,
        });

        const event = makeWebhookEvent('pull_request', 'synchronize', {
          rawLabels: undefined,
        });

        const res = await handler(event);
        expect(res.status).toBe('accepted');
        expect(state.runs.size).toBe(1);
      });
    });

    describe('Case Sensitivity & Trimming Across All Label Functions', () => {
      it('isOptOutLabel matches known opt-out labels regardless of casing or whitespace', () => {
        for (const label of OPT_OUT_LABELS) {
          expect(isOptOutLabel(label)).toBe(true);
          expect(isOptOutLabel(label.toUpperCase())).toBe(true);
          expect(isOptOutLabel(`  ${label}  `)).toBe(true);
          expect(isOptOutLabel(`\t${label.toUpperCase()}\n`)).toBe(true);
        }
        expect(isOptOutLabel('wip')).toBe(true);
        expect(isOptOutLabel('WIP')).toBe(true);
        expect(isOptOutLabel('WiP')).toBe(true);
        expect(isOptOutLabel('review-yeti:skip')).toBe(true);
        expect(isOptOutLabel('REVIEW-YETI:SKIP')).toBe(true);
        expect(isOptOutLabel('skip-review')).toBe(true);
        expect(isOptOutLabel('SKIP-REVIEW')).toBe(true);

        // Near misses should not match
        expect(isOptOutLabel('wip-1')).toBe(false);
        expect(isOptOutLabel('not-wip')).toBe(false);
        expect(isOptOutLabel('review-yeti')).toBe(false);
      });

      it('isOptInLabel matches known opt-in labels regardless of casing or whitespace', () => {
        for (const label of OPT_IN_LABELS) {
          expect(isOptInLabel(label)).toBe(true);
          expect(isOptInLabel(label.toUpperCase())).toBe(true);
          expect(isOptInLabel(`  ${label}  `)).toBe(true);
          expect(isOptInLabel(`\n${label}\t`)).toBe(true);
        }
        expect(isOptInLabel('review-yeti')).toBe(true);
        expect(isOptInLabel('REVIEW-YETI')).toBe(true);
        expect(isOptInLabel('ct-review')).toBe(true);
        expect(isOptInLabel('CT-REVIEW')).toBe(true);
        expect(isOptInLabel('ai-review')).toBe(true);
        expect(isOptInLabel('AI-REVIEW')).toBe(true);

        // Near misses should not match
        expect(isOptInLabel('review-yeti:skip')).toBe(false);
        expect(isOptInLabel('review-yeti-v2')).toBe(false);
      });
    });

    describe('Malformed and Adversarial Payloads', () => {
      it('returns ignored with unsupported_event for null body', async () => {
        const { pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);
        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => BASE_NOW,
        });

        const rawBody = Buffer.from('null');
        const signature256 = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
        const res = await handler({
          deliveryId: 'del-null',
          eventName: 'issue_comment',
          rawBody,
          body: null as any,
          signature256,
        });
        expect(res.status).toBe('ignored');
      });

      it('returns ignored with unsupported_pull_request_state for empty body', async () => {
        const { pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);
        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => BASE_NOW,
        });

        const rawBody = Buffer.from('{}');
        const signature256 = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
        const res = await handler({
          deliveryId: 'del-empty',
          eventName: 'pull_request',
          rawBody,
          body: {},
          signature256,
        });
        expect(res.status).toBe('ignored');
        expect((res as any).reason).toBe('unsupported_pull_request_state');
      });

      it('returns ignored with not_enrolled when repository is not in enrolled list', async () => {
        const { pool } = createMockDb();
        const repo = new PostgresReviewDispatchRepository(pool);
        const handler = createGitHubWebhookAdmissionHandler({
          config: webhookConfig,
          admission: repo,
          now: () => BASE_NOW,
        });

        const event = makeWebhookEvent('pull_request', 'synchronize', {
          extraPayload: {
            repository: {
              id: 999999,
              name: 'other-repo',
              full_name: 'other-org/other-repo',
              owner: { id: 1, login: 'other-org' },
            },
            pull_request: {
              number: 1,
              state: 'open',
              draft: false,
              head: { sha: HEAD_SHA_1 },
              base: { sha: BASE_SHA, repo: { full_name: 'other-org/other-repo' } },
            },
          },
        });

        const res = await handler(event);
        expect(res.status).toBe('ignored');
        expect((res as any).reason).toBe('not_enrolled');
      });
    });
  });
});
