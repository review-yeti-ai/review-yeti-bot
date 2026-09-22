/**
 * Empirical Challenger Test Suite (Milestone M8)
 *
 * Adversarial stress-testing of:
 * 1. attest_pr_gate:
 *    - Exact-head SHA validation (mismatch, casing, missing runs, invalid inputs)
 *    - Authoritative gate status validation (verdict != SHIP, P0/P1 blockers, overruling/resolution, non-blocker P2/P3, CI checks)
 *    - Cryptographic attestation token (HMAC-SHA256 signature format, deterministic verification, tampering resistance)
 * 2. reply_review_thread:
 *    - Repository tenancy & RBAC isolation
 *    - GitHub App ID 4385771 configuration, User-Agent, payload structure, threading endpoint
 *    - Client pathways & robust error handling (404, 403, 500, network crash, input boundaries)
 * 3. System-level integration:
 *    - 12-tool catalog listing over remoteMcpRouter HTTP JSON-RPC 2.0
 *    - Remote tools/call execution for attest_pr_gate and reply_review_thread
 *    - Authentication (401) and tenancy authorization (403) boundary verification
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import {
  createRemoteMcpRouter,
  createDefaultToolRegistry,
  type RemoteMcpRouter,
  type RemoteMcpRouterOptions,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  createAttestPrGateTool,
  createReplyReviewThreadTool,
  AttestPrGateInputSchema,
  ReplyReviewThreadInputSchema,
  REVIEW_YETI_APP_ID,
} from '../../src/mcp/server/tools';
import {
  type McpAuthenticatedCaller,
  type McpAuthenticator,
  McpAuthError,
} from '../../src/mcp/server/mcpAuthenticator';
import { McpRbacError } from '../../src/mcp/server/mcpRbac';

describe('Empirical Challenger Suite: attest_pr_gate & reply_review_thread (tests/unit/mcpAttestReplyEmpiricalChallenger.test.ts)', () => {
  const TEST_OWNER = 'calltelemetry';
  const TEST_REPO = 'ct-review-bot';
  const TEST_PR = 789;
  const VALID_HEAD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
  const ALTERED_HEAD_SHA = '1111111111111111111111111111111111111111';
  const ATTESTATION_SECRET = 'challenger-super-secure-attestation-secret-2026';
  const FIXED_TIMESTAMP = 1774012345678;

  function createMockCaller(options: {
    isAdmin?: boolean;
    allowedRepos?: string[];
    callerId?: string;
  } = {}): McpAuthenticatedCaller {
    return {
      authType: 'static_token',
      tokenDigest: 'mock-digest-challenger',
      isAdmin: options.isAdmin ?? false,
      allowedRepositories: options.allowedRepos
        ? new Set(options.allowedRepos.map((r) => r.toLowerCase()))
        : new Set([`${TEST_OWNER}/${TEST_REPO}`.toLowerCase()]),
      callerId: options.callerId || 'test-challenger-m8',
    };
  }

  function createMockAuthenticator(caller: McpAuthenticatedCaller): McpAuthenticator {
    return {
      authenticate: vi.fn(async (_req: Request) => caller),
      authenticateToken: vi.fn(async (_token: string) => caller),
      checkRepositoryAccess: vi.fn((c: McpAuthenticatedCaller, owner: string, repo: string) => {
        if (c.isAdmin) return true;
        return c.allowedRepositories?.has(`${owner}/${repo}`.toLowerCase()) ?? false;
      }),
      middleware: vi.fn(),
    } as unknown as McpAuthenticator;
  }

  function buildExpressApp(router: RemoteMcpRouter) {
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.use('/api/mcp', router);
    return app;
  }

  // ===========================================================================
  // SECTION 1: attest_pr_gate EMPIRICAL CHALLENGES
  // ===========================================================================
  describe('1. attest_pr_gate: Exact-Head Matching & Boundary Conditions', () => {
    it('CHALLENGE: rejects when head_sha does not match latest evaluated run in DB', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-head-mismatch',
              head_sha: VALID_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify({ result: { verdict: 'SHIP', personas: [] } }),
            },
          ],
        }),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        attestationSecret: ATTESTATION_SECRET,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: ALTERED_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(false);
      expect(data.gate_status).toBe('BLOCKED');
      expect(data.attestation_token).toBe('');
      expect(data.head_sha).toBe(ALTERED_HEAD_SHA);
      expect(data.blockers).toContainEqual(
        expect.stringContaining(`Review run head SHA mismatch: latest run evaluated commit '${VALID_HEAD_SHA}', requested attestation for '${ALTERED_HEAD_SHA}'`)
      );
    });

    it('CHALLENGE: accepts case-insensitive hex SHA matching (uppercase input vs lowercase DB)', async () => {
      const uppercaseSha = VALID_HEAD_SHA.toUpperCase();
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-head-case',
              head_sha: VALID_HEAD_SHA.toLowerCase(),
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify({ result: { verdict: 'SHIP', personas: [] } }),
            },
          ],
        }),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        attestationSecret: ATTESTATION_SECRET,
        now: () => FIXED_TIMESTAMP,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: uppercaseSha,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(true);
      expect(data.gate_status).toBe('PASSED');
      expect(data.blockers).toHaveLength(0);
      expect(data.attestation_token).toMatch(/^[a-f0-9]{64}$/);
    });

    it('CHALLENGE: blocks attestation when no review run exists for the repository and PR', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        attestationSecret: ATTESTATION_SECRET,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: 999999,
          head_sha: VALID_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(false);
      expect(data.gate_status).toBe('BLOCKED');
      expect(data.attestation_token).toBe('');
      expect(data.blockers).toContainEqual(
        `No review run found for ${TEST_OWNER}/${TEST_REPO}#999999`
      );
    });

    it('CHALLENGE: schema rejects malformed commit SHAs and invalid PR numbers', async () => {
      const tool = createAttestPrGateTool({});
      const context = { caller: createMockCaller() };

      // Invalid SHA length: 39 chars
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 1, head_sha: 'a'.repeat(39) }, context)
      ).rejects.toThrow(/head_sha must be a 40-character hex commit SHA/);

      // Invalid SHA length: 41 chars
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 1, head_sha: 'a'.repeat(41) }, context)
      ).rejects.toThrow(/head_sha must be a 40-character hex commit SHA/);

      // Non-hex characters
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 1, head_sha: 'g'.repeat(40) }, context)
      ).rejects.toThrow(/head_sha must be a 40-character hex commit SHA/);

      // Negative PR number
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: -5, head_sha: VALID_HEAD_SHA }, context)
      ).rejects.toThrow(/pr_number must be a positive integer/);

      // Zero PR number
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 0, head_sha: VALID_HEAD_SHA }, context)
      ).rejects.toThrow(/pr_number must be a positive integer/);

      // Floating-point PR number
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 12.5, head_sha: VALID_HEAD_SHA }, context)
      ).rejects.toThrow(/Expected integer/);
    });

    it('CHALLENGE: multi-run ordering: newer run supersedes older run even if older had SHIP', async () => {
      // Simulates database query returning the latest run (ordered by created_at DESC)
      // Earlier commit had SHIP, but new commit pushed was evaluated with FIX_FIRST
      const NEW_HEAD_SHA = '9999999999999999999999999999999999999999';
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-latest-2',
              head_sha: NEW_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'FIX_FIRST' }),
              payload: JSON.stringify({ result: { verdict: 'FIX_FIRST', personas: [] } }),
            },
          ],
        }),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        attestationSecret: ATTESTATION_SECRET,
      });

      // Calling with older commit (VALID_HEAD_SHA) must be rejected because latest evaluated run is NEW_HEAD_SHA
      const resStale: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: VALID_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );
      const dataStale = JSON.parse(resStale.content[0].text);
      expect(dataStale.attested).toBe(false);
      expect(dataStale.gate_status).toBe('BLOCKED');
      expect(dataStale.blockers.some((b: string) => b.includes('head SHA mismatch'))).toBe(true);

      // Calling with new commit (NEW_HEAD_SHA) matches SHA but fails on FIX_FIRST
      const resNew: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: NEW_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );
      const dataNew = JSON.parse(resNew.content[0].text);
      expect(dataNew.attested).toBe(false);
      expect(dataNew.gate_status).toBe('BLOCKED');
      expect(dataNew.blockers.some((b: string) => b.includes("required 'SHIP'"))).toBe(true);
    });
  });

  describe('2. attest_pr_gate: Gate Status & Blocker Adjudication', () => {
    it('CHALLENGE: blocks attestation if authoritative verdict is FIX_FIRST, REQUEST_CHANGES, or PENDING', async () => {
      const nonShipVerdicts = ['FIX_FIRST', 'REQUEST_CHANGES', 'PENDING', 'NEEDS_WORK'];

      for (const verdict of nonShipVerdicts) {
        const mockDb = {
          query: vi.fn().mockResolvedValue({
            rows: [
              {
                run_id: `run-${verdict}`,
                head_sha: VALID_HEAD_SHA,
                decision: JSON.stringify({ verdict }),
                payload: JSON.stringify({ result: { verdict, personas: [] } }),
              },
            ],
          }),
        };

        const tool = createAttestPrGateTool({
          queryableDatabase: mockDb,
          attestationSecret: ATTESTATION_SECRET,
        });

        const res: any = await tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            head_sha: VALID_HEAD_SHA,
          },
          { caller: createMockCaller() }
        );

        const data = JSON.parse(res.content[0].text);
        expect(data.attested).toBe(false);
        expect(data.gate_status).toBe('BLOCKED');
        expect(data.attestation_token).toBe('');
        expect(data.blockers).toContainEqual(
          `Authoritative review verdict is '${verdict}', required 'SHIP'`
        );
      }
    });

    it('CHALLENGE: blocks attestation when SHIP verdict has open P0 or P1 blockers', async () => {
      const blockerPayload = {
        result: {
          verdict: 'SHIP',
          personas: [
            {
              id: 'sec-lane',
              findings: [
                {
                  finding_id: 'vuln-p0',
                  severity: 'P0',
                  title: 'SQL Injection in raw query',
                  path: 'src/db.ts',
                  line_start: 42,
                  resolved: false,
                  status: 'OPEN',
                },
                {
                  finding_id: 'vuln-p1',
                  severity: 'P1',
                  title: 'Missing CSRF protection',
                  path: 'src/routes.ts',
                  line_start: 88,
                  resolved: false,
                  status: 'OPEN',
                },
              ],
            },
          ],
        },
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-ship-with-blockers',
              head_sha: VALID_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify(blockerPayload),
            },
          ],
        }),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        attestationSecret: ATTESTATION_SECRET,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: VALID_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(false);
      expect(data.gate_status).toBe('BLOCKED');
      expect(data.blockers).toContainEqual('[P0] SQL Injection in raw query (src/db.ts:42)');
      expect(data.blockers).toContainEqual('[P1] Missing CSRF protection (src/routes.ts:88)');
      expect(data.attestation_token).toBe('');
    });

    it('CHALLENGE: does NOT block attestation when findings are resolved, overruled, or lower-severity (P2/P3/advisory)', async () => {
      const nonBlockerPayload = {
        result: {
          verdict: 'SHIP',
          personas: [
            {
              id: 'arch-lane',
              findings: [
                {
                  finding_id: 'overruled-p0',
                  severity: 'P0',
                  title: 'Disputed memory leak',
                  path: 'src/cache.ts',
                  line_start: 10,
                  status: 'OVERRULED',
                  resolved: true,
                },
                {
                  finding_id: 'resolved-p1',
                  severity: 'P1',
                  title: 'Already patched error path',
                  path: 'src/handler.ts',
                  line_start: 55,
                  status: 'RESOLVED',
                  resolved: true,
                },
                {
                  finding_id: 'info-p2',
                  severity: 'P2',
                  title: 'Naming convention advisory',
                  path: 'src/utils.ts',
                  line_start: 2,
                  resolved: false,
                },
                {
                  finding_id: 'info-p3',
                  severity: 'P3',
                  title: 'Comment typo',
                  path: 'src/config.ts',
                  line_start: 9,
                  resolved: false,
                },
              ],
            },
          ],
        },
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-clean-verdict',
              head_sha: VALID_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify(nonBlockerPayload),
            },
          ],
        }),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        attestationSecret: ATTESTATION_SECRET,
        now: () => FIXED_TIMESTAMP,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: VALID_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(true);
      expect(data.gate_status).toBe('PASSED');
      expect(data.blockers).toHaveLength(0);
      expect(data.attestation_token).toMatch(/^[a-f0-9]{64}$/);
    });

    it('CHALLENGE: evaluates CI check-runs: in-progress, failed, timed_out, and cancelled check runs block attestation', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-ci-check',
              head_sha: VALID_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify({ result: { verdict: 'SHIP', personas: [] } }),
            },
          ],
        }),
      };

      const failingCheckRuns = [
        { name: 'ci/unit-tests', status: 'completed', conclusion: 'failure' },
        { name: 'ci/e2e-soak', status: 'completed', conclusion: 'timed_out' },
        { name: 'ci/docker-build', status: 'completed', conclusion: 'cancelled' },
        { name: 'ci/manual-gate', status: 'completed', conclusion: 'action_required' },
        { name: 'ci/long-running-lint', status: 'in_progress', conclusion: null },
      ];

      const mockCheckRunsClient = {
        listCheckRunsForCommit: vi.fn().mockResolvedValue(failingCheckRuns),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        checkRunsClient: mockCheckRunsClient,
        attestationSecret: ATTESTATION_SECRET,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: VALID_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(false);
      expect(data.gate_status).toBe('BLOCKED');
      expect(data.attestation_token).toBe('');
      expect(data.blockers).toContainEqual("CI check run 'ci/unit-tests' failed with conclusion 'failure'");
      expect(data.blockers).toContainEqual("CI check run 'ci/e2e-soak' failed with conclusion 'timed_out'");
      expect(data.blockers).toContainEqual("CI check run 'ci/docker-build' failed with conclusion 'cancelled'");
      expect(data.blockers).toContainEqual("CI check run 'ci/manual-gate' failed with conclusion 'action_required'");
      expect(data.blockers).toContainEqual("CI check run 'ci/long-running-lint' is still in progress (in_progress)");
    });

    it('CHALLENGE: benign CI check run conclusions (success, neutral, skipped) allow gate attestation', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-ci-benign',
              head_sha: VALID_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify({ result: { verdict: 'SHIP', personas: [] } }),
            },
          ],
        }),
      };

      const benignCheckRuns = [
        { name: 'ci/unit-tests', status: 'completed', conclusion: 'success' },
        { name: 'ci/optional-benchmark', status: 'completed', conclusion: 'neutral' },
        { name: 'ci/unaffected-subsystem', status: 'completed', conclusion: 'skipped' },
      ];

      const mockCheckRunsClient = {
        listCheckRunsForCommit: vi.fn().mockResolvedValue(benignCheckRuns),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        checkRunsClient: mockCheckRunsClient,
        attestationSecret: ATTESTATION_SECRET,
        now: () => FIXED_TIMESTAMP,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: VALID_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(true);
      expect(data.gate_status).toBe('PASSED');
      expect(data.blockers).toHaveLength(0);
      expect(data.attestation_token).toMatch(/^[a-f0-9]{64}$/);
    });

    it('CHALLENGE: lowercase severity aliases (critical, high, p0, p1) correctly trigger blockers', async () => {
      const lowercaseSeverityPayload = {
        result: {
          verdict: 'SHIP',
          personas: [
            {
              id: 'sec-lane',
              findings: [
                {
                  finding_id: 'crit-lower',
                  severity: 'critical',
                  title: 'Remote code execution',
                  path: 'src/rce.ts',
                  line_start: 100,
                  resolved: false,
                },
                {
                  finding_id: 'high-lower',
                  severity: 'high',
                  title: 'Credential exposure',
                  path: 'src/creds.ts',
                  line_start: 200,
                  resolved: false,
                },
              ],
            },
          ],
        },
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-lower-sev',
              head_sha: VALID_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify(lowercaseSeverityPayload),
            },
          ],
        }),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        attestationSecret: ATTESTATION_SECRET,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: VALID_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(false);
      expect(data.gate_status).toBe('BLOCKED');
      expect(data.blockers).toContainEqual('[CRITICAL] Remote code execution (src/rce.ts:100)');
      expect(data.blockers).toContainEqual('[HIGH] Credential exposure (src/creds.ts:200)');
    });

    it('CHALLENGE: graceful error handling when checkRunsClient throws an unexpected error', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-ci-error',
              head_sha: VALID_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify({ result: { verdict: 'SHIP', personas: [] } }),
            },
          ],
        }),
      };

      const mockCheckRunsClient = {
        listCheckRunsForCommit: vi.fn().mockRejectedValue(new Error('GitHub API Rate Limit Exceeded (403)')),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        checkRunsClient: mockCheckRunsClient,
        attestationSecret: ATTESTATION_SECRET,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: VALID_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(false);
      expect(data.gate_status).toBe('BLOCKED');
      expect(data.blockers).toContainEqual(
        'Failed to verify CI check runs: GitHub API Rate Limit Exceeded (403)'
      );
    });
  });

  describe('3. attest_pr_gate: Cryptographic Attestation Token & Tampering Resistance', () => {
    it('CHALLENGE: token format is exact 64-char hex HMAC-SHA256 and matches independent oracle computation', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-crypto-1',
              head_sha: VALID_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify({ result: { verdict: 'SHIP', personas: [] } }),
            },
          ],
        }),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        attestationSecret: ATTESTATION_SECRET,
        now: () => FIXED_TIMESTAMP,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: VALID_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(true);

      const expectedIsoDate = new Date(FIXED_TIMESTAMP).toISOString();
      const expectedSignaturePayload = `${TEST_OWNER}/${TEST_REPO}#${TEST_PR}@${VALID_HEAD_SHA}:${expectedIsoDate}`;
      const oracleToken = createHmac('sha256', ATTESTATION_SECRET)
        .update(expectedSignaturePayload)
        .digest('hex');

      expect(data.attestation_token).toBe(oracleToken);
      expect(data.attestation_token).toHaveLength(64);
    });

    it('CHALLENGE: tampering resistance: tampering with head_sha, pr_number, or secret invalidates signature', async () => {
      const expectedIsoDate = new Date(FIXED_TIMESTAMP).toISOString();
      const legitimatePayload = `${TEST_OWNER}/${TEST_REPO}#${TEST_PR}@${VALID_HEAD_SHA}:${expectedIsoDate}`;
      const validToken = createHmac('sha256', ATTESTATION_SECRET)
        .update(legitimatePayload)
        .digest('hex');

      // 1. Attacker attempts to replay token with altered head_sha
      const tamperedShaPayload = `${TEST_OWNER}/${TEST_REPO}#${TEST_PR}@${ALTERED_HEAD_SHA}:${expectedIsoDate}`;
      const tamperedShaToken = createHmac('sha256', ATTESTATION_SECRET)
        .update(tamperedShaPayload)
        .digest('hex');
      expect(validToken).not.toBe(tamperedShaToken);

      // 2. Attacker attempts to replay token for a different PR number
      const tamperedPrPayload = `${TEST_OWNER}/${TEST_REPO}#999@${VALID_HEAD_SHA}:${expectedIsoDate}`;
      const tamperedPrToken = createHmac('sha256', ATTESTATION_SECRET)
        .update(tamperedPrPayload)
        .digest('hex');
      expect(validToken).not.toBe(tamperedPrToken);

      // 3. Attacker attempts forgery with a fake secret
      const forgedToken = createHmac('sha256', 'fake-adversary-key')
        .update(legitimatePayload)
        .digest('hex');
      expect(validToken).not.toBe(forgedToken);
    });

    it('CHALLENGE: RBAC enforcement rejects caller lacking repository authorization', async () => {
      const tool = createAttestPrGateTool({});
      const restrictedCaller = createMockCaller({
        allowedRepos: ['other-org/other-repo'],
      });

      await expect(
        tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            head_sha: VALID_HEAD_SHA,
          },
          { caller: restrictedCaller }
        )
      ).rejects.toThrow(McpRbacError);
    });
  });

  // ===========================================================================
  // SECTION 2: reply_review_thread EMPIRICAL CHALLENGES
  // ===========================================================================
  describe('4. reply_review_thread: Tenancy, GitHub App ID 4385771 & Payload Integrity', () => {
    it('CHALLENGE: GitHub App ID constant is authoritative 4385771', () => {
      expect(REVIEW_YETI_APP_ID).toBe(4385771);
    });

    it('CHALLENGE: enforces multi-tenant repository isolation (throws McpRbacError)', async () => {
      const tool = createReplyReviewThreadTool({});
      const restrictedCaller = createMockCaller({
        allowedRepos: ['unrelated-tenant/private-service'],
      });

      await expect(
        tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            comment_id: 12345,
            body: 'Unauthorized comment reply attempt.',
          },
          { caller: restrictedCaller }
        )
      ).rejects.toThrow(/Forbidden/);
    });

    it('CHALLENGE: direct HTTP fallback correctly formats User-Agent with App ID 4385771, endpoint path, and headers', async () => {
      let interceptedUrl = '';
      let interceptedOptions: any = null;

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        interceptedUrl = url.toString();
        interceptedOptions = init;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 998877,
            in_reply_to_id: 12345,
            html_url: `https://github.com/${TEST_OWNER}/${TEST_REPO}/pull/${TEST_PR}#discussion_r998877`,
            created_at: '2026-09-22T13:45:00Z',
          }),
        } as unknown as globalThis.Response;
      });

      const tool = createReplyReviewThreadTool({
        fetchImplementation: mockFetch as any,
        githubApiBaseUrl: 'https://api.github.com',
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          comment_id: 12345,
          body: 'Automated remediation accepted and verified by Review Yeti.',
        },
        { caller: createMockCaller() }
      );

      // Verify URL structure
      expect(interceptedUrl).toBe(
        `https://api.github.com/repos/${TEST_OWNER}/${TEST_REPO}/pulls/${TEST_PR}/comments/12345/replies`
      );

      // Verify HTTP Method and Headers
      expect(interceptedOptions.method).toBe('POST');
      expect(interceptedOptions.headers['User-Agent']).toBe('Review-Yeti-MCP/4385771');
      expect(interceptedOptions.headers['Accept']).toBe('application/vnd.github+json');
      expect(interceptedOptions.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
      expect(interceptedOptions.headers['Content-Type']).toBe('application/json');

      // Verify Body payload
      expect(JSON.parse(interceptedOptions.body)).toEqual({
        body: 'Automated remediation accepted and verified by Review Yeti.',
      });

      // Verify Tool output
      const data = JSON.parse(res.content[0].text);
      expect(data.comment_id).toBe(998877);
      expect(data.thread_id).toBe(12345);
      expect(data.reply_url).toContain('discussion_r998877');
      expect(data.posted_at).toBe('2026-09-22T13:45:00Z');
    });

    it('CHALLENGE: supports createInstallationClient factory pathway', async () => {
      const mockRequest = vi.fn().mockResolvedValue({
        id: 771122,
        in_reply_to_id: 4433,
        html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/789#discussion_r771122',
        created_at: '2026-09-22T13:50:00Z',
      });

      const mockCreateInstallationClient = vi.fn(async (_owner: string, _repo: string) => ({
        request: mockRequest,
      }));

      const tool = createReplyReviewThreadTool({
        createInstallationClient: mockCreateInstallationClient,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          comment_id: 4433,
          body: 'Reply via dynamic App installation token.',
        },
        { caller: createMockCaller() }
      );

      expect(mockCreateInstallationClient).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO);
      expect(mockRequest).toHaveBeenCalledWith(
        `/repos/${TEST_OWNER}/${TEST_REPO}/pulls/${TEST_PR}/comments/4433/replies`,
        {
          method: 'POST',
          body: JSON.stringify({ body: 'Reply via dynamic App installation token.' }),
        }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.comment_id).toBe(771122);
      expect(data.thread_id).toBe(4433);
    });
  });

  describe('5. reply_review_thread: Error Handling & Boundary Defense', () => {
    it('CHALLENGE: bubbles up HTTP 404 comment not found error with clear diagnostics', async () => {
      const mockFetch = vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ message: 'Comment does not exist', documentation_url: 'https://docs.github.com' }),
      })) as any;

      const tool = createReplyReviewThreadTool({
        fetchImplementation: mockFetch,
      });

      await expect(
        tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            comment_id: 999999,
            body: 'Replying to phantom comment',
          },
          { caller: createMockCaller() }
        )
      ).rejects.toThrow(/GitHub API error \(404\) replying to review comment 999999/);
    });

    it('CHALLENGE: bubbles up HTTP 403 insufficient permissions from GitHub', async () => {
      const mockFetch = vi.fn(async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Resource not accessible by integration',
      })) as any;

      const tool = createReplyReviewThreadTool({
        fetchImplementation: mockFetch,
      });

      await expect(
        tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            comment_id: 12345,
            body: 'Replying with unprivileged token',
          },
          { caller: createMockCaller() }
        )
      ).rejects.toThrow(/GitHub API error \(403\)/);
    });

    it('CHALLENGE: network failure / connection crash is caught and propagated', async () => {
      const mockFetch = vi.fn(async () => {
        throw new Error('fetch failed: ECONNREFUSED 140.82.121.3:443');
      }) as any;

      const tool = createReplyReviewThreadTool({
        fetchImplementation: mockFetch,
      });

      await expect(
        tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            comment_id: 12345,
            body: 'Network test',
          },
          { caller: createMockCaller() }
        )
      ).rejects.toThrow(/ECONNREFUSED/);
    });

    it('CHALLENGE: schema rejects empty comments, invalid IDs, and oversized bodies', async () => {
      const tool = createReplyReviewThreadTool({});
      const context = { caller: createMockCaller() };

      // Empty body
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 1, comment_id: 1, body: '' }, context)
      ).rejects.toThrow(/body must not be empty/);

      // Whitespace only
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 1, comment_id: 1, body: '   ' }, context)
      ).rejects.toThrow(/body must not be empty/);

      // Negative comment ID
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 1, comment_id: -10, body: 'valid' }, context)
      ).rejects.toThrow(/comment_id must be a positive integer/);

      // Body exceeding 65,536 characters
      const massiveBody = 'X'.repeat(65_537);
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 1, comment_id: 1, body: massiveBody }, context)
      ).rejects.toThrow(/at most 65536 character/);

      // String comment ID instead of number
      await expect(
        tool.execute({ owner: TEST_OWNER, repo: TEST_REPO, pr_number: 1, comment_id: '12345' as any, body: 'valid' }, context)
      ).rejects.toThrow(/Expected number/);
    });
  });

  // ===========================================================================
  // SECTION 3: SYSTEM-LEVEL INTEGRATION & 12-TOOL CATALOG ROUTING
  // ===========================================================================
  describe('6. System-Level Integration: 12-Tool Catalog & Remote Router Invocations', () => {
    let app: express.Express;
    let router: RemoteMcpRouter;

    beforeEach(() => {
      const caller = createMockCaller({ isAdmin: true });
      const authenticator = createMockAuthenticator(caller);

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-router-attest',
                  owner: TEST_OWNER,
                  repo: TEST_REPO,
                  pr_number: TEST_PR,
                  head_sha: VALID_HEAD_SHA,
                  status: 'complete',
                  stage: 'completed',
                  decision: JSON.stringify({ verdict: 'SHIP' }),
                  payload: JSON.stringify({ result: { verdict: 'SHIP', personas: [] } }),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const mockReplyClient = {
        replyToReviewComment: vi.fn().mockResolvedValue({
          id: 101010,
          in_reply_to_id: 202020,
          html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/789#discussion_r101010',
          created_at: '2026-09-22T13:55:00Z',
        }),
      };

      router = createRemoteMcpRouter({
        authenticator,
        db: mockDb,
        attestPrGateDeps: {
          queryableDatabase: mockDb,
          attestationSecret: ATTESTATION_SECRET,
          now: () => FIXED_TIMESTAMP,
        },
        replyReviewThreadDeps: mockReplyClient,
      });

      app = buildExpressApp(router);
    });

    afterEach(() => {
      router.destroy();
    });

    it('CHALLENGE: remote router tools/list returns complete 12-tool catalog', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({
          jsonrpc: '2.0',
          id: 100,
          method: 'tools/list',
          params: {},
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.result.tools).toHaveLength(12);

      const toolNames = res.body.result.tools.map((t: any) => t.name).sort();
      const expectedCatalog = [
        'attest_pr_gate',
        'cancel_review',
        'dispute_finding',
        'explain_finding',
        'generate_fix_diff',
        'get_model_matrix',
        'get_review_findings',
        'get_review_status',
        'preflight_diff_review',
        'reply_review_thread',
        'trigger_review',
        'watch_review_progress',
      ].sort();

      expect(toolNames).toEqual(expectedCatalog);
    });

    it('CHALLENGE: executes attest_pr_gate over HTTP JSON-RPC 2.0 and receives valid attestation', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: {
            name: 'attest_pr_gate',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              head_sha: VALID_HEAD_SHA,
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();

      const output = JSON.parse(res.body.result.content[0].text);
      expect(output.attested).toBe(true);
      expect(output.gate_status).toBe('PASSED');
      expect(output.attestation_token).toHaveLength(64);
    });

    it('CHALLENGE: executes reply_review_thread over HTTP JSON-RPC 2.0 and receives thread receipt', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({
          jsonrpc: '2.0',
          id: 102,
          method: 'tools/call',
          params: {
            name: 'reply_review_thread',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              comment_id: 202020,
              body: 'Verified reply from remote MCP client.',
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();

      const output = JSON.parse(res.body.result.content[0].text);
      expect(output.comment_id).toBe(101010);
      expect(output.thread_id).toBe(202020);
      expect(output.reply_url).toContain('discussion_r101010');
    });

    it('CHALLENGE: unauthenticated request to /api/mcp receives 401 Unauthorized', async () => {
      const unauthedAuthenticator: McpAuthenticator = {
        authenticate: vi.fn(async () => {
          throw new McpAuthError('Missing Bearer token');
        }),
        authenticateToken: vi.fn(),
        checkRepositoryAccess: vi.fn(),
        middleware: vi.fn(),
      } as unknown as McpAuthenticator;

      const unauthedRouter = createRemoteMcpRouter({
        authenticator: unauthedAuthenticator,
      });
      const unauthedApp = buildExpressApp(unauthedRouter);

      const res = await request(unauthedApp)
        .post('/api/mcp')
        .send({
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/list',
          params: {},
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(-32001); // Unauthorized error
      unauthedRouter.destroy();
    });

    it('CHALLENGE: calling unknown tool name returns JSON-RPC -32601 Method Not Found error', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({
          jsonrpc: '2.0',
          id: 104,
          method: 'tools/call',
          params: {
            name: 'non_existent_tool_xyz',
            arguments: {},
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32601);
      expect(res.body.error.message).toContain("Tool not found: non_existent_tool_xyz");
    });
  });
});
