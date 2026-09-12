import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import {
  closeDispatcherMetricsServer,
  createDispatcherMetricsServer,
  listenDispatcherMetricsServer,
} from '../../src/dispatcherMetricsServer';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { PostgresStore } from '../../src/persistence/postgresStore';
import { AbandonedRunReaper } from '../../src/review/abandonedRunReaper';
import { buildReviewRunIdentity } from '../../src/review/reviewAdmission';
import { sha256 } from '../../src/review/reviewCore';
import { initTelemetry } from '../../src/telemetry';

const PUBLISHER_APP_ID = 4_385_771;
const OWNED_SCHEMA = /^review_reaper_acceptance_[a-f0-9]{16}$/u;
const METRIC_NAMES = {
  deliveryIdentityMismatch: 'ct_review_reaper_delivery_identity_mismatch_total',
  supersededAttempt: 'ct_review_reaper_superseded_attempt_total',
} as const;

export interface ReaperMetricSample {
  deliveryIdentityMismatch: number;
  supersededAttempt: number;
}

export interface ReaperBranchReceipt {
  branch: 'delivery_identity_mismatch' | 'superseded_attempt';
  status: string;
  stage: string;
  resultDigest: string | null;
  reason: string;
  terminalClass: string;
  runLeaseOwner: string | null;
  runLeaseExpiresAt: string | null;
  outboxStatus: string;
  outboxLeaseOwner: string | null;
  outboxLeaseExpiresAt: string | null;
}

export interface ReaperLeasePrecondition {
  branch: 'delivery_identity_mismatch' | 'superseded_attempt';
  runId: string;
  outboxStatus: 'projected';
  outboxLeaseOwner: string;
  outboxLeaseExpiresAt: string;
  sweepAt: number;
}

export interface ReaperMetricsAcceptanceReceipt {
  baseline: ReaperMetricSample;
  samples: ReaperMetricSample[];
  branches: ReaperBranchReceipt[];
  leasePreconditions: ReaperLeasePrecondition[];
  githubReadCount: number;
  githubWriteCount: number;
}

export interface ReaperMetricsAcceptanceCleanupFailure {
  name: string;
  error: unknown;
}

export interface ReaperMetricsAcceptanceCleanupStep {
  name: string;
  run(): Promise<void>;
}

export const REAPER_ACCEPTANCE_CLEANUP_FAILURES = Symbol(
  'reaperAcceptanceCleanupFailures',
);

export async function runReaperMetricsAcceptanceCleanup(
  steps: ReaperMetricsAcceptanceCleanupStep[],
  primaryFailure?: { error: unknown },
): Promise<void> {
  const failures: ReaperMetricsAcceptanceCleanupFailure[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push({ name: step.name, error });
    }
  }

  if (primaryFailure) {
    const { error } = primaryFailure;
    if (failures.length > 0 && (typeof error === 'object' && error !== null)) {
      try {
        Object.defineProperty(error, REAPER_ACCEPTANCE_CLEANUP_FAILURES, {
          configurable: true,
          value: failures,
        });
      } catch {
        // A frozen error cannot carry diagnostics; preserving it is more important.
      }
    }
    throw error;
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `REL-817 acceptance cleanup failed: ${failures.map(({ name }) => name).join(', ')}`,
    );
  }
}

function assertDisposableLoopbackDatabase(databaseUrl: string): URL {
  const parsed = new URL(databaseUrl);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !loopbackHosts.has(parsed.hostname)
    || decodeURIComponent(parsed.username) !== 'postgres'
    || parsed.pathname !== '/postgres') {
    throw new Error(
      'REL-817 acceptance requires the postgres user and postgres database on a disposable loopback PostgreSQL service',
    );
  }
  if (parsed.search !== '') {
    throw new Error(
      'REL-817 acceptance database URL must not include connection override parameters',
    );
  }
  return parsed;
}

