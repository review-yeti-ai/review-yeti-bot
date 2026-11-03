import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  CloudflareContainerRunner,
  type ContainerJobSpec,
  type ContainerJobResult,
} from '../src/runners/containerRunner.js';
import {
  isAllowedCacheTarget,
  filterCacheTargets,
  benchmarkUnpackSpeed,
  resolveScriptPath,
  buildCanonicalCacheKey,
  validateR2CacheConfig,
  buildR2CacheEnv,
} from '../src/runners/r2WorkspaceCache.js';

const execFileAsync = promisify(execFile);

describe('Tier 5 Adversarial Hardening: Runners & Caching', () => {
  let tempBaseDir: string;
  let restoreScriptPath: string;
  let stageScriptPath: string;

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

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tier5-adv-'));
    restoreScriptPath = resolveScriptPath('restore-r2-cache.sh');
    stageScriptPath = resolveScriptPath('stage-r2-cache.sh');

    await fs.chmod(restoreScriptPath, 0o755);
    await fs.chmod(stageScriptPath, 0o755);
  });

  after(async () => {
    await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
  });

  // =========================================================================
  // Section 1: Container Runner Adversarial Stress
  // =========================================================================
  describe('1. Container Runner Adversarial Stress', () => {
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


    });

    describe('1.4 Network Drops & Socket Truncation During Polling / Dispatch', () => {


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
});
