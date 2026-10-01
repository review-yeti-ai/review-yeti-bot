import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPrNumberFromHeadRef,
  normalizeBaseBranch,
  getConstituentPullRequests,
  verifyConstituentChecks,
  evaluateCompositeDeltaHazards,
  publishMergeGroupCheckRun,
  handleMergeGroupAttestation,
  DEFAULT_REQUIRED_APP_ID,
  REQUIRED_CHECK_NAME,
  type CheckRunRecord,
  type MergeGroupPayload,
} from '../src/mergeGroupAttestation.js';
import worker from '../src/worker.js';
import type { Env } from '../src/types.js';

/**
 * Calculates a valid Web Crypto HMAC-SHA256 signature matching GitHub's X-Hub-Signature-256
 */
async function signPayload(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    REPO_GATE: {} as any,
    REVIEW_RUN: {} as any,
    REVIEW_JOB_WORKFLOW: {} as any,
    REVIEW_DEBOUNCE_QUEUE: {} as any,
    ENVIRONMENT: 'test',
    PARALLEL_MODE: 'false',
    PARALLEL_CHECK_NAME: 'Review Yeti',
    PILOT_REPOSITORIES: 'example-org/sample-repo,example-org/sample-meta',
    DOKS_FALLBACK_URL: '',
    DEFAULT_WORKER_IMAGE: 'test-image',
    GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
    GITHUB_APP_ID: '4385771',
    GITHUB_TOKEN: 'test-token',
    ...overrides,
  };
}