function metricValue(text: string, metricName: string): number {
  const line = text.split('\n').find((entry) => entry.startsWith(`${metricName} `));
  if (!line) throw new Error(`missing acceptance metric ${metricName}`);
  const value = Number(line.slice(metricName.length + 1));
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid acceptance metric ${metricName}`);
  return value;
}

function admission(round: number, branch: 'mismatch' | 'superseded') {
  const branchOffset = branch === 'mismatch' ? 0 : 1;
  const receivedAt = Date.UTC(2026, 0, 1, 0, round, branchOffset);
  const prNumber = 8_170 + round * 2 + branchOffset;
  const headSha = (round * 2 + branchOffset + 1).toString(16).padStart(40, '0');
  const identity = {
    ...buildReviewRunIdentity({
      owner: 'review-yeti-ai',
      repo: 'review-yeti-bot',
      prNumber,
      headSha,
      baseSha: 'b'.repeat(40),
      configDigest: 'd'.repeat(64),
    }),
    reviewPolicy: {
      version: 'ReviewPolicyIdentity.v1' as const,
      repositoryId: 817,
      effectivePolicyDigest: 'e'.repeat(64),
      sources: [{
        repositoryId: 818,
        repository: 'review-yeti-ai/review-yeti-bot',
        sha: 'c'.repeat(40),
        path: 'review-policy.json',
        contentDigest: 'f'.repeat(64),
      }],
    },
  };
  return {
    deliveryId: `rel817-${branch}-${round}`,
    eventName: 'pull_request',
    repositoryId: 817,
    installationId: 819,
    receivedAt,
    terminalDeadline: receivedAt + 900_000,
    payloadDigest: sha256(identity),
    publicationMode: 'app-gate' as const,
    centralActionDispatch: false,
    identity,
    effectivePolicyDigest: identity.reviewPolicy.effectivePolicyDigest,
  };
}

function nullableTimestamp(value: unknown): string | null {
  if (value == null) return null;
  return new Date(value as string | number | Date).toISOString();
}

export async function runReaperMetricsAcceptance(
  databaseUrl: string,
): Promise<ReaperMetricsAcceptanceReceipt> {
  const parsedDatabaseUrl = assertDisposableLoopbackDatabase(databaseUrl);
  const schema = `review_reaper_acceptance_${randomBytes(8).toString('hex')}`;
  if (!OWNED_SCHEMA.test(schema)) throw new Error('refusing to use an unowned acceptance schema');

  const adminPool = new Pool({ connectionString: parsedDatabaseUrl.toString(), max: 1 });
  const store = new PostgresStore();
  const metricsServer = createDispatcherMetricsServer();
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let serverUrl: string | undefined;
  let schemaCreated = false;
  let receipt: ReaperMetricsAcceptanceReceipt | undefined;
  let operationFailure: { error: unknown } | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;

    const isolatedUrl = new URL(parsedDatabaseUrl);
    isolatedUrl.searchParams.set('application_name', schema);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    process.env.DATABASE_URL = isolatedUrl.toString();
    await store.initialize();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;

    initTelemetry('ct-review-job-dispatcher-rel817-acceptance');
    await listenDispatcherMetricsServer(metricsServer, { host: '127.0.0.1', port: 0 });
    const address = metricsServer.address() as AddressInfo | null;
    if (!address || typeof address === 'string') throw new Error('acceptance metrics listener has no TCP address');
    serverUrl = `http://127.0.0.1:${address.port}`;

    const pool = store.getPool();
    const repository = new PostgresReviewDispatchRepository(pool, undefined, {
      lifecycleEvents: 'enabled',
      validateAuthoritativeAdmission: async () => undefined,
    });
    const githubRequests: Array<{ method: string; url: string }> = [];
    const sweepAt = Date.UTC(2026, 0, 2);
    const expiredOutboxLeaseAt = sweepAt - 60_000;
    const leasePreconditions: ReaperLeasePrecondition[] = [];
    const reaper = new AbandonedRunReaper({
      repository,
      publisherAppId: PUBLISHER_APP_ID,
      workerId: 'rel817-acceptance-reaper',
      limit: 20,
      now: () => sweepAt,
      checkClientFor: async (run) => new GitHubInstallationClient({
        token: 'ghs_rel817_acceptance_only',
        sleep: async () => undefined,
        fetchImplementation: async (input, init) => {
          const method = init?.method || 'GET';
          const url = String(input);
          githubRequests.push({ method, url });
          if (method !== 'GET' || !url.includes('/check-runs?')) {
            return new Response(JSON.stringify({ message: 'writes are forbidden in acceptance' }), { status: 405 });
          }
          const newerCheck = {
            id: Number(`${run.prNumber}01`),
            name: 'Review Yeti',
            head_sha: run.headSha,
            app: { id: PUBLISHER_APP_ID, slug: 'ct-review-bot' },
            external_id: `run_${(run.prNumber + 100).toString(16).padStart(32, '0')}:a2`,
            status: 'completed',
            conclusion: 'success',
            started_at: new Date(run.receivedAt + 2_000).toISOString(),
            completed_at: new Date(run.receivedAt + 3_000).toISOString(),
          };
          return new Response(JSON.stringify({ check_runs: [newerCheck] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    });

    const scrape = async (): Promise<ReaperMetricSample> => {
      const response = await fetch(`${serverUrl}/metrics`);
      if (!response.ok) throw new Error(`acceptance metrics scrape failed with ${response.status}`);
      const text = await response.text();
      return {
        deliveryIdentityMismatch: metricValue(text, METRIC_NAMES.deliveryIdentityMismatch),
        supersededAttempt: metricValue(text, METRIC_NAMES.supersededAttempt),
      };
    };

    const seedPair = async (round: number): Promise<string[]> => {
      const mismatchInput = admission(round, 'mismatch');
      const mismatchAdmission = await repository.admit(mismatchInput);
      if (mismatchAdmission.status !== 'accepted') throw new Error('mismatch acceptance admission was not accepted');
      const outboxDeliveryId = `${mismatchInput.deliveryId}-outbox`;
      await pool.query(`INSERT INTO github_deliveries
        (delivery_id, event_name, repository_id, installation_id, payload_digest, received_at)
        VALUES ($1, 'pull_request', $2, $3, $4, to_timestamp($5 / 1000.0))`, [
        outboxDeliveryId,
        mismatchInput.repositoryId,
        mismatchInput.installationId,
        sha256(outboxDeliveryId),
        mismatchInput.receivedAt,
      ]);
      await pool.query(
        `UPDATE review_dispatch_outbox
            SET delivery_id = $2, status = 'projected', lease_owner = $3,
                lease_expires_at = to_timestamp($4 / 1000.0)
          WHERE run_id = $1`,
        [mismatchAdmission.run.runId, outboxDeliveryId, `rel817-orphan-mismatch-${round}`,
          expiredOutboxLeaseAt],
      );
      await pool.query("UPDATE review_runs SET status = 'running' WHERE run_id = $1", [mismatchAdmission.run.runId]);

      const supersededInput = admission(round, 'superseded');
      const supersededAdmission = await repository.admit(supersededInput);
      if (supersededAdmission.status !== 'accepted') throw new Error('superseded acceptance admission was not accepted');
      await pool.query(
        `UPDATE review_dispatch_outbox
            SET status = 'projected', lease_owner = $2,
                lease_expires_at = to_timestamp($3 / 1000.0)
          WHERE run_id = $1`,
        [supersededAdmission.run.runId, `rel817-orphan-superseded-${round}`, expiredOutboxLeaseAt],
      );
      await pool.query("UPDATE review_runs SET status = 'running' WHERE run_id = $1", [supersededAdmission.run.runId]);

      const expectedLeases = [
        {
          branch: 'delivery_identity_mismatch' as const,
          runId: mismatchAdmission.run.runId,
          owner: `rel817-orphan-mismatch-${round}`,
        },
        {
          branch: 'superseded_attempt' as const,
          runId: supersededAdmission.run.runId,
          owner: `rel817-orphan-superseded-${round}`,
        },
      ];
      const seededLeases = await pool.query(
        `SELECT run_id, status, lease_owner, lease_expires_at
           FROM review_dispatch_outbox
          WHERE run_id = ANY($1::text[])`,
        [expectedLeases.map(({ runId }) => runId)],
      );
      if (seededLeases.rowCount !== expectedLeases.length) {
        throw new Error('acceptance outbox lease precondition rows are incomplete');
      }
      const leaseRows = new Map<string, Record<string, unknown>>(
        seededLeases.rows.map((row: Record<string, unknown>) => [String(row.run_id), row]),
      );
      for (const expected of expectedLeases) {
        const row = leaseRows.get(expected.runId);
        const leaseExpiresAt = nullableTimestamp(row?.lease_expires_at);
        if (row?.status !== 'projected'
          || row.lease_owner !== expected.owner
          || leaseExpiresAt === null
          || Date.parse(leaseExpiresAt) >= sweepAt) {
          throw new Error(`acceptance outbox lease precondition failed for ${expected.runId}`);
        }
        leasePreconditions.push({
          branch: expected.branch,
          runId: expected.runId,
          outboxStatus: 'projected',
          outboxLeaseOwner: expected.owner,
          outboxLeaseExpiresAt: leaseExpiresAt,
          sweepAt,
        });
      }

      const outcome = await reaper.runOnce();
      if (outcome.swept !== 2 || outcome.quarantined !== 1 || outcome.superseded !== 1
        || outcome.published !== 0 || outcome.failed !== 0) {
        throw new Error(`unexpected acceptance reaper outcome ${JSON.stringify(outcome)}`);
      }
      return [mismatchAdmission.run.runId, supersededAdmission.run.runId];
    };

    const baseline = await scrape();
    const runIds = await seedPair(1);
    const samples = [await scrape(), await scrape()];
    runIds.push(...await seedPair(2));
    samples.push(await scrape(), await scrape());

    const branches: ReaperBranchReceipt[] = [];
    for (const runId of runIds) {
      const result = await pool.query(`SELECT
          runs.status,
          runs.stage,
          runs.result_digest,
          runs.failure_diagnostics ->> 'reason' AS reason,
          runs.lease_owner AS run_lease_owner,
          runs.lease_expires_at AS run_lease_expires_at,
          outbox.status AS outbox_status,
          outbox.lease_owner AS outbox_lease_owner,
          outbox.lease_expires_at AS outbox_lease_expires_at,
          terminal.payload -> 'data' ->> 'terminal_class' AS terminal_class
        FROM review_runs AS runs
        JOIN review_dispatch_outbox AS outbox USING (run_id)
        JOIN LATERAL (
          SELECT payload
          FROM review_event_outbox
          WHERE run_id = runs.run_id
            AND event_kind = 'review.lifecycle.terminal'
            AND payload -> 'data' ->> 'terminal_class' IN (
              'delivery_identity_mismatch', 'superseded_by_newer_check'
            )
          ORDER BY sequence DESC
          LIMIT 1
        ) AS terminal ON TRUE
        WHERE runs.run_id = $1`, [runId]);
      if (result.rowCount !== 1) throw new Error(`missing durable acceptance receipt for ${runId}`);
      const row = result.rows[0];
      const terminalClass = String(row.terminal_class);
      branches.push({
        branch: terminalClass === 'delivery_identity_mismatch'
          ? 'delivery_identity_mismatch'
          : 'superseded_attempt',
        status: String(row.status),
        stage: String(row.stage),
        resultDigest: row.result_digest == null ? null : String(row.result_digest),
        reason: String(row.reason),
        terminalClass,
        runLeaseOwner: row.run_lease_owner == null ? null : String(row.run_lease_owner),
        runLeaseExpiresAt: nullableTimestamp(row.run_lease_expires_at),
        outboxStatus: String(row.outbox_status),
        outboxLeaseOwner: row.outbox_lease_owner == null ? null : String(row.outbox_lease_owner),
        outboxLeaseExpiresAt: nullableTimestamp(row.outbox_lease_expires_at),
      });
    }

    receipt = {
      baseline,
      samples,
      branches,
      leasePreconditions,
      githubReadCount: githubRequests.filter(({ method }) => method === 'GET').length,
      githubWriteCount: githubRequests.filter(({ method }) => method !== 'GET').length,
    };
  } catch (error) {
    operationFailure = { error };
  } finally {
    await runReaperMetricsAcceptanceCleanup([
      {
        name: 'DATABASE_URL restoration',
        run: async () => {
          if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = previousDatabaseUrl;
        },
      },
      {
        name: 'metrics server',
        run: async () => closeDispatcherMetricsServer(metricsServer),
      },
      {
        name: 'store',
        run: async () => store.close(),
      },
      {
        name: 'schema',
        run: async () => {
          if (!schemaCreated) return;
          if (!OWNED_SCHEMA.test(schema)) throw new Error('refusing to remove an unowned acceptance schema');
          await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
        },
      },
      {
        name: 'admin pool',
        run: async () => adminPool.end(),
      },
    ], operationFailure);
  }

  if (!receipt) throw new Error('REL-817 acceptance completed without a receipt');
  return receipt;
}
