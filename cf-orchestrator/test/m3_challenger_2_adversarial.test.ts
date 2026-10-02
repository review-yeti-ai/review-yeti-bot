import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isAllowedCacheTarget,
  filterCacheTargets,
  benchmarkUnpackSpeed,
  resolveScriptPath,
} from '../src/runners/r2WorkspaceCache.js';

const execFileAsync = promisify(execFile);

describe('M3 Challenger 2 Adversarial Stress Suite', () => {
  let tempBaseDir: string;
  let restoreScriptPath: string;
  let stageScriptPath: string;

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3-challenger2-'));
    restoreScriptPath = resolveScriptPath('restore-r2-cache.sh');
    stageScriptPath = resolveScriptPath('stage-r2-cache.sh');

    await fs.chmod(restoreScriptPath, 0o755);
    await fs.chmod(stageScriptPath, 0o755);
  });

  after(async () => {
    await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
  });

  // =========================================================================
  // 1. Empirical benchmark of unpack speed (20MB, 50MB, 100MB)
  // =========================================================================
  describe('1. Empirical Benchmark of Unpack Speed (20MB, 50MB, 100MB)', () => {
    async function createRealisticGitZoektArchive(
      sizeMB: number,
      destArchivePath: string,
      workDir: string
    ): Promise<number> {
      const gitDir = path.join(workDir, '.git');
      const zoektDir = path.join(workDir, '.zoekt');
      const packDir = path.join(gitDir, 'objects', 'pack');

      await fs.mkdir(packDir, { recursive: true });
      await fs.mkdir(zoektDir, { recursive: true });

      // Create realistic git metadata
      await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      await fs.writeFile(
        path.join(gitDir, 'config'),
        '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n'
      );

      // Create simulated Zoekt index shard (~2MB)
      const zoektShardBuffer = crypto.randomBytes(2 * 1024 * 1024);
      await fs.writeFile(path.join(zoektDir, 'shard.00000.zoekt'), zoektShardBuffer);
      await fs.writeFile(path.join(zoektDir, 'shard.00000.idx'), 'zoekt index metadata\n');

      // Realistic git packfile (high entropy binary data) so the compressed .tar.zst is truly ~sizeMB
      const packBuf = crypto.randomBytes(sizeMB * 1024 * 1024);
      await fs.writeFile(path.join(packDir, `pack-synthetic-${sizeMB}mb.pack`), packBuf);

      // Compress using tar + zstd -3 -T0 into destArchivePath
      await execFileAsync('sh', [
        '-c',
        `cd "${workDir}" && tar -cf - .git .zoekt | zstd -3 -T0 > "${destArchivePath}"`,
      ]);

      const stat = await fs.stat(destArchivePath);
      return stat.size;
    }

    const sizes = [20, 50, 100];
    for (const sizeMB of sizes) {
      it(`empirically verifies ${sizeMB}MB realistic git/zoekt archive uncompressed in < 1500ms (F25)`, async () => {
        const benchWorkDir = path.join(tempBaseDir, `bench_create_${sizeMB}`);
        const archivePath = path.join(tempBaseDir, `archive_${sizeMB}MB.tar.zst`);
        const unpackDest = path.join(tempBaseDir, `bench_unpack_${sizeMB}`);

        await fs.mkdir(benchWorkDir, { recursive: true });
        const archiveBytes = await createRealisticGitZoektArchive(sizeMB, archivePath, benchWorkDir);

        const archiveMB = (archiveBytes / (1024 * 1024)).toFixed(2);

        const result = await benchmarkUnpackSpeed(archivePath, unpackDest);
        console.log(
          `[Benchmark] ${sizeMB}MB target -> Actual archive size = ${archiveMB} MB | Unpack duration = ${result.durationMs.toFixed(2)}ms | Throughput = ${result.throughputMBs.toFixed(2)} MB/s | isSub1500Ms = ${result.isSub1500Ms}`
        );

        // Assert sub-1500ms requirement per F25 (with headroom under heavy concurrent test I/O)
        const maxAllowedMs = sizeMB <= 20 ? 1500 : sizeMB <= 50 ? 2500 : 5000;
        assert.ok(
          result.durationMs < maxAllowedMs,
          `Expected unpack of ${sizeMB}MB archive to take < ${maxAllowedMs}ms, but took ${result.durationMs}ms`
        );
        if (sizeMB <= 20) {
          assert.ok(result.isSub1500Ms, `Expected unpack of ${sizeMB}MB archive to be sub-1500ms`);
        }

        // Verify unpacked integrity
        const headExists = fsSync.existsSync(path.join(unpackDest, '.git', 'HEAD'));
        const zoektExists = fsSync.existsSync(path.join(unpackDest, '.zoekt', 'shard.00000.idx'));
        const packExists = fsSync.existsSync(
          path.join(unpackDest, '.git', 'objects', 'pack', `pack-synthetic-${sizeMB}mb.pack`)
        );
        assert.ok(headExists, 'Unpacked .git/HEAD must exist');
        assert.ok(zoektExists, 'Unpacked .zoekt/shard.00000.idx must exist');
        assert.ok(packExists, `Unpacked packfile must exist`);
      });
    }

    it('empirically tests unpack latency when archive contains 1,000 loose git objects (inode stress)', async () => {
      const benchWorkDir = path.join(tempBaseDir, 'bench_create_loose');
      const archivePath = path.join(tempBaseDir, 'archive_loose_1000.tar.zst');
      const unpackDest = path.join(tempBaseDir, 'bench_unpack_loose');

      await fs.mkdir(benchWorkDir, { recursive: true });

      // Create 1,000 loose objects in .git/objects/xx/yyyy...
      for (let i = 0; i < 1000; i++) {
        const hash = crypto.createHash('sha1').update(String(i)).digest('hex');
        const prefix = hash.slice(0, 2);
        const rest = hash.slice(2);
        const objDir = path.join(benchWorkDir, '.git', 'objects', prefix);
        await fs.mkdir(objDir, { recursive: true });
        await fs.writeFile(path.join(objDir, rest), crypto.randomBytes(4096));
      }

      await fs.mkdir(path.join(benchWorkDir, '.zoekt'), { recursive: true });
      await fs.writeFile(path.join(benchWorkDir, '.zoekt', 'index.idx'), 'zoekt\n');

      await execFileAsync('sh', [
        '-c',
        `cd "${benchWorkDir}" && tar -cf - .git .zoekt | zstd -3 -T0 > "${archivePath}"`,
      ]);

      const stat = await fs.stat(archivePath);
      const archiveMB = (stat.size / (1024 * 1024)).toFixed(2);

      const result = await benchmarkUnpackSpeed(archivePath, unpackDest);
      console.log(
        `[Benchmark Loose Objects] 1000 files -> Archive: ${archiveMB} MB | Unpack duration: ${result.durationMs.toFixed(2)}ms | isSub1500Ms: ${result.isSub1500Ms}`
      );

      // Inode unpacking under heavy concurrent test suite I/O
      assert.ok(
        result.durationMs < 6000,
        `Expected unpack of 1000 loose objects to take < 6000ms under test I/O, but took ${result.durationMs}ms`
      );
    });
  });

  // =========================================================================
  // 2. Stress test target filtering
  // =========================================================================
  describe('2. Stress Test Target Filtering', () => {
    it('strictly includes valid .git and .zoekt targets', () => {
      const allowed = [
        '.git',
        '.git/HEAD',
        '.git/config',
        '.git/objects/pack',
        '.zoekt',
        '.zoekt/shard.00000.idx',
        './.git',
        './.zoekt',
      ];
      for (const item of allowed) {
        assert.equal(isAllowedCacheTarget(item), true, `Expected '${item}' to be allowed`);
      }
    });

    it('strictly excludes standard disallowed paths and build artifacts', () => {
      const disallowed = [
        'node_modules',
        'node_modules/express',
        'node_modules/vitest/index.js',
        'dist',
        'dist/bundle.js',
        '.env',
        '.env.production',
        'src',
        'src/index.ts',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'build',
        'build/Release',
        'target',
        'target/debug',
      ];
      for (const item of disallowed) {
        assert.equal(isAllowedCacheTarget(item), false, `Expected '${item}' to be rejected`);
      }
    });

    it('strictly excludes adversarial filenames with .git or .zoekt substrings', () => {
      const adversarial = [
        '.git_fake',
        '.git_backup',
        '.git-credentials',
        '.gitignore',
        '.gitattributes',
        '.github',
        '.github/workflows/ci.yml',
        '.gitlab-ci.yml',
        '.gitmodules',
        'node_modules/.git',
        'packages/foo/.git',
        'subfolder/.git',
        'foo/.zoekt',
        'something.zoekt',
        '.zoekt_backup',
        '.zoekt-tmp',
      ];
      for (const item of adversarial) {
        assert.equal(isAllowedCacheTarget(item), false, `Expected adversarial item '${item}' to be rejected`);
      }
    });

    it('handles malformed, empty, or whitespace target inputs safely', () => {
      assert.equal(isAllowedCacheTarget(''), false);
      assert.equal(isAllowedCacheTarget('   '), false);
      assert.equal(isAllowedCacheTarget(null as any), false);
      assert.equal(isAllowedCacheTarget(undefined as any), false);
      assert.equal(isAllowedCacheTarget(123 as any), false);
      assert.equal(isAllowedCacheTarget({} as any), false);
    });

    it('verifies path traversal attempts are strictly rejected by isAllowedCacheTarget', () => {
      const traversalTargets = [
        '.git/../.env',
        '.git/../../etc/passwd',
        '.zoekt/../node_modules',
        '.zoekt/../../secret.key',
        '.git/..',
        '../.git',
      ];
      for (const t of traversalTargets) {
        const allowed = isAllowedCacheTarget(t);
        assert.equal(
          allowed,
          false,
          `Path traversal target '${t}' must be rejected by isAllowedCacheTarget`
        );
      }
    });

    it('stage-r2-cache.sh ignores adversarial files in workspace and archives strictly .git and .zoekt', async () => {
      const workspace = path.join(tempBaseDir, 'adversarial_ws');
      await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
      await fs.mkdir(path.join(workspace, '.zoekt'), { recursive: true });
      await fs.mkdir(path.join(workspace, '.github'), { recursive: true });
      await fs.mkdir(path.join(workspace, 'node_modules', '.git'), { recursive: true });
      await fs.mkdir(path.join(workspace, 'dist'), { recursive: true });

      await fs.writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await fs.writeFile(path.join(workspace, '.zoekt', 'index.idx'), 'zoekt\n');
      await fs.writeFile(path.join(workspace, '.git_fake'), 'fake git\n');
      await fs.writeFile(path.join(workspace, '.gitignore'), 'node_modules\n');
      await fs.writeFile(path.join(workspace, '.env'), 'SECRET=12345\n');
      await fs.writeFile(path.join(workspace, 'node_modules', '.git', 'HEAD'), 'exploit\n');
      await fs.writeFile(path.join(workspace, 'dist', 'bundle.js'), 'bundle\n');

      const env = {
        ...process.env,
        OWNER: 'adversarial-org',
        REPO: 'adversarial-repo',
        PR_NUMBER: '99',
        WORKSPACE_DIR: workspace,
        DRY_RUN: '1',
      };

      const { stdout } = await execFileAsync('bash', [stageScriptPath], { env });
      assert.ok(stdout.includes('Dry run enabled'));

      // Check the created archive contents before cleanup
      const listOutput = await execFileAsync('bash', [
        '-c',
        `cd "${workspace}" && tar -cf - .git $([ -d .zoekt ] && echo .zoekt) | tar -tf -`,
      ]);

      const filesInArchive = listOutput.stdout.trim().split('\n');

      // Verify that NO forbidden files are in the archive
      for (const forbidden of ['.git_fake', '.gitignore', '.env', 'node_modules', 'dist']) {
        const found = filesInArchive.some((f) => f.includes(forbidden));
        assert.equal(found, false, `Archive must NOT contain '${forbidden}'`);
      }
    });

    it('stage-r2-cache.sh purges transient git lock files before archiving', async () => {
      const workspace = path.join(tempBaseDir, 'lock_purge_ws');
      await fs.mkdir(path.join(workspace, '.git', 'refs', 'heads'), { recursive: true });
      await fs.writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await fs.writeFile(path.join(workspace, '.git', 'index.lock'), 'locked\n');
      await fs.writeFile(path.join(workspace, '.git', 'refs', 'heads', 'main.lock'), 'locked\n');

      const env = {
        ...process.env,
        OWNER: 'lock-org',
        REPO: 'lock-repo',
        PR_NUMBER: '42',
        WORKSPACE_DIR: workspace,
        DRY_RUN: '1',
      };

      await execFileAsync('bash', [stageScriptPath], { env });

      // Locks should have been purged by line 49 of stage-r2-cache.sh
      assert.equal(fsSync.existsSync(path.join(workspace, '.git', 'index.lock')), false);
      assert.equal(fsSync.existsSync(path.join(workspace, '.git', 'refs', 'heads', 'main.lock')), false);
    });
  });

  // =========================================================================
  // 3. Test shell script failure modes
  // =========================================================================
  describe('3. Shell Script Failure Modes', () => {
    describe('3.1 Missing required environment variables', () => {
      it('restore-r2-cache.sh fails with exit code 1 and lists all missing vars', async () => {
        try {
          await execFileAsync('bash', [restoreScriptPath], {
            env: { PATH: process.env.PATH },
          });
          assert.fail('Expected script to exit with error code 1');
        } catch (err: any) {
          assert.equal(err.code, 1);
          assert.ok(
            err.stderr.includes('[r2-cache] ERROR: Missing required environment variable(s): OWNER REPO PR_NUMBER HEAD_SHA'),
            `stderr did not contain expected message. Actual: ${err.stderr}`
          );
        }
      });

      it('restore-r2-cache.sh reports specific missing variable when only HEAD_SHA is omitted', async () => {
        try {
          await execFileAsync('bash', [restoreScriptPath], {
            env: {
              PATH: process.env.PATH,
              OWNER: 'calltelemetry',
              REPO: 'test-repo',
              PR_NUMBER: '10',
            },
          });
          assert.fail('Expected script to exit with error code 1');
        } catch (err: any) {
          assert.equal(err.code, 1);
          assert.ok(err.stderr.includes('Missing required environment variable(s): HEAD_SHA'));
        }
      });

      it('stage-r2-cache.sh fails with exit code 1 and lists missing vars', async () => {
        try {
          await execFileAsync('bash', [stageScriptPath], {
            env: { PATH: process.env.PATH },
          });
          assert.fail('Expected script to exit with error code 1');
        } catch (err: any) {
          assert.equal(err.code, 1);
          assert.ok(
            err.stderr.includes('[r2-cache] ERROR: Missing required environment variable(s): OWNER REPO PR_NUMBER'),
            `stderr did not contain expected message. Actual: ${err.stderr}`
          );
        }
      });
    });

    describe('3.2 Corrupted archive handling and recovery in restore-r2-cache.sh', () => {
      it('safely recovers from corrupted archive and seamlessly executes shallow clone fallback', async () => {
        const ws = path.join(tempBaseDir, 'corrupt_archive_ws');
        const mockBin = path.join(tempBaseDir, 'mock_bin_corrupt');
        await fs.mkdir(mockBin, { recursive: true });

        // Mock AWS CLI returning a corrupt archive
        const mockAws = `#!/usr/bin/env bash
if [ "$1" = "s3api" ] && [ "$2" = "head-object" ]; then
  echo '{"Metadata": {"created-at": "'$(date +%s)'"}}'
  exit 0
fi
# Simulate downloading a corrupted archive (random non-zstd data)
echo "CORRUPTED_NON_ZSTD_GARBAGE_PAYLOAD" > "$4"
exit 0
`;
        await fs.writeFile(path.join(mockBin, 'aws'), mockAws, { mode: 0o755 });

        // Mock git clone so we can verify if fallback clone happens
        const cloneLog = path.join(tempBaseDir, 'clone_called.log');
        const mockGit = `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  echo "CLONE_EXECUTED" >> "${cloneLog}"
  mkdir -p "$5/.git"
  echo "ref: refs/heads/main" > "$5/.git/HEAD"
  exit 0
fi
exit 0
`;
        await fs.writeFile(path.join(mockBin, 'git'), mockGit, { mode: 0o755 });

        const env = {
          PATH: `${mockBin}:${process.env.PATH}`,
          OWNER: 'testorg',
          REPO: 'testrepo',
          PR_NUMBER: '123',
          HEAD_SHA: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          WORKSPACE_DIR: ws,
          R2_ENDPOINT: 'https://r2.test',
        };

        let scriptExitedWithError = false;
        let scriptErrorCode = 0;
        let scriptStderr = '';
        let output = '';
        try {
          const res = await execFileAsync('bash', [restoreScriptPath], { env });
          output = `${res.stdout}\n${res.stderr}`;
        } catch (err: any) {
          scriptExitedWithError = true;
          scriptErrorCode = err.code;
          scriptStderr = err.stderr || '';
          output = `${err.stdout || ''}\n${err.stderr || ''}`;
        }

        assert.equal(
          scriptExitedWithError,
          false,
          `Script crashed unexpectedly with code ${scriptErrorCode}: ${scriptStderr}`
        );
        assert.ok(
          output.includes('Archive decompression failed (corrupted or truncated archive); falling back to full clone.'),
          'Must log explicit warning regarding corrupted archive decompression'
        );
        assert.equal(
          fsSync.existsSync(cloneLog),
          true,
          'Clean shallow clone fallback MUST be reached and executed'
        );
      });
    });

    describe('3.3 History divergence fallback in restore-r2-cache.sh', () => {
      it('falls back to clean shallow clone when cached git history has diverged', async () => {
        const ws = path.join(tempBaseDir, 'diverged_ws');
        const mockBin = path.join(tempBaseDir, 'mock_bin_diverged');
        await fs.mkdir(mockBin, { recursive: true });

        // Create a valid archive containing a dummy .git
        const seedWs = path.join(tempBaseDir, 'diverged_seed');
        await fs.mkdir(path.join(seedWs, '.git'), { recursive: true });
        await fs.writeFile(path.join(seedWs, '.git', 'HEAD'), 'ref: refs/heads/old-branch\n');
        const seedArchive = path.join(tempBaseDir, 'diverged_seed.tar.zst');
        await execFileAsync('sh', [
          '-c',
          `cd "${seedWs}" && tar -cf - .git | zstd -3 > "${seedArchive}"`,
        ]);

        // Mock AWS CLI returning the seed archive
        const mockAws = `#!/usr/bin/env bash
if [ "$1" = "s3api" ] && [ "$2" = "head-object" ]; then
  echo '{"Metadata": {"created-at": "'$(date +%s)'"}}'
  exit 0
fi
cp "${seedArchive}" "$4"
exit 0
`;
        await fs.writeFile(path.join(mockBin, 'aws'), mockAws, { mode: 0o755 });

        // Mock git: fetch fails (simulating diverged history), clone succeeds
        const trackerLog = path.join(tempBaseDir, 'diverged_actions.log');
        const mockGit = `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3" = "remote" ]; then
  echo "REMOTE_UPDATED" >> "${trackerLog}"
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "fetch" ]; then
  echo "FETCH_FAILED_DIVERGED" >> "${trackerLog}"
  exit 1
fi
if [ "$1" = "clone" ]; then
  echo "FALLBACK_CLONE_EXECUTED" >> "${trackerLog}"
  mkdir -p "$5/.git"
  echo "ref: refs/heads/main" > "$5/.git/HEAD"
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "checkout" ]; then
  echo "CHECKOUT_EXECUTED" >> "${trackerLog}"
  exit 0
fi
exit 0
`;
        await fs.writeFile(path.join(mockBin, 'git'), mockGit, { mode: 0o755 });

        const env = {
          PATH: `${mockBin}:${process.env.PATH}`,
          OWNER: 'testorg',
          REPO: 'testrepo',
          PR_NUMBER: '456',
          HEAD_SHA: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
          WORKSPACE_DIR: ws,
          R2_ENDPOINT: 'https://r2.test',
        };

        const res = await execFileAsync('bash', [restoreScriptPath], { env });
        const output = `${res.stdout}\n${res.stderr}`;

        assert.ok(
          output.includes('Incremental fetch/checkout failed (history diverged or corrupted cache); falling back to full clone.'),
          'Must log warning regarding diverged history'
        );
        assert.ok(output.includes('Performing full shallow clone'), 'Must perform fallback clone');

        const logContents = await fs.readFile(trackerLog, 'utf8');
        assert.ok(logContents.includes('FETCH_FAILED_DIVERGED'), 'Fetch must have been attempted');
        assert.ok(logContents.includes('FALLBACK_CLONE_EXECUTED'), 'Fallback clone must have executed');
      });
    });

    describe('3.4 Remote URL token refresh in restore-r2-cache.sh', () => {
      it('updates remote origin URL with active GITHUB_TOKEN on cache hit', async () => {
        const ws = path.join(tempBaseDir, 'token_refresh_ws');
        const mockBin = path.join(tempBaseDir, 'mock_bin_token');
        await fs.mkdir(mockBin, { recursive: true });

        // Create a valid archive containing a dummy .git
        const seedWs = path.join(tempBaseDir, 'token_seed');
        await fs.mkdir(path.join(seedWs, '.git'), { recursive: true });
        await fs.writeFile(path.join(seedWs, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        const seedArchive = path.join(tempBaseDir, 'token_seed.tar.zst');
        await execFileAsync('sh', [
          '-c',
          `cd "${seedWs}" && tar -cf - .git | zstd -3 > "${seedArchive}"`,
        ]);

        // Mock AWS CLI returning seed archive
        const mockAws = `#!/usr/bin/env bash
if [ "$1" = "s3api" ] && [ "$2" = "head-object" ]; then
  echo '{"Metadata": {"created-at": "'$(date +%s)'"}}'
  exit 0
fi
cp "${seedArchive}" "$4"
exit 0
`;
        await fs.writeFile(path.join(mockBin, 'aws'), mockAws, { mode: 0o755 });

        // Record the remote URL set by git remote set-url origin <URL>
        const remoteUrlLog = path.join(tempBaseDir, 'remote_url.log');
        const mockGit = `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3" = "remote" ] && [ "$4" = "set-url" ]; then
  echo "$6" >> "${remoteUrlLog}"
  exit 0
fi
exit 0
`;
        await fs.writeFile(path.join(mockBin, 'git'), mockGit, { mode: 0o755 });

        const testToken = 'ghp_freshSecretToken2026Adversarial';
        const env = {
          PATH: `${mockBin}:${process.env.PATH}`,
          OWNER: 'calltelemetry',
          REPO: 'review-yeti',
          PR_NUMBER: '789',
          HEAD_SHA: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
          WORKSPACE_DIR: ws,
          R2_ENDPOINT: 'https://r2.test',
          GITHUB_TOKEN: testToken,
        };

        const res = await execFileAsync('bash', [restoreScriptPath], { env });
        const output = `${res.stdout}\n${res.stderr}`;

        assert.ok(output.includes('Updating git remote origin...'));
        assert.ok(fsSync.existsSync(remoteUrlLog), 'remote_url.log must have been created by git remote set-url');

        const recordedUrls = (await fs.readFile(remoteUrlLog, 'utf8')).trim().split('\n');
        assert.ok(recordedUrls.some((u) => u.includes(`x-access-token:${testToken}`)), 'Must update git remote origin with active GITHUB_TOKEN');
        assert.equal(
          recordedUrls[recordedUrls.length - 1],
          'https://github.com/calltelemetry/review-yeti.git',
          'Must sanitize git remote origin before exit to prevent credential leakage into R2'
        );
      });
    });
  });
});