describe('Merge Group Attestation Unit & Integration Tests', () => {
  describe('Helper Parsing & Normalization', () => {
    it('extracts PR number correctly from queue head_ref', () => {
      assert.equal(
        extractPrNumberFromHeadRef('refs/heads/gh-readonly-queue/main/pr-4836-1234abcd'),
        4836
      );
      assert.equal(
        extractPrNumberFromHeadRef('refs/heads/gh-readonly-queue/0.8.4-release/pr-101-abcdef0123456789'),
        101
      );
      assert.equal(extractPrNumberFromHeadRef('invalid-ref'), null);
      assert.equal(extractPrNumberFromHeadRef(''), null);
    });

    it('normalizes base_ref by stripping refs/heads/', () => {
      assert.equal(normalizeBaseBranch('refs/heads/main'), 'main');
      assert.equal(normalizeBaseBranch('main'), 'main');
      assert.equal(normalizeBaseBranch('refs/heads/0.8.4-release'), '0.8.4-release');
      assert.equal(normalizeBaseBranch(''), '');
    });
  });

  describe('GraphQL Queue Resolution & Constituent Verification', () => {
    it('successfully resolves constituent PRs up to current PR position', async () => {
      const mockGraphQLResponse = {
        data: {
          repository: {
            mergeQueue: {
              entries: {
                nodes: [
                  {
                    position: 1,
                    state: 'MERGEABLE',
                    pullRequest: {
                      number: 101,
                      headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                      baseRefOid: '0000000000000000000000000000000000000000',
                    },
                  },
                  {
                    position: 2,
                    state: 'MERGEABLE',
                    pullRequest: {
                      number: 102,
                      headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                      baseRefOid: '0000000000000000000000000000000000000000',
                    },
                  },
                  {
                    position: 3,
                    state: 'MERGEABLE',
                    pullRequest: {
                      number: 103,
                      headRefOid: 'cccccccccccccccccccccccccccccccccccccccc',
                      baseRefOid: '0000000000000000000000000000000000000000',
                    },
                  },
                ],
              },
            },
          },
        },
      };

      const mockFetch: typeof fetch = async (input, init) => {
        return Response.json(mockGraphQLResponse);
      };

      const result = await getConstituentPullRequests({
        owner: 'example-org',
        repo: 'sample-repo',
        baseBranch: 'main',
        currentPrNumber: 102,
        token: 'test-token',
        fetchFn: mockFetch,
      });

      assert.equal(result.passed, true);
      assert.equal(result.prs.length, 2);
      assert.equal(result.prs[0].number, 101);
      assert.equal(result.prs[1].number, 102);
    });

    it('fails closed when current PR is not in merge queue', async () => {
      const mockGraphQLResponse = {
        data: {
          repository: {
            mergeQueue: {
              entries: {
                nodes: [
                  {
                    position: 1,
                    state: 'MERGEABLE',
                    pullRequest: {
                      number: 999,
                      headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                  },
                ],
              },
            },
          },
        },
      };

      const mockFetch: typeof fetch = async () => Response.json(mockGraphQLResponse);

      const result = await getConstituentPullRequests({
        owner: 'example-org',
        repo: 'sample-repo',
        baseBranch: 'main',
        currentPrNumber: 102,
        token: 'test-token',
        fetchFn: mockFetch,
      });

      assert.equal(result.passed, false);
      assert.match(result.blockerReason!, /did not return current PR #102 exactly once/);
    });

    it('fails closed when constituent PR is UNMERGEABLE or LOCKED', async () => {
      const mockGraphQLResponse = {
        data: {
          repository: {
            mergeQueue: {
              entries: {
                nodes: [
                  {
                    position: 1,
                    state: 'UNMERGEABLE',
                    pullRequest: {
                      number: 101,
                      headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                  },
                ],
              },
            },
          },
        },
      };

      const mockFetch: typeof fetch = async () => Response.json(mockGraphQLResponse);

      const result = await getConstituentPullRequests({
        owner: 'example-org',
        repo: 'sample-repo',
        baseBranch: 'main',
        currentPrNumber: 101,
        token: 'test-token',
        fetchFn: mockFetch,
      });

      assert.equal(result.passed, false);
      assert.match(result.blockerReason!, /is not mergeable \(UNMERGEABLE\)/);
    });
  });

  describe('Strict Check Run Verification (App ID 4385771, External ID, Status)', () => {
    const validSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    it('accepts exact App ID 4385771 completed success Review Yeti check', () => {
      const checks: CheckRunRecord[] = [
        {
          id: 100,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-01T12:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a1',
          app: { id: 4385771 },
        },
      ];

      const res = verifyConstituentChecks(checks, 101, validSha, DEFAULT_REQUIRED_APP_ID);
      assert.equal(res.passed, true);
    });

    it('rejects checks from wrong App ID', () => {
      const checks: CheckRunRecord[] = [
        {
          id: 100,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-01T12:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a1',
          app: { id: 999999 }, // Wrong App ID
        },
      ];

      const res = verifyConstituentChecks(checks, 101, validSha, DEFAULT_REQUIRED_APP_ID);
      assert.equal(res.passed, false);
      assert.match(res.blockerReason!, /has no newest successful exact-head Review Yeti check from app 4385771/);
    });

    it('rejects synthetic merge-group external_id as a panel result', () => {
      const checks: CheckRunRecord[] = [
        {
          id: 100,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-01T12:00:00Z',
          external_id: `merge-group:${validSha}`, // Not worker run_* external_id
          app: { id: 4385771 },
        },
      ];

      const res = verifyConstituentChecks(checks, 101, validSha, DEFAULT_REQUIRED_APP_ID);
      assert.equal(res.passed, false);
      assert.match(res.blockerReason!, /has no newest successful exact-head Review Yeti check/);
    });

    it('rejects newer failure after older success', () => {
      const checks: CheckRunRecord[] = [
        {
          id: 100,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-01T10:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a1',
          app: { id: 4385771 },
        },
        {
          id: 101,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-10-01T11:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a2',
          app: { id: 4385771 },
        },
      ];

      const res = verifyConstituentChecks(checks, 101, validSha, DEFAULT_REQUIRED_APP_ID);
      assert.equal(res.passed, false);
      assert.match(res.blockerReason!, /conclusion=failure/);
    });

    it('rejects newer in_progress after older success', () => {
      const checks: CheckRunRecord[] = [
        {
          id: 100,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-01T10:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a1',
          app: { id: 4385771 },
        },
        {
          id: 101,
          name: REQUIRED_CHECK_NAME,
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-10-01T11:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a2',
          app: { id: 4385771 },
        },
      ];

      const res = verifyConstituentChecks(checks, 101, validSha, DEFAULT_REQUIRED_APP_ID);
      assert.equal(res.passed, false);
      assert.match(res.blockerReason!, /status=in_progress/);
    });

    it('accepts newest success after older failure', () => {
      const checks: CheckRunRecord[] = [
        {
          id: 100,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-10-01T10:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a1',
          app: { id: 4385771 },
        },
        {
          id: 101,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-01T11:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a2',
          app: { id: 4385771 },
        },
      ];

      const res = verifyConstituentChecks(checks, 101, validSha, DEFAULT_REQUIRED_APP_ID);
      assert.equal(res.passed, true);
    });

    it('breaks started_at ties with check_run_id deterministically', () => {
      const checks: CheckRunRecord[] = [
        {
          id: 100,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-01T10:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a1',
          app: { id: 4385771 },
        },
        {
          id: 101,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-10-01T10:00:00Z', // Same started_at, higher id (101) wins
          external_id: 'run_1234567890abcdef1234567890abcdef:a2',
          app: { id: 4385771 },
        },
      ];

      const res = verifyConstituentChecks(checks, 101, validSha, DEFAULT_REQUIRED_APP_ID);
      assert.equal(res.passed, false);
      assert.match(res.blockerReason!, /conclusion=failure/);
    });

    it('rejects check run lacking started_at or id', () => {
      const missingStartedAt: CheckRunRecord[] = [
        {
          id: 100,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          external_id: 'run_1234567890abcdef1234567890abcdef:a1',
          app: { id: 4385771 },
        },
      ];
      assert.equal(
        verifyConstituentChecks(missingStartedAt, 101, validSha).passed,
        false
      );

      const missingId: CheckRunRecord[] = [
        {
          id: undefined as any,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-01T10:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a1',
          app: { id: 4385771 },
        },
      ];
      assert.equal(
        verifyConstituentChecks(missingId, 101, validSha).passed,
        false
      );
    });
  });

  describe('Speculative Composite Delta Hazard Scanning', () => {
    it('bypasses scan for clean single-PR queue entry with no base drift', async () => {
      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          {
            number: 101,
            position: 1,
            state: 'MERGEABLE',
            head_sha: '1111111111111111111111111111111111111111',
            base_sha: 'base000000000000000000000000000000000000',
          },
        ],
        queueBaseSha: 'base000000000000000000000000000000000000',
        token: 'test-token',
      });

      assert.equal(result.passed, true);
      assert.equal(result.bypassed, true);
      assert.equal(result.hazards.length, 0);
    });

    it('detects conflicting Ecto migration timestamps across batched PRs', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'priv/repo/migrations/20261001120000_add_user_roles.exs',
              patch: '+ def change do\n+ end',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'priv/repo/migrations/20261001120000_add_tenant_config.exs',
              patch: '+ def change do\n+ end',
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, false);
      assert.equal(result.bypassed, false);
      assert.equal(result.hazards.length, 1);
      assert.equal(result.hazards[0].type, 'migration_collision');
      assert.match(result.hazards[0].description, /Conflicting Ecto migration timestamp "20261001120000"/);
      assert.equal(result.hazards[0].conflictingPrNumber, 101);
      assert.equal(result.hazards[0].prNumber, 102);
    });

    it('detects shared runtime/config file collisions on mix.lock and mcp-servers.json', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            { filename: 'mix.lock', patch: '+ "jason": {:hex, ...}' },
            { filename: 'mcp-servers.json', patch: '+ "test-server": { ... }' },
          ],
        ],
        [
          102,
          [
            { filename: 'mix.lock', patch: '+ "telemetry": {:hex, ...}' },
            { filename: 'mcp-servers.json', patch: '+ "another-server": { ... }' },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, false);
      const collisionFiles = result.hazards.map((h) => h.file);
      assert.ok(collisionFiles.includes('mix.lock'));
      assert.ok(collisionFiles.includes('mcp-servers.json'));
    });

    it('detects incompatible contract changes across batched PRs', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/auth.ex',
              patch: '@@ -10,3 +10,3 @@\n-def authenticate_user(token) do\n+def authenticate_user(token, tenant_id) do',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'lib/cdrcisco/controller.ex',
              patch: '@@ -25,2 +25,3 @@\n+result = authenticate_user(token)',
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, false);
      const contractBreak = result.hazards.find((h) => h.type === 'contract_break');
      assert.ok(contractBreak);
      assert.match(contractBreak.description, /authenticate_user/);
    });

    it('passes cleanly for batched PRs with non-conflicting disjoint diffs', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/feature_a.ex',
              patch: '+ def feature_a, do: :ok',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'lib/cdrcisco/feature_b.ex',
              patch: '+ def feature_b, do: :ok',
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, true);
      assert.equal(result.hazards.length, 0);
    });
  });

  describe('End-to-End Master Attestation Handler (Fast <2s Direct Webhook)', () => {
    it('successfully attests single PR and publishes direct check-run with exact head SHA', async () => {
      const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
      const payload: MergeGroupPayload = {
        action: 'checks_requested',
        merge_group: {
          head_sha: headSha,
          head_ref: 'refs/heads/gh-readonly-queue/main/pr-4836-abcdef01',
          base_ref: 'refs/heads/main',
          base_sha: 'base000000000000000000000000000000000000',
        },
        repository: {
          name: 'sample-repo',
          full_name: 'example-org/sample-repo',
          owner: { login: 'example-org' },
        },
      };

      const publishedCheckRuns: any[] = [];

      const mockFetch: typeof fetch = async (input, init) => {
        const urlStr = typeof input === 'string' ? input : (input as any).url || (input as any).href || String(input);

        // 1. GraphQL mergeQueue query
        if (urlStr.includes('/graphql')) {
          return Response.json({
            data: {
              repository: {
                mergeQueue: {
                  entries: {
                    nodes: [
                      {
                        position: 1,
                        state: 'MERGEABLE',
                        pullRequest: {
                          number: 4836,
                          headRefOid: '1111111111111111111111111111111111111111',
                          baseRefOid: 'base000000000000000000000000000000000000',
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        }

        // 2. Commit check-runs query
        if (urlStr.includes('/check-runs?filter=all')) {
          return Response.json({
            check_runs: [
              {
                id: 501,
                name: REQUIRED_CHECK_NAME,
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-10-01T12:00:00Z',
                external_id: 'run_1234567890abcdef1234567890abcdef:a1',
                app: { id: 4385771 },
              },
            ],
          });
        }

        // 3. Check run publication POST
        if (urlStr.endsWith('/check-runs') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          publishedCheckRuns.push(body);
          return Response.json({ id: 9999, ...body });
        }

        return new Response('Not found', { status: 404 });
      };

      const startTime = Date.now();
      const outcome = await handleMergeGroupAttestation(payload, createMockEnv(), mockFetch);
      const durationMs = Date.now() - startTime;

      assert.ok(durationMs < 2000, `Execution should be sub-2-second (took ${durationMs}ms)`);
      assert.equal(outcome.status, 'attested');
      assert.equal(outcome.conclusion, 'success');
      assert.equal(outcome.headSha, headSha);
      assert.equal(outcome.constituentPrs.length, 1);
      assert.equal(outcome.constituentPrs[0], 4836);
      assert.equal(outcome.bypassedHazardScan, true);

      // Verify direct check-run publication
      assert.equal(publishedCheckRuns.length, 1);
      const published = publishedCheckRuns[0];
      assert.equal(published.name, 'Review Yeti');
      assert.equal(published.head_sha, headSha);
      assert.equal(published.external_id, `merge-group:${headSha}`);
      assert.equal(published.status, 'completed');
      assert.equal(published.conclusion, 'success');
      assert.equal(published.output.title, 'Review Yeti (Merge Group Attestation)');
      assert.match(published.output.summary, /App ID 4385771/);
    });

    it('fails closed and blocks check run when constituent PR lacks Review Yeti check', async () => {
      const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
      const payload: MergeGroupPayload = {
        action: 'checks_requested',
        merge_group: {
          head_sha: headSha,
          head_ref: 'refs/heads/gh-readonly-queue/main/pr-4836-abcdef01',
          base_ref: 'refs/heads/main',
        },
        repository: {
          name: 'sample-repo',
          full_name: 'example-org/sample-repo',
        },
      };

      const publishedCheckRuns: any[] = [];

      const mockFetch: typeof fetch = async (input, init) => {
        const urlStr = typeof input === 'string' ? input : (input as any).url || (input as any).href || String(input);

        if (urlStr.includes('/graphql')) {
          return Response.json({
            data: {
              repository: {
                mergeQueue: {
                  entries: {
                    nodes: [
                      {
                        position: 1,
                        state: 'MERGEABLE',
                        pullRequest: {
                          number: 4836,
                          headRefOid: '1111111111111111111111111111111111111111',
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        }

        // Return empty check runs (no Review Yeti check completed)
        if (urlStr.includes('/check-runs?filter=all')) {
          return Response.json({ check_runs: [] });
        }

        if (urlStr.endsWith('/check-runs') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          publishedCheckRuns.push(body);
          return Response.json({ id: 9999, ...body });
        }

        return new Response('Not found', { status: 404 });
      };

      const outcome = await handleMergeGroupAttestation(payload, createMockEnv(), mockFetch);

      assert.equal(outcome.status, 'blocked');
      assert.equal(outcome.conclusion, 'failure');
      assert.match(outcome.summary, /has no newest successful exact-head Review Yeti check/);

      assert.equal(publishedCheckRuns.length, 1);
      const published = publishedCheckRuns[0];
      assert.equal(published.conclusion, 'failure');
      assert.match(published.output.summary, /Merge group attestation blocked/);
    });
  });

  describe('Worker Ingress Integration for merge_group Webhooks', () => {
    it('dispatches merge_group event through worker fetch handler and returns attested response', async () => {
      const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
      const payload = {
        action: 'checks_requested',
        merge_group: {
          head_sha: headSha,
          head_ref: 'refs/heads/gh-readonly-queue/main/pr-4836-abcdef01',
          base_ref: 'refs/heads/main',
          base_sha: 'base000000000000000000000000000000000000',
        },
        repository: {
          name: 'sample-repo',
          full_name: 'example-org/sample-repo',
          owner: { login: 'example-org' },
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = await signPayload('test-webhook-secret', rawBody);

      // Global fetch mock during worker ingress test
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (input: any, init: any) => {
          const urlStr = typeof input === 'string' ? input : input.url;

          if (urlStr.includes('/graphql')) {
            return Response.json({
              data: {
                repository: {
                  mergeQueue: {
                    entries: {
                      nodes: [
                        {
                          position: 1,
                          state: 'MERGEABLE',
                          pullRequest: {
                            number: 4836,
                            headRefOid: '1111111111111111111111111111111111111111',
                            baseRefOid: 'base000000000000000000000000000000000000',
                          },
                        },
                      ],
                    },
                  },
                },
              },
            });
          }

          if (urlStr.includes('/check-runs?filter=all')) {
            return Response.json({
              check_runs: [
                {
                  id: 501,
                  name: REQUIRED_CHECK_NAME,
                  status: 'completed',
                  conclusion: 'success',
                  started_at: '2026-10-01T12:00:00Z',
                  external_id: 'run_1234567890abcdef1234567890abcdef:a1',
                  app: { id: 4385771 },
                },
              ],
            });
          }

          if (urlStr.endsWith('/check-runs') && init?.method === 'POST') {
            const body = JSON.parse(init.body as string);
            return Response.json({ id: 9999, ...body });
          }

          return new Response('Not found', { status: 404 });
        }) as any;

        const req = new Request('http://localhost/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'merge_group',
            'X-Hub-Signature-256': signature,
          },
          body: rawBody,
        });

        const res = await worker.fetch(req, createMockEnv());
        assert.equal(res.status, 200);

        const data = (await res.json()) as any;
        assert.equal(data.status, 'attested');
        assert.equal(data.conclusion, 'success');
        assert.equal(data.headSha, headSha);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns ignored when merge_group action is not checks_requested', async () => {
      const payload = {
        action: 'destroyed',
        merge_group: {
          head_sha: 'abc',
          head_ref: 'refs/heads/gh-readonly-queue/main/pr-1-abc',
        },
        repository: {
          full_name: 'example-org/sample-repo',
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = await signPayload('test-webhook-secret', rawBody);

      const req = new Request('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'merge_group',
          'X-Hub-Signature-256': signature,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, createMockEnv());
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'ignored');
      assert.equal(data.reason, 'unsupported_action_destroyed');
    });

    it('returns ignored for non-pilot repository', async () => {
      const payload = {
        action: 'checks_requested',
        merge_group: {
          head_sha: 'abc',
          head_ref: 'refs/heads/gh-readonly-queue/main/pr-1-abc',
        },
        repository: {
          full_name: 'other-org/other-repo',
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = await signPayload('test-webhook-secret', rawBody);

      const req = new Request('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'merge_group',
          'X-Hub-Signature-256': signature,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, createMockEnv());
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'ignored');
      assert.equal(data.reason, 'not_pilot_repository');
    });

    it('returns HTTP 400 when merge_group payload is malformed', async () => {
      const payload = {
        action: 'checks_requested',
        // Missing repository and merge_group
      };

      const rawBody = JSON.stringify(payload);
      const signature = await signPayload('test-webhook-secret', rawBody);

      const req = new Request('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'merge_group',
          'X-Hub-Signature-256': signature,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, createMockEnv());
      assert.equal(res.status, 400);
    });
  });

  describe('Adversarial Edge Cases & Hazard Regression Scenarios', () => {
    it('detects conflicting Ecto migration timestamps on a single PR with base branch drift', async () => {
      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          {
            number: 101,
            position: 1,
            state: 'MERGEABLE',
            head_sha: '1111111111111111111111111111111111111111',
            base_sha: 'base_old_11111111111111111111111111111111',
          },
        ],
        queueBaseSha: 'base_new_22222222222222222222222222222222',
        token: 'test-token',
        mockPrFiles: new Map([
          [
            101,
            [
              {
                filename: 'priv/repo/migrations/20261001150000_create_profiles.exs',
                patch: '+ def change do\n+ end',
              },
            ],
          ],
        ]),
        mockBaseDriftFiles: [
          {
            filename: 'priv/repo/migrations/20261001150000_add_tokens.exs',
            patch: '+ def change do\n+ end',
          },
        ],
      });

      assert.equal(result.passed, false);
      assert.equal(result.bypassed, false);
      assert.equal(result.hazards.length, 1);
      assert.equal(result.hazards[0].type, 'migration_collision');
      assert.match(result.hazards[0].description, /Conflicting Ecto migration timestamp "20261001150000"/);
      assert.match(result.hazards[0].description, /main \(base_ne\) base drift/);
    });

    it('detects shared runtime/config collision on mix.lock between single PR and base drift', async () => {
      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          {
            number: 101,
            position: 1,
            state: 'MERGEABLE',
            head_sha: '1111111111111111111111111111111111111111',
            base_sha: 'base_old_11111111111111111111111111111111',
          },
        ],
        queueBaseSha: 'base_new_22222222222222222222222222222222',
        token: 'test-token',
        mockPrFiles: new Map([
          [
            101,
            [
              {
                filename: 'mix.lock',
                patch: '+ "jason": {:hex, ...}',
              },
            ],
          ],
        ]),
        mockBaseDriftFiles: [
          {
            filename: 'mix.lock',
            patch: '+ "plug": {:hex, ...}',
          },
        ],
      });

      assert.equal(result.passed, false);
      assert.equal(result.bypassed, false);
      assert.equal(result.hazards.length, 1);
      assert.equal(result.hazards[0].type, 'shared_config_collision');
      assert.match(result.hazards[0].description, /Shared runtime\/config file collision on "mix\.lock"/);
      assert.match(result.hazards[0].description, /main \(base_ne\) base drift/);
    });

    it('detects contract break when single PR invokes symbol deleted in base drift', async () => {
      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          {
            number: 101,
            position: 1,
            state: 'MERGEABLE',
            head_sha: '1111111111111111111111111111111111111111',
            base_sha: 'base_old_11111111111111111111111111111111',
          },
        ],
        queueBaseSha: 'base_new_22222222222222222222222222222222',
        token: 'test-token',
        mockPrFiles: new Map([
          [
            101,
            [
              {
                filename: 'lib/cdrcisco/caller.ex',
                patch: '@@ -10,1 +10,2 @@\n+result = legacy_auth(user_token)',
              },
            ],
          ],
        ]),
        mockBaseDriftFiles: [
          {
            filename: 'lib/cdrcisco/auth.ex',
            patch: '@@ -5,3 +5,0 @@\n-def legacy_auth(token) do\n-  :ok\n-end',
          },
        ],
      });

      assert.equal(result.passed, false);
      assert.equal(result.bypassed, false);
      assert.equal(result.hazards.length, 1);
      assert.equal(result.hazards[0].type, 'contract_break');
      assert.match(result.hazards[0].description, /legacy_auth/);
      assert.match(result.hazards[0].description, /main \(base_ne\) base drift/);
    });

    it('does NOT trigger false contract break when caller uses compound words containing deleted symbol', async () => {
      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles: new Map([
          [
            101,
            [
              {
                filename: 'lib/cdrcisco/old.ex',
                patch: '@@ -1,3 +1,0 @@\n-def id do\n- :none\n-end\n-def run do\n- :ok\n-end',
              },
            ],
          ],
          [
            102,
            [
              {
                filename: 'lib/cdrcisco/new.ex',
                patch: '@@ -10,1 +10,5 @@\n+validate_user()\n+user_id_lookup()\n+running_status = true\n+pr_numbers = [1, 2]',
              },
            ],
          ],
        ]),
      });

      assert.equal(result.passed, true);
      assert.equal(result.hazards.length, 0);
    });

    it('does NOT trigger false contract break when function definition line is re-indented or body modified without signature change', async () => {
      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles: new Map([
          [
            101,
            [
              {
                filename: 'lib/cdrcisco/tax.ex',
                // Re-indented / reformatted function definition without changing signature
                patch: '@@ -10,3 +10,3 @@\n-  def calculate_tax(amount) do\n+    def calculate_tax(amount) do',
              },
            ],
          ],
          [
            102,
            [
              {
                filename: 'lib/cdrcisco/order.ex',
                patch: '@@ -25,1 +25,2 @@\n+total = calculate_tax(100)',
              },
            ],
          ],
        ]),
      });

      assert.equal(result.passed, true);
      assert.equal(result.hazards.length, 0);
    });

    it('paginates GraphQL mergeQueue when queue position spans across pages', async () => {
      // Mock 2 pages: page 1 has PRs 1-100, page 2 has PR 101
      const page1Nodes = Array.from({ length: 100 }, (_, i) => ({
        position: i + 1,
        state: 'MERGEABLE',
        pullRequest: {
          number: i + 1,
          headRefOid: 'a'.repeat(40),
          baseRefOid: '0'.repeat(40),
        },
      }));

      const page2Nodes = [
        {
          position: 101,
          state: 'MERGEABLE',
          pullRequest: {
            number: 101,
            headRefOid: 'b'.repeat(40),
            baseRefOid: '0'.repeat(40),
          },
        },
      ];

      const mockFetch: typeof fetch = async (input, init) => {
        const body = JSON.parse(init?.body as string);
        const after = body.variables?.after;

        if (!after) {
          return Response.json({
            data: {
              repository: {
                mergeQueue: {
                  entries: {
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: 'cursor_page_1',
                    },
                    nodes: page1Nodes,
                  },
                },
              },
            },
          });
        }

        return Response.json({
          data: {
            repository: {
              mergeQueue: {
                entries: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                  nodes: page2Nodes,
                },
              },
            },
          },
        });
      };

      const result = await getConstituentPullRequests({
        owner: 'example-org',
        repo: 'sample-repo',
        baseBranch: 'main',
        currentPrNumber: 101,
        token: 'test-token',
        fetchFn: mockFetch,
      });

      assert.equal(result.passed, true);
      assert.equal(result.prs.length, 101);
      assert.equal(result.prs[100].number, 101);
    });

    it('handles GraphQL error responses with explicit blocker reason', async () => {
      const mockFetch: typeof fetch = async () => {
        return Response.json({
          errors: [{ message: 'Rate limit exceeded on merge queue GraphQL endpoint' }],
        });
      };

      const result = await getConstituentPullRequests({
        owner: 'example-org',
        repo: 'sample-repo',
        baseBranch: 'main',
        currentPrNumber: 101,
        token: 'test-token',
        fetchFn: mockFetch,
      });

      assert.equal(result.passed, false);
      assert.match(
        result.blockerReason!,
        /merge queue GraphQL error: Rate limit exceeded on merge queue GraphQL endpoint/
      );
    });

    it('fails closed when GitHub check-run publication fails with HTTP 500', async () => {
      const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
      const payload: MergeGroupPayload = {
        action: 'checks_requested',
        merge_group: {
          head_sha: headSha,
          head_ref: 'refs/heads/gh-readonly-queue/main/pr-4836-abcdef01',
          base_ref: 'refs/heads/main',
          base_sha: 'base000000000000000000000000000000000000',
        },
        repository: {
          name: 'sample-repo',
          full_name: 'example-org/sample-repo',
        },
      };

      const mockFetch: typeof fetch = async (input, init) => {
        const urlStr = typeof input === 'string' ? input : (input as any).url || String(input);

        if (urlStr.includes('/graphql')) {
          return Response.json({
            data: {
              repository: {
                mergeQueue: {
                  entries: {
                    nodes: [
                      {
                        position: 1,
                        state: 'MERGEABLE',
                        pullRequest: {
                          number: 4836,
                          headRefOid: '1111111111111111111111111111111111111111',
                          baseRefOid: 'base000000000000000000000000000000000000',
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        }

        if (urlStr.includes('/check-runs?filter=all')) {
          return Response.json({
            check_runs: [
              {
                id: 501,
                name: REQUIRED_CHECK_NAME,
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-10-01T12:00:00Z',
                external_id: 'run_1234567890abcdef1234567890abcdef:a1',
                app: { id: 4385771 },
              },
            ],
          });
        }

        // Simulate GitHub check run publication API 500 error
        if (urlStr.endsWith('/check-runs') && init?.method === 'POST') {
          return new Response('GitHub internal server error', { status: 500 });
        }

        return new Response('Not found', { status: 404 });
      };

      const outcome = await handleMergeGroupAttestation(payload, createMockEnv(), mockFetch);

      assert.equal(outcome.status, 'blocked');
      assert.equal(outcome.conclusion, 'failure');
      assert.match(outcome.summary, /failed to publish check-run/i);
      assert.ok(outcome.checkRunError);
    });

    it('detects base drift migration collision on non-first PR in a multi-PR batch', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/disjoint.ex',
              patch: '@@ -1,1 +1,2 @@\n+:ok',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'priv/repo/migrations/20261001150000_add_analytics.exs',
              patch: '+ def change do\n+ end',
            },
          ],
        ],
      ]);

      const mockBaseDriftFiles = [
        {
          filename: 'priv/repo/migrations/20261001150000_add_metrics.exs',
          patch: '+ def change do\n+ end',
        },
      ];

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          // PR 101 has NO base drift
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base_main' },
          // PR 102 HAS base drift
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base_old' },
        ],
        queueBaseSha: 'base_main',
        token: 'test-token',
        mockPrFiles,
        mockBaseDriftFiles,
      });

      assert.equal(result.passed, false);
      assert.equal(result.hazards.length, 1);
      assert.equal(result.hazards[0].type, 'migration_collision');
      assert.equal(result.hazards[0].prNumber, 102);
      assert.equal(result.hazards[0].conflictingPrNumber, 0);
      assert.match(result.hazards[0].description, /Conflicting Ecto migration timestamp "20261001150000"/);
    });

    it('correctly attributes contract break hazard to main base drift (PR 0) when main invokes deleted symbol', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/pipeline.ex',
              patch: '@@ -10,4 +10,0 @@\n-def custom_domain_pipeline(data) do\n-  :ok\n-end',
            },
          ],
        ],
      ]);

      const mockBaseDriftFiles = [
        {
          filename: 'lib/cdrcisco/main_runner.ex',
          patch: '@@ -20,1 +20,2 @@\n+result = custom_domain_pipeline(data)',
        },
      ];

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base_old' },
        ],
        queueBaseSha: 'base_main',
        token: 'test-token',
        mockPrFiles,
        mockBaseDriftFiles,
      });

      assert.equal(result.passed, false);
      assert.equal(result.hazards.length, 1);
      assert.equal(result.hazards[0].type, 'contract_break');
      // Conflicting PR number MUST be 0 (main base drift), NOT 101 conflicting with itself!
      assert.equal(result.hazards[0].prNumber, 101);
      assert.equal(result.hazards[0].conflictingPrNumber, 0);
      assert.match(result.hazards[0].description, /main.*base drift invokes symbol "custom_domain_pipeline"/);
    });

    it('does NOT trigger contract break when PR 1 modifies a private function (defp or defguardp)', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/module_a.ex',
              patch: '@@ -10,3 +10,3 @@\n-defp internal_calc(amount) do\n+defp internal_calc(amount, factor) do',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'lib/cdrcisco/module_b.ex',
              patch: '@@ -20,2 +20,3 @@\n+result = internal_calc(100)',
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, true);
      assert.equal(result.hazards.length, 0);
    });

    it('does NOT trigger false contract break for Elixir atoms, map keys, or comment lines', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/evaluator.ex',
              patch: '@@ -10,3 +10,3 @@\n-def custom_eval(expr) do\n+def custom_eval(expr, opts) do',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'lib/cdrcisco/consumer.ex',
              // Contains atom :custom_eval, map key custom_eval:, and comment, but NO function invocation
              patch: [
                '@@ -20,3 +20,6 @@',
                '+status = :custom_eval',
                '+params = %{custom_eval: true}',
                '+# Note: custom_eval will be refactored soon',
                '+@spec custom_eval(any()) :: boolean()',
              ].join('\n'),
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, true);
      assert.equal(result.hazards.length, 0);
    });

    it('does NOT trigger false contract break when PR 2 calls standard library modules or common methods', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/user_controller.ex',
              // Controller modifies standard CRUD action delete/2
              patch: '@@ -10,3 +10,3 @@\n-def delete(conn, %{"id" => id}) do\n+def delete(conn, %{"id" => id, "force" => force}) do',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'lib/cdrcisco/device_service.ex',
              // PR 2 calls Repo.delete and Map.delete
              patch: '@@ -20,2 +20,4 @@\n+Repo.delete(device)\n+Map.delete(opts, :key)',
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, true);
      assert.equal(result.hazards.length, 0);
    });

    it('extractPrNumberFromHeadRef parses head_ref with or without trailing commit hash', () => {
      assert.equal(extractPrNumberFromHeadRef('refs/heads/gh-readonly-queue/main/pr-4836-1234abcd'), 4836);
      assert.equal(extractPrNumberFromHeadRef('refs/heads/gh-readonly-queue/main/pr-4836'), 4836);
      assert.equal(extractPrNumberFromHeadRef('gh-readonly-queue/0.8.7-stable/pr-99'), 99);
      assert.equal(extractPrNumberFromHeadRef('refs/heads/feature/branch'), null);
    });

    it('returns HTTP 400 when merge_group payload is missing base_ref at worker ingress', async () => {
      const payload = {
        action: 'checks_requested',
        merge_group: {
          head_sha: '1111111111111111111111111111111111111111',
          head_ref: 'refs/heads/gh-readonly-queue/main/pr-101-1111',
          // base_ref omitted
        },
        repository: {
          full_name: 'example-org/sample-repo',
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = await signPayload('test-webhook-secret', rawBody);

      const env = createMockEnv();
      const req = new Request('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'merge_group',
          'X-Hub-Signature-256': signature,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 400);
      const text = await res.text();
      assert.match(text, /Missing or invalid repository \/ merge_group payload/);
    });

    it('verifyConstituentChecks handles check run with null or undefined app object', () => {
      const checks = [
        {
          id: 100,
          name: REQUIRED_CHECK_NAME,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-01T10:00:00Z',
          external_id: 'run_1234567890abcdef1234567890abcdef:a1',
          app: undefined,
        },
      ];

      const res = verifyConstituentChecks(checks, 101, '1111');
      assert.equal(res.passed, false);
      assert.match(res.blockerReason!, /no newest successful exact-head/);
    });

    it('detects contract break when PR 2 invokes deleted symbol via Elixir pipe without parens', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/pipeline.ex',
              patch: '@@ -10,3 +10,3 @@\n-def sanitize_payload(payload) do\n+def sanitize_payload(payload, opts) do',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'lib/cdrcisco/endpoint.ex',
              patch: '@@ -25,2 +25,3 @@\n+payload\n+|> sanitize_payload',
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, false);
      assert.equal(result.hazards.length, 1);
      assert.equal(result.hazards[0].type, 'contract_break');
      assert.match(result.hazards[0].description, /sanitize_payload/);
    });

    it('detects contract break when PR 2 captures deleted symbol via function capture (&symbol/1)', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/transformer.ex',
              patch: '@@ -10,3 +10,3 @@\n-def normalize_record(rec) do\n+def normalize_record(rec, tenant_id) do',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'lib/cdrcisco/batch_job.ex',
              patch: '@@ -25,2 +25,3 @@\n+Enum.map(records, &normalize_record/1)',
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, false);
      assert.equal(result.hazards.length, 1);
      assert.equal(result.hazards[0].type, 'contract_break');
      assert.match(result.hazards[0].description, /normalize_record/);
    });

    it('does NOT trigger false contract break when symbol appears inside string literals or log messages', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/old_auth.ex',
              patch: '@@ -10,4 +10,0 @@\n-def authenticate(user) do\n-  :ok\n-end',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'lib/cdrcisco/new_logger.ex',
              patch: '@@ -20,2 +20,4 @@\n+Logger.info("authenticate user failed")\n+IO.puts("Failed to authenticate session")',
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, true);
      assert.equal(result.hazards.length, 0);
    });

    it('does NOT trigger false contract break when symbol appears inside inline comments', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            {
              filename: 'lib/cdrcisco/deprecated_svc.ex',
              patch: '@@ -5,4 +5,0 @@\n-def legacy_lookup(id) do\n-  nil\n-end',
            },
          ],
        ],
        [
          102,
          [
            {
              filename: 'lib/cdrcisco/refactored.ex',
              patch: '@@ -15,2 +15,3 @@\n+result = :ok # Note: legacy_lookup was deleted in PR 101',
            },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, true);
      assert.equal(result.hazards.length, 0);
    });

    it('fails closed when fetching PR changed files returns HTTP 500 error', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/files')) {
          return new Response('GitHub internal error', { status: 500 });
        }
        return new Response('Not found', { status: 404 });
      };

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        fetchFn: mockFetch,
      });

      assert.equal(result.passed, false);
      assert.match(result.diagnosticSummary!, /Failed to evaluate composite delta hazards/);
      assert.match(result.diagnosticSummary!, /GitHub files API error \(500\)/);
    });

    it('fails closed when fetching base drift files returns HTTP 403 rate limit error', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/files')) {
          return Response.json([]);
        }
        if (url.includes('/compare/')) {
          return new Response('API rate limit exceeded', { status: 403 });
        }
        return new Response('Not found', { status: 404 });
      };

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base_old' },
        ],
        queueBaseSha: 'base_new',
        token: 'test-token',
        fetchFn: mockFetch,
      });

      assert.equal(result.passed, false);
      assert.match(result.diagnosticSummary!, /GitHub compare API error \(403\)/);
    });

    it('publishes failure check run when head_ref is unparseable instead of throwing uncaught exception', async () => {
      const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
      const payload: MergeGroupPayload = {
        action: 'checks_requested',
        merge_group: {
          head_sha: headSha,
          head_ref: 'refs/heads/gh-readonly-queue/main/invalid-branch-name',
          base_ref: 'refs/heads/main',
        },
        repository: {
          name: 'sample-repo',
          full_name: 'example-org/sample-repo',
        },
      };

      const publishedCheckRuns: any[] = [];
      const mockFetch: typeof fetch = async (input, init) => {
        const urlStr = String(input);
        if (urlStr.endsWith('/check-runs') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          publishedCheckRuns.push(body);
          return Response.json({ id: 8888, ...body });
        }
        return new Response('Not found', { status: 404 });
      };

      const outcome = await handleMergeGroupAttestation(payload, createMockEnv(), mockFetch);
      assert.equal(outcome.status, 'blocked');
      assert.equal(outcome.conclusion, 'failure');
      assert.match(outcome.summary, /Failed to parse base_ref.*or PR number/);
      assert.equal(publishedCheckRuns.length, 1);
      assert.equal(publishedCheckRuns[0].conclusion, 'failure');
      assert.equal(publishedCheckRuns[0].name, 'Review Yeti');
    });

    it('detects shared runtime config collision on wrangler.json and arbitrary config/*.exs', async () => {
      const mockPrFiles = new Map<number, Array<{ filename: string; patch?: string }>>([
        [
          101,
          [
            { filename: 'wrangler.json', patch: '+ "name": "worker-a"' },
            { filename: 'config/releases.exs', patch: '+ config :app, :key, "val1"' },
          ],
        ],
        [
          102,
          [
            { filename: 'wrangler.json', patch: '+ "name": "worker-b"' },
            { filename: 'config/releases.exs', patch: '+ config :app, :key, "val2"' },
          ],
        ],
      ]);

      const result = await evaluateCompositeDeltaHazards({
        owner: 'example-org',
        repo: 'sample-repo',
        constituentPrs: [
          { number: 101, position: 1, state: 'MERGEABLE', head_sha: '1111', base_sha: 'base1' },
          { number: 102, position: 2, state: 'MERGEABLE', head_sha: '2222', base_sha: 'base1' },
        ],
        queueBaseSha: 'base1',
        token: 'test-token',
        mockPrFiles,
      });

      assert.equal(result.passed, false);
      const collisionFiles = result.hazards.map((h) => h.file);
      assert.ok(collisionFiles.includes('wrangler.json'));
      assert.ok(collisionFiles.includes('config/releases.exs'));
    });
  });
});


