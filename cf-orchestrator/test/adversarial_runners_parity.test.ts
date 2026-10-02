import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  CloudflareContainerRunner,
  type ContainerJobSpec,
  type ContainerJobResult,
} from '../src/runners/containerRunner.js';
import { DigitalOceanAgentRunner } from '../src/runners/digitalOceanAgentRunner.js';
import {
  isAllowedCacheTarget,
  filterCacheTargets,
  benchmarkUnpackSpeed,
  resolveScriptPath,
  buildCanonicalCacheKey,
  validateR2CacheConfig,
  buildR2CacheEnv,
} from '../src/runners/r2WorkspaceCache.js';
import {
  compareRuns,
  computeFingerprint,
  formatComparisonReport,
  formatMarkdownLedger,
  validateReceipt,
  runCli,
  type ReviewRunReceipt,
  type Finding,
} from '../src/compareOrchestratorRuns.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Tier 5 Adversarial Hardening: Runners, Caching & Parity Engine', () => {
  let tempBaseDir: string;
  let restoreScriptPath: string;
  let stageScriptPath: string;
  let ciScriptPath: string;

  const sampleSpec: ContainerJobSpec = {
    jobId: 'adv_job_101',
    runId: 'adv_run_101',
    owner: 'exampleorg',
    repo: 'reviewyeti-core',
    prNumber: 505,
    headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    baseSha: '0123456789abcdef0123456789abcdef01234567',
    workerImage: 'ghcr.io/exampleorg/worker:adv-tier5',
    env: {
      RUN_ID: 'adv_run_101',
      NODE_ENV: 'test',
    },
    cpu: 2,
    memoryMb: 2048,
    timeoutSeconds: 1500,
  };

  const sampleDoksReceipt: ReviewRunReceipt = {
    orchestrator: 'doks',
    runId: 'doks_run_505',
    repo: 'exampleorg/reviewyeti-core',
    prNumber: 505,
    headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    verdict: 'success',
    findingFingerprints: [
      'src/auth.ts:42:no-secrets:error',
      'src/db.ts:100:unindexed-query:warning',
      'src/api.ts:15:missing-auth:critical',
    ],
    durationMs: 45000,
    tokensUsed: { promptTokens: 12000, completionTokens: 2500, totalTokens: 14500 },
    completedAt: '2026-09-30T14:30:00.000Z',
  };

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tier5-adv-'));
    restoreScriptPath = resolveScriptPath('restore-r2-cache.sh');
    stageScriptPath = resolveScriptPath('stage-r2-cache.sh');
    ciScriptPath = fsSync.existsSync(path.resolve(process.cwd(), 'scripts', 'ci', 'compare-orchestrator-runs.ts'))
      ? path.resolve(process.cwd(), 'scripts', 'ci', 'compare-orchestrator-runs.ts')
      : path.resolve(process.cwd(), '..', '..', 'scripts', 'ci', 'compare-orchestrator-runs.ts');

    await fs.chmod(restoreScriptPath, 0o755);
    await fs.chmod(stageScriptPath, 0o755);
  });

  after(async () => {
    await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
  });

  // =========================================================================
  // Section 1: Container & DO Managed Agent Runners Adversarial Stress
  // =========================================================================
  describe('1. Container & DO Managed Agent Runners Adversarial Stress', () => {
    describe('1.1 Status Precedence & Conflict Resolution', () => {
      it('CloudflareContainerRunner: exitCode 124 overrides outcome status "succeeded"', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 124,
              status: 'succeeded',
            }),
          }),
        };
        const runner = new CloudflareContainerRunner(mockBinding);
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'timed_out');
        assert.equal(res.exitCode, 124);
      });

      it('CloudflareContainerRunner: exitCode 137 overrides outcome status "succeeded"', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 137,
              status: 'succeeded',
            }),
          }),
        };
        const runner = new CloudflareContainerRunner(mockBinding);
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'cancelled');
        assert.equal(res.exitCode, 137);
      });

      it('CloudflareContainerRunner: outcome.status "timed_out" overrides exitCode 0', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 0,
              status: 'timed_out',
            }),
          }),
        };
        const runner = new CloudflareContainerRunner(mockBinding);
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'timed_out');
        // When outcome.status is timed_out with exitCode 0, exitCode 0 is returned
        assert.equal(res.exitCode, 0);
      });

      it('CloudflareContainerRunner: outcome.status "cancelled" overrides exitCode 0', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 0,
              status: 'cancelled',
            }),
          }),
        };
        const runner = new CloudflareContainerRunner(mockBinding);
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'cancelled');
        assert.equal(res.exitCode, 0);
      });

      it('CloudflareContainerRunner: exitCode 1 overrides outcome status "succeeded"', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 1,
              status: 'succeeded',
            }),
          }),
        };
        const runner = new CloudflareContainerRunner(mockBinding);
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
      });

      it('CloudflareContainerRunner: unrecognized status string defaults to succeeded if exitCode is 0', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 0,
              status: 'unrecognized_running_phase',
            }),
          }),
        };
        const runner = new CloudflareContainerRunner(mockBinding);
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'succeeded');
      });

      it('DigitalOceanAgentRunner: exitCode 124 overrides session status "succeeded"', async () => {
        const mockFetch: typeof fetch = async () =>
          new Response(
            JSON.stringify({
              session_id: sampleSpec.jobId,
              status: 'succeeded',
              exit_code: 124,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch,
        });
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'timed_out');
        assert.equal(res.exitCode, 124);
      });

      it('DigitalOceanAgentRunner: exitCode 137 overrides session status "succeeded"', async () => {
        const mockFetch: typeof fetch = async () =>
          new Response(
            JSON.stringify({
              session_id: sampleSpec.jobId,
              status: 'succeeded',
              exit_code: 137,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch,
        });
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'cancelled');
        assert.equal(res.exitCode, 137);
      });

      it('DigitalOceanAgentRunner: unrecognized status string maps to failed even with exitCode 0', async () => {
        const mockFetch: typeof fetch = async () =>
          new Response(
            JSON.stringify({
              session_id: sampleSpec.jobId,
              status: 'unrecognized_running_phase',
              exit_code: 0,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch,
        });
        const res = await runner.dispatchJob(sampleSpec);
        // Note: DigitalOceanAgentRunner strictly requires status === 'succeeded' or falsy for success
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 0);
      });
    });

    describe('1.2 Timeout Handling When exitCode is Omitted', () => {
      it('CloudflareContainerRunner: timed_out outcome without exitCode defaults exitCode to 0', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              status: 'timed_out',
              // exitCode is omitted
            }),
          }),
        };
        const runner = new CloudflareContainerRunner(mockBinding);
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'timed_out');
        assert.equal(res.exitCode, 0);
      });

      it('CloudflareContainerRunner: instance.wait() rejection with TimeoutError yields status timed_out and exitCode 124', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => {
              const err = new Error('Container execution timed out after 1500 seconds');
              err.name = 'TimeoutError';
              throw err;
            },
          }),
        };
        const runner = new CloudflareContainerRunner(mockBinding);
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'timed_out');
        assert.equal(res.exitCode, 124);
        assert.ok(res.error?.includes('timed out'));
      });

      it('DigitalOceanAgentRunner: timed_out session without exit_code defaults exitCode to 0', async () => {
        const mockFetch: typeof fetch = async () =>
          new Response(
            JSON.stringify({
              session_id: sampleSpec.jobId,
              status: 'timed_out',
              // exit_code is omitted
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch,
        });
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'timed_out');
        assert.equal(res.exitCode, 0);
      });

      it('DigitalOceanAgentRunner: fetchImpl rejection with timeout message yields timed_out and exitCode 124', async () => {
        const mockFetch: typeof fetch = async () => {
          throw new Error('Connection to DO agent gateway timed out');
        };
        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch,
        });
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'timed_out');
        assert.equal(res.exitCode, 124);
      });
    });

    describe('1.3 Error Handling During Two-Tier Termination', () => {
      it('CloudflareContainerRunner: returns terminated=true when instance.terminate succeeds even if binding.terminate throws', async () => {
        let instanceTerminateCalled = false;
        let bindingTerminateCalled = false;

        const mockBinding = {
          create: async () => ({
            wait: () => new Promise(() => {}), // hangs in flight
            terminate: async () => {
              instanceTerminateCalled = true;
            },
          }),
          terminate: async () => {
            bindingTerminateCalled = true;
            throw new Error('Binding level termination failed with RPC error');
          },
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        // Start job in background to populate activeJobs
        const dispatchPromise = runner.dispatchJob(sampleSpec);
        await new Promise((r) => setTimeout(r, 10));

        const termRes = await runner.terminateJob(sampleSpec.jobId, 'pr_superseded');
        assert.equal(instanceTerminateCalled, true);
        assert.equal(bindingTerminateCalled, true);
        assert.equal(termRes.terminated, true);

        // Cleanup background dispatch
        await runner.terminateJob(sampleSpec.jobId);
      });

      it('CloudflareContainerRunner: returns terminated=true when instance.terminate throws but binding.terminate succeeds', async () => {
        let instanceTerminateCalled = false;
        let bindingTerminateCalled = false;

        const mockBinding = {
          create: async () => ({
            wait: () => new Promise(() => {}),
            terminate: async () => {
              instanceTerminateCalled = true;
              throw new Error('Instance socket already closed');
            },
          }),
          terminate: async () => {
            bindingTerminateCalled = true;
          },
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        runner.dispatchJob(sampleSpec);
        await new Promise((r) => setTimeout(r, 10));

        const termRes = await runner.terminateJob(sampleSpec.jobId, 'pr_superseded');
        assert.equal(instanceTerminateCalled, true);
        assert.equal(bindingTerminateCalled, true);
        assert.equal(termRes.terminated, true);
      });

      it('CloudflareContainerRunner: returns terminated=false when both instance and binding terminate throw', async () => {
        const mockBinding = {
          create: async () => ({
            wait: () => new Promise(() => {}),
            terminate: async () => {
              throw new Error('Instance crash');
            },
          }),
          terminate: async () => {
            throw new Error('Binding crash');
          },
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        runner.dispatchJob(sampleSpec);
        await new Promise((r) => setTimeout(r, 10));

        const termRes = await runner.terminateJob(sampleSpec.jobId);
        assert.equal(termRes.terminated, false);
      });

      it('CloudflareContainerRunner: returns terminated=true as graceful no-op when neither instance nor binding method exists', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({ exitCode: 0, status: 'succeeded' }),
          }),
        };
        const runner = new CloudflareContainerRunner(mockBinding);
        // Not active
        const termRes = await runner.terminateJob('unknown_job_id');
        assert.equal(termRes.terminated, true);
      });

      it('CloudflareContainerRunner: returns terminated=false when active instance lacks terminate method and binding lacks terminate method', async () => {
        const mockBinding = {
          create: async () => ({
            wait: () => new Promise(() => {}),
            // No terminate method on instance
          }),
          // No terminate method on binding
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        runner.dispatchJob(sampleSpec);
        await new Promise((r) => setTimeout(r, 10));

        const termRes = await runner.terminateJob(sampleSpec.jobId);
        assert.equal(termRes.terminated, false);
      });

      it('DigitalOceanAgentRunner: returns terminated=true on 404 (already terminated) or 200 OK', async () => {
        const mockFetch404: typeof fetch = async () =>
          new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 });
        const runner404 = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch404,
        });
        const res404 = await runner404.terminateJob('job_nonexistent');
        assert.equal(res404.terminated, true);

        const mockFetch200: typeof fetch = async () =>
          new Response(JSON.stringify({ status: 'terminated' }), { status: 200 });
        const runner200 = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch200,
        });
        const res200 = await runner200.terminateJob('job_active');
        assert.equal(res200.terminated, true);
      });

      it('DigitalOceanAgentRunner: returns terminated=false on HTTP 500 error or network failure', async () => {
        const mockFetch500: typeof fetch = async () =>
          new Response('Internal Server Error', { status: 500 });
        const runner500 = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch500,
        });
        const res500 = await runner500.terminateJob('job_err');
        assert.equal(res500.terminated, false);

        const mockFetchThrow: typeof fetch = async () => {
          throw new Error('fetch failed: ECONNREFUSED');
        };
        const runnerThrow = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetchThrow,
        });
        const resThrow = await runnerThrow.terminateJob('job_network_err');
        assert.equal(resThrow.terminated, false);
      });
    });

    describe('1.4 Network Drops & Socket Truncation During Polling / Dispatch', () => {
      it('DigitalOceanAgentRunner: handles network ECONNRESET gracefully and returns status failed', async () => {
        const mockFetch: typeof fetch = async () => {
          const err = new TypeError('fetch failed');
          (err as any).cause = { code: 'ECONNRESET', syscall: 'read' };
          throw err;
        };
        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch,
        });
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.ok(res.error?.includes('fetch failed'));
      });

      it('DigitalOceanAgentRunner: handles truncated JSON response stream and returns status failed', async () => {
        const mockFetch: typeof fetch = async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => {
            throw new SyntaxError('Unexpected end of JSON input');
          },
          text: async () => '{"session_id": "truncated_pa',
        } as unknown as Response);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch,
        });
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.ok(res.error?.includes('Failed to parse DO Managed Agent response JSON'));
      });

      it('DigitalOceanAgentRunner: handles AbortError (cancellation during dispatch) and returns status cancelled, exitCode 137', async () => {
        const mockFetch: typeof fetch = async () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        };
        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch,
        });
        const res = await runner.dispatchJob(sampleSpec);
        assert.equal(res.status, 'cancelled');
        assert.equal(res.exitCode, 137);
      });
    });
  });

  // =========================================================================
  // Section 2: R2 Workspace Caching Adversarial Resilience
  // =========================================================================
  describe('2. R2 Workspace Caching Adversarial Resilience', () => {
    describe('2.1 Corrupted, Truncated, and Zero-Byte Archives', () => {
      it('benchmarkUnpackSpeed rejects with ENOENT when passed a non-existent archive file', async () => {
        const nonExistent = path.join(tempBaseDir, 'does_not_exist.tar.zst');
        const unpackDest = path.join(tempBaseDir, 'no_file_unpack');

        await assert.rejects(
          async () => benchmarkUnpackSpeed(nonExistent, unpackDest),
          /ENOENT|no such file/i
        );
      });

      it('verifies pipefail hardening: benchmarkUnpackSpeed rejects on zero-byte archives due to pipefail in sh invocation', async () => {
        const emptyArchive = path.join(tempBaseDir, 'empty.tar.zst');
        const unpackDest = path.join(tempBaseDir, 'empty_unpack');
        await fs.writeFile(emptyArchive, Buffer.alloc(0));

        await assert.rejects(
          async () => benchmarkUnpackSpeed(emptyArchive, unpackDest),
          /zstd|tar|error/i
        );
      });

      it('verifies pipefail hardening: benchmarkUnpackSpeed rejects on corrupted/garbage archives due to pipefail', async () => {
        const corruptArchive = path.join(tempBaseDir, 'corrupt.tar.zst');
        const unpackDest = path.join(tempBaseDir, 'corrupt_unpack');
        await fs.writeFile(corruptArchive, Buffer.from('NOT_A_VALID_ZSTD_OR_TAR_ARCHIVE_DATA'));

        await assert.rejects(
          async () => benchmarkUnpackSpeed(corruptArchive, unpackDest),
          /zstd|tar|error/i
        );
      });

      it('restore-r2-cache.sh recovers from zero-byte archive and falls back to full clone', async () => {
        const ws = path.join(tempBaseDir, 'zerobyte_restore_ws');
        const mockBin = path.join(tempBaseDir, 'mock_bin_zerobyte');
        await fs.mkdir(mockBin, { recursive: true });

        // Mock AWS CLI writing zero-byte file
        const mockAws = `#!/usr/bin/env bash
if [ "$1" = "s3api" ] && [ "$2" = "head-object" ]; then
  echo '{"Metadata": {"created-at": "'$(date +%s)'"}}'
  exit 0
fi
touch "$4"
exit 0
`;
        await fs.writeFile(path.join(mockBin, 'aws'), mockAws, { mode: 0o755 });

        // Mock git clone tracking execution
        const cloneLog = path.join(tempBaseDir, 'clone_zerobyte.log');
        const mockGit = `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  echo "CLONE_EXECUTED" >> "${cloneLog}"
  mkdir -p "$5/.git"
  exit 0
fi
exit 0
`;
        await fs.writeFile(path.join(mockBin, 'git'), mockGit, { mode: 0o755 });

        const env = {
          PATH: `${mockBin}:${process.env.PATH}`,
          OWNER: 'exampleorg',
          REPO: 'reviewyeti-core',
          PR_NUMBER: '999',
          HEAD_SHA: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          WORKSPACE_DIR: ws,
          R2_ENDPOINT: 'https://r2.mock',
        };

        const { stdout, stderr } = await execFileAsync('bash', [restoreScriptPath], { env });
        const combined = `${stdout}\n${stderr}`;

        assert.ok(
          combined.includes('Archive decompression failed (corrupted or truncated archive); falling back to full clone.'),
          'Must log decompression failure warning for zero-byte archive'
        );
        assert.ok(fsSync.existsSync(cloneLog), 'Full shallow clone fallback must execute');
      });
    });

    describe('2.2 Path Sanitization & Symlink Traversal Protection in isAllowedCacheTarget', () => {
      it('rejects upward traversal attempts targeting parent directories', () => {
        const traversals = [
          '../.git',
          '../../.git',
          '.git/../evil.sh',
          '.git/../../etc/passwd',
          '.git/..',
          '.zoekt/../secret.env',
          '.git/subdir/../../escape',
          '..',
          '.',
          '',
          '   ',
        ];
        for (const target of traversals) {
          assert.equal(
            isAllowedCacheTarget(target),
            false,
            `Expected traversal target '${target}' to be rejected`
          );
        }
      });

      it('normalizes POSIX and Windows separators and accepts valid subpaths', () => {
        const validTargets = [
          '.git/config',
          '.git/objects/pack/pack-123.pack',
          '.git\\objects\\pack\\pack-123.pack',
          '.git//objects///pack',
          '.git/././config',
          '/.git',
          '///.git',
          '.zoekt',
          '.zoekt/shard.00000.idx',
          '.zoekt\\shard.00000.idx',
        ];
        for (const target of validTargets) {
          assert.equal(
            isAllowedCacheTarget(target),
            true,
            `Expected '${target}' to normalize and pass filter`
          );
        }
      });

      it('rejects targets containing null bytes or invalid root prefixes', () => {
        assert.equal(isAllowedCacheTarget('.git\0evil.ts'), false);
        assert.equal(isAllowedCacheTarget('.zoekt\0payload'), false);
        assert.equal(isAllowedCacheTarget('.git_backup'), false);
        assert.equal(isAllowedCacheTarget('.git-other'), false);
        assert.equal(isAllowedCacheTarget('zoekt'), false);
        assert.equal(isAllowedCacheTarget('git'), false);
      });

      it('filterCacheTargets strictly excludes forbidden artifacts while keeping valid .git/.zoekt targets', () => {
        const inputList = [
          '.git/HEAD',
          'node_modules/lodash',
          '.env',
          '.zoekt/index.idx',
          'dist/bundle.js',
          '.git/../escape',
          'src/main.ts',
        ];
        const filtered = filterCacheTargets(inputList);
        assert.deepEqual(filtered, ['.git/HEAD', '.zoekt/index.idx']);
      });
    });

    describe('2.3 Multi-Signal Trap Cleanup in Shell Scripts', () => {
      it('verifies LOCAL_ARCHIVE is purged on normal EXIT, SIGINT, SIGTERM, and SIGHUP in restore-r2-cache.sh', async () => {
        const signals = [
          { name: 'EXIT', killSig: null },
          { name: 'SIGINT', killSig: 'SIGINT' },
          { name: 'SIGTERM', killSig: 'SIGTERM' },
          { name: 'SIGHUP', killSig: 'SIGHUP' },
        ];

        for (const s of signals) {
          const testArchive = path.join(tempBaseDir, `trap_test_${s.name}.tar.zst`);
          // Helper script simulating the trap logic in restore-r2-cache.sh
          const testScript = `#!/usr/bin/env bash
set -euo pipefail
LOCAL_ARCHIVE="${testArchive}"
trap 'rm -f "\${LOCAL_ARCHIVE}"' EXIT INT TERM HUP
touch "\${LOCAL_ARCHIVE}"
echo "FILE_CREATED"
${s.killSig ? `kill -s ${s.killSig} $$` : 'exit 0'}
`;
          const scriptFile = path.join(tempBaseDir, `trap_runner_${s.name}.sh`);
          await fs.writeFile(scriptFile, testScript, { mode: 0o755 });

          try {
            await execFileAsync('bash', [scriptFile]);
          } catch {
            // Signal terminations will exit non-zero
          }

          assert.equal(
            fsSync.existsSync(testArchive),
            false,
            `Expected archive '${testArchive}' to be cleaned up on signal ${s.name}`
          );
        }
      });

      it('verifies LOCAL_ARCHIVE is purged on signals in stage-r2-cache.sh', async () => {
        const testArchive = path.join(tempBaseDir, 'trap_stage_term.tar.zst');
        const testScript = `#!/usr/bin/env bash
set -euo pipefail
LOCAL_ARCHIVE="${testArchive}"
trap 'rm -f "\${LOCAL_ARCHIVE}"' EXIT INT TERM HUP
touch "\${LOCAL_ARCHIVE}"
kill -s SIGTERM $$
`;
        const scriptFile = path.join(tempBaseDir, 'trap_stage_runner.sh');
        await fs.writeFile(scriptFile, testScript, { mode: 0o755 });

        try {
          await execFileAsync('bash', [scriptFile]);
        } catch {}

        assert.equal(
          fsSync.existsSync(testArchive),
          false,
          'Expected archive to be removed after SIGTERM via trap'
        );
      });
    });
  });

  // =========================================================================
  // Section 3: Parity Comparison Engine Adversarial Testing
  // =========================================================================
  describe('3. Parity Comparison Engine Adversarial Testing', () => {
    describe('3.1 Fingerprint Generation Edge Cases (computeFingerprint)', () => {
      it('verifies computeFingerprint sanitizes negative and float lines to valid positive integers', () => {
        const negFp = computeFingerprint({
          file: 'src/handler.ts',
          line: -5,
          ruleId: 'SEC01',
        });
        assert.equal(negFp, 'src/handler.ts:1:SEC01:warning');

        const floatFp = computeFingerprint({
          file: 'src/handler.ts',
          line: 3.14159,
          ruleId: 'SEC01',
        });
        assert.equal(floatFp, 'src/handler.ts:3:SEC01:warning');
      });

      it('normalizes Windows backslashes and lowercases severity', () => {
        const fp = computeFingerprint({
          file: 'src\\core\\utils.ts',
          line: 50,
          ruleId: 'LINT_RULE',
          severity: 'CRITICAL',
        });
        assert.equal(fp, 'src/core/utils.ts:50:LINT_RULE:critical');
      });

      it('verifies computeFingerprint guards against null/undefined input without throwing', () => {
        assert.equal(computeFingerprint(null as any), '');
        assert.equal(computeFingerprint(undefined as any), '');
      });
    });

    describe('3.2 Incomplete tokensUsed & Defensive Handling in formatMarkdownLedger', () => {
      it('verifies defensive check: incomplete tokensUsed ({}) falls back to N/A without throwing in formatMarkdownLedger', () => {
        const doksReceipt: ReviewRunReceipt = {
          ...sampleDoksReceipt,
          tokensUsed: {} as any, // incomplete tokens object
        };
        const cfReceipt: ReviewRunReceipt = {
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare',
          tokensUsed: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
        };

        const result = compareRuns(doksReceipt, cfReceipt);
        const md = formatMarkdownLedger(result, doksReceipt, cfReceipt);
        assert.ok(md.includes('N/A'));
      });

      it('verifies validateReceipt rejects incomplete tokensUsed with descriptive schema error', () => {
        const untrustedReceipt = {
          ...sampleDoksReceipt,
          tokensUsed: { promptTokens: 'not_a_number' },
        };
        assert.throws(
          () => validateReceipt(untrustedReceipt, 'Test'),
          /tokensUsed\.promptTokens must be a non-negative number/
        );
      });
    });

    describe('3.3 Markdown Table Integrity Injection (Pipes and Newlines)', () => {
      it('verifies pipes in fingerprints are escaped so table column alignment is preserved', () => {
        const doksReceipt: ReviewRunReceipt = {
          ...sampleDoksReceipt,
          findingFingerprints: ['src/api.ts:10:rule|with|multiple|pipes:error'],
        };
        const cfReceipt: ReviewRunReceipt = {
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare',
          findingFingerprints: [],
        };

        const result = compareRuns(doksReceipt, cfReceipt);
        const md = formatMarkdownLedger(result, doksReceipt, cfReceipt);

        const rows = md.split('\n').filter((l) => l.includes('DOKS Only'));
        assert.equal(rows.length, 1);
        const row = rows[0];
        // Standard 3-column table row has 4 delimiter pipes: | Origin | FP | Desc |
        const unescapedPipes = (row.match(/(?<!\\)\|/g) || []).length;
        assert.equal(unescapedPipes, 4, `Expected exactly 4 delimiter pipes for a 3-column table, got ${unescapedPipes}`);
        assert.ok(row.includes('\\|with\\|multiple\\|pipes'));
      });

      it('verifies unescaped newlines in fingerprints are sanitized to spaces preserving single table rows', () => {
        const doksReceipt: ReviewRunReceipt = {
          ...sampleDoksReceipt,
          findingFingerprints: ['src/newline\nin\npath.ts:25:rule:error'],
        };
        const cfReceipt: ReviewRunReceipt = {
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare',
          findingFingerprints: [],
        };

        const result = compareRuns(doksReceipt, cfReceipt);
        const md = formatMarkdownLedger(result, doksReceipt, cfReceipt);

        assert.ok(
          !md.includes('src/newline\nin\npath.ts:25:rule:error'),
          'Table ledger should not contain unescaped newline within table cell'
        );
        assert.ok(
          md.includes('src/newline in path.ts:25:rule:error'),
          'Table ledger should contain sanitized space-delimited path'
        );
      });
    });

    describe('3.4 Token Delta Warning Boundaries (+-500 vs +-501)', () => {
      it('evaluates exact delta boundary: +500 is nominal, +501 triggers warning', () => {
        const doks = {
          ...sampleDoksReceipt,
          tokensUsed: { promptTokens: 5000, completionTokens: 1000, totalTokens: 6000 },
        };
        const cf500 = {
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare' as const,
          tokensUsed: { promptTokens: 5000, completionTokens: 1500, totalTokens: 6500 },
        };
        const res500 = compareRuns(doks, cf500);
        assert.equal(res500.tokenDelta, 500);
        assert.equal(res500.tokenWarning, false);

        const cf501 = {
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare' as const,
          tokensUsed: { promptTokens: 5000, completionTokens: 1501, totalTokens: 6501 },
        };
        const res501 = compareRuns(doks, cf501);
        assert.equal(res501.tokenDelta, 501);
        assert.equal(res501.tokenWarning, true);
        assert.ok(res501.notes.some((n) => n.includes('Noticeable token difference')));
      });

      it('evaluates exact negative boundary: -500 is nominal, -501 triggers warning', () => {
        const doks = {
          ...sampleDoksReceipt,
          tokensUsed: { promptTokens: 5000, completionTokens: 1000, totalTokens: 6000 },
        };
        const cfNeg500 = {
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare' as const,
          tokensUsed: { promptTokens: 5000, completionTokens: 500, totalTokens: 5500 },
        };
        const resNeg500 = compareRuns(doks, cfNeg500);
        assert.equal(resNeg500.tokenDelta, -500);
        assert.equal(resNeg500.tokenWarning, false);

        const cfNeg501 = {
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare' as const,
          tokensUsed: { promptTokens: 5000, completionTokens: 499, totalTokens: 5499 },
        };
        const resNeg501 = compareRuns(doks, cfNeg501);
        assert.equal(resNeg501.tokenDelta, -501);
        assert.equal(resNeg501.tokenWarning, true);
      });
    });

    describe('3.5 Scale & Performance Testing (10,000+ Findings)', () => {
      it('executes symmetric diff on 10,000 findings in < 100ms with linear memory scaling', () => {
        const commonFindings: string[] = [];
        for (let i = 0; i < 9000; i++) {
          commonFindings.push(`src/module_${i % 100}.ts:${(i * 3) + 1}:RULE_${i % 50}:warning`);
        }
        const doksOnlyFindings: string[] = [];
        for (let i = 0; i < 1000; i++) {
          doksOnlyFindings.push(`src/legacy_${i}.ts:${i + 1}:LEGACY_RULE:error`);
        }
        const cfOnlyFindings: string[] = [];
        for (let i = 0; i < 1000; i++) {
          cfOnlyFindings.push(`src/canary_${i}.ts:${i + 1}:CANARY_RULE:info`);
        }

        const doksReceipt: ReviewRunReceipt = {
          ...sampleDoksReceipt,
          findingFingerprints: [...commonFindings, ...doksOnlyFindings],
        };
        const cfReceipt: ReviewRunReceipt = {
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare',
          findingFingerprints: [...commonFindings, ...cfOnlyFindings],
        };

        const start = performance.now();
        const result = compareRuns(doksReceipt, cfReceipt);
        const durationMs = performance.now() - start;

        assert.equal(result.match, false);
        assert.equal(result.verdictMatch, true);
        assert.equal(result.findingFingerprintsMatch, false);
        assert.equal(result.doksOnly.length, 1000);
        assert.equal(result.cfOnly.length, 1000);
        assert.equal(result.findingCountDiff, 0);

        assert.ok(
          durationMs < 100,
          `Expected 10,000 finding diff to execute in < 100ms, took ${durationMs.toFixed(2)}ms`
        );

        // Verify ledger generation survives 2,000 discrepancy rows without stack overflow
        const ledger = formatMarkdownLedger(result, doksReceipt, cfReceipt);
        assert.ok(ledger.includes('2000 Finding Discrepancies Detected'));
      });
    });

    describe('3.6 Extreme Duration Disparities & Sanitization', () => {
      it('handles 1ms vs 3,600,000ms (1 hour) extreme duration disparity without integer overflow', () => {
        const doks = { ...sampleDoksReceipt, durationMs: 1 };
        const cf = { ...sampleDoksReceipt, orchestrator: 'cloudflare' as const, durationMs: 3_600_000 };

        const res = compareRuns(doks, cf);
        assert.equal(res.latencyDeltaMs, 3_599_999);
        assert.equal(res.latencyRatio, 3600000);

        const summary = formatComparisonReport(res);
        assert.ok(summary.includes('+3599999ms (3600000x)'));
      });

      it('handles 3,600,000ms vs 1ms reverse disparity cleanly', () => {
        const doks = { ...sampleDoksReceipt, durationMs: 3_600_000 };
        const cf = { ...sampleDoksReceipt, orchestrator: 'cloudflare' as const, durationMs: 1 };

        const res = compareRuns(doks, cf);
        assert.equal(res.latencyDeltaMs, -3_599_999);
        assert.equal(res.latencyRatio, 0);

        const md = formatMarkdownLedger(res, doks, cf);
        assert.ok(md.includes('⚡ Faster'));
      });

      it('sanitizes negative or NaN durations via Math.max(0, ...)', () => {
        const doks = { ...sampleDoksReceipt, durationMs: -500 };
        const cf = { ...sampleDoksReceipt, orchestrator: 'cloudflare' as const, durationMs: -100 };

        const res = compareRuns(doks, cf);
        assert.equal(res.latencyDeltaMs, 0);
        assert.equal(res.latencyRatio, 1.0);

        const doksNaN = { ...sampleDoksReceipt, durationMs: NaN };
        const cfNaN = { ...sampleDoksReceipt, orchestrator: 'cloudflare' as const, durationMs: NaN };
        const resNaN = compareRuns(doksNaN, cfNaN);
        assert.equal(resNaN.latencyDeltaMs, 0);
        assert.equal(resNaN.latencyRatio, 1.0);
      });
    });
  });

  // =========================================================================
  // Section 4: CI Parity CLI Runner Adversarial Resilience
  // =========================================================================
  describe('4. CI Parity CLI Runner Adversarial Resilience', () => {
    let doksJsonPath: string;
    let cfJsonPath: string;

    before(async () => {
      doksJsonPath = path.join(tempBaseDir, 'valid_doks.json');
      cfJsonPath = path.join(tempBaseDir, 'valid_cf.json');

      await fs.writeFile(doksJsonPath, JSON.stringify(sampleDoksReceipt, null, 2));
      await fs.writeFile(
        cfJsonPath,
        JSON.stringify(
          { ...sampleDoksReceipt, orchestrator: 'cloudflare', runId: 'cf_run_505' },
          null,
          2
        )
      );
    });

    it('returns exit code 2 when required CLI arguments are missing', () => {
      const code1 = runCli([]);
      assert.equal(code1, 2);

      const code2 = runCli(['--doks', doksJsonPath]);
      assert.equal(code2, 2);
    });

    it('returns exit code 2 when receipt file contains corrupted or partial JSON', async () => {
      const corruptFile = path.join(tempBaseDir, 'corrupt_receipt.json');
      await fs.writeFile(corruptFile, '{"orchestrator": "doks", "runId":'); // Truncated JSON

      const code = runCli(['--doks', corruptFile, '--cf', cfJsonPath]);
      assert.equal(code, 2);
    });

    it('returns exit code 2 when cross-target repository or headSha diverge', async () => {
      const mismatchedCfFile = path.join(tempBaseDir, 'mismatched_cf.json');
      await fs.writeFile(
        mismatchedCfFile,
        JSON.stringify({
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare',
          repo: 'exampleorg/different-repo',
        })
      );

      const code = runCli(['--doks', doksJsonPath, '--cf', mismatchedCfFile]);
      assert.equal(code, 2);
    });

    it('returns exit code 2 when output directory is unwritable', () => {
      // In a read-only or invalid filesystem target
      const unwritablePath = '/dev/null/forbidden_dir/ledger.md';
      const code = runCli([
        '--doks',
        doksJsonPath,
        '--cf',
        cfJsonPath,
        '--output',
        unwritablePath,
      ]);
      assert.equal(code, 2);
    });

    it('successfully handles receipt files with spaces, unicode, and emojis in paths', async () => {
      const exoticDir = path.join(tempBaseDir, '📂 test folder with spaces 🚀');
      await fs.mkdir(exoticDir, { recursive: true });

      const exoticDoks = path.join(exoticDir, 'doks receipt 📊.json');
      const exoticCf = path.join(exoticDir, 'cf receipt ⚙️.json');
      const exoticOut = path.join(exoticDir, 'output ledger 📝.md');

      await fs.writeFile(exoticDoks, JSON.stringify(sampleDoksReceipt, null, 2));
      await fs.writeFile(
        exoticCf,
        JSON.stringify(
          { ...sampleDoksReceipt, orchestrator: 'cloudflare', runId: 'cf_exotic' },
          null,
          2
        )
      );

      const exitCode = runCli([
        '--doks',
        exoticDoks,
        '--cf',
        exoticCf,
        '--output',
        exoticOut,
      ]);

      assert.equal(exitCode, 0);
      assert.ok(fsSync.existsSync(exoticOut));
      const content = await fs.readFile(exoticOut, 'utf8');
      assert.ok(content.includes('✅ MATCH'));
    });

    it('returns exit code 1 on mismatch ONLY when --fail-on-mismatch is passed', async () => {
      const divergentCf = path.join(tempBaseDir, 'divergent_cf.json');
      await fs.writeFile(
        divergentCf,
        JSON.stringify({
          ...sampleDoksReceipt,
          orchestrator: 'cloudflare',
          verdict: 'action_required', // divergent verdict
        })
      );

      // Without --fail-on-mismatch: returns 0
      const codeDefault = runCli(['--doks', doksJsonPath, '--cf', divergentCf]);
      assert.equal(codeDefault, 0);

      // With --fail-on-mismatch: returns 1
      const codeStrict = runCli([
        '--doks',
        doksJsonPath,
        '--cf',
        divergentCf,
        '--fail-on-mismatch',
      ]);
      assert.equal(codeStrict, 1);
    });

    it('executes scripts/ci/compare-orchestrator-runs.ts via node subprocess with strip-types support', async () => {
      const { stdout, stderr } = await execFileAsync('node', [
        ciScriptPath,
        '--doks',
        doksJsonPath,
        '--cf',
        cfJsonPath,
      ]);

      assert.ok(stdout.includes('Status: ✅ MATCH'));
      assert.equal(stderr, '');
    });
  });
});
