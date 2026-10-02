import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildCanonicalCacheKey,
  buildR2CacheKey,
  parseR2CacheKey,
  validateR2CacheConfig,
  buildR2CacheEnv,
  isAllowedCacheTarget,
  filterCacheTargets,
  filterAllowedCacheTargets,
  benchmarkUnpackSpeed,
  restoreWorkspaceCache,
  stageWorkspaceCache,
  resolveScriptPath,
  redactTokens,
  isCacheExpired,
  purgeExpiredR2WorkspaceCaches,
} from '../src/runners/r2WorkspaceCache.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('R2 Workspace Caching & Zoekt Hydration (M3 / R3)', () => {
  let testTempDir: string;
  let restoreScriptPath: string;
  let stageScriptPath: string;

  before(async () => {
    testTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-test-'));

    restoreScriptPath = resolveScriptPath('restore-r2-cache.sh');
    stageScriptPath = resolveScriptPath('stage-r2-cache.sh');

    await fs.chmod(restoreScriptPath, 0o755);
    await fs.chmod(stageScriptPath, 0o755);
  });

  after(async () => {
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('1. Cache Key Formatting & Parameter Validation', () => {
    it('formats canonical R2 cache key correctly with buildCanonicalCacheKey and buildR2CacheKey', () => {
      const key1 = buildCanonicalCacheKey('review-yeti-ai', 'review-yeti-bot', 42);
      assert.equal(key1, 'review-yeti-ai/review-yeti-bot/pr-42.tar.zst');

      const key2 = buildR2CacheKey('review-yeti-ai', 'review-yeti-bot', 42);
      assert.equal(key2, 'review-yeti-ai/review-yeti-bot/pr-42.tar.zst');
    });

    it('rejects invalid or missing owner, repo, or prNumber in buildCanonicalCacheKey', () => {
      assert.throws(() => buildCanonicalCacheKey('', 'repo', 1), /requires a non-empty owner/);
      assert.throws(() => buildCanonicalCacheKey('owner', '', 1), /requires a non-empty repo/);
      assert.throws(() => buildCanonicalCacheKey('owner', 'repo', 0), /requires a positive integer/);
      assert.throws(() => buildCanonicalCacheKey('owner', 'repo', -5), /requires a positive integer/);
      assert.throws(() => buildCanonicalCacheKey('owner', 'repo', 1.5), /requires a positive integer/);
    });

    it('parses canonical R2 cache keys back into components', () => {
      const parsed = parseR2CacheKey('calltelemetry/review-yeti/pr-99.tar.zst');
      assert.ok(parsed);
      assert.equal(parsed.owner, 'calltelemetry');
      assert.equal(parsed.repo, 'review-yeti');
      assert.equal(parsed.prNumber, 99);

      assert.equal(parseR2CacheKey('invalid-key-format'), null);
      assert.equal(parseR2CacheKey('org/repo/pr-abc.tar.zst'), null);
    });

    it('validates configuration and catches missing required variables', () => {
      const invalid = validateR2CacheConfig({ owner: 'foo' });
      assert.equal(invalid.valid, false);
      assert.ok(invalid.missing.includes('REPO'));
      assert.ok(invalid.missing.includes('PR_NUMBER'));
      assert.ok(invalid.missing.includes('HEAD_SHA'));

      const valid = validateR2CacheConfig({
        owner: 'foo',
        repo: 'bar',
        prNumber: 12,
        headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      });
      assert.equal(valid.valid, true);
      assert.equal(valid.missing.length, 0);
    });

    it('builds complete environment dictionary for container execution', () => {
      const env = buildR2CacheEnv({
        owner: 'calltelemetry',
        repo: 'reviewyeti',
        prNumber: 101,
        headSha: 'abc1234',
        r2Endpoint: 'https://cf.r2.example.com',
        r2AccessKeyId: 'r2_key_id',
        r2SecretAccessKey: 'r2_secret',
      });

      assert.equal(env.OWNER, 'calltelemetry');
      assert.equal(env.REPO, 'reviewyeti');
      assert.equal(env.PR_NUMBER, '101');
      assert.equal(env.HEAD_SHA, 'abc1234');
      assert.equal(env.R2_ENDPOINT, 'https://cf.r2.example.com');
      assert.equal(env.AWS_ACCESS_KEY_ID, 'r2_key_id');
      assert.equal(env.AWS_SECRET_ACCESS_KEY, 'r2_secret');
      assert.equal(env.AWS_DEFAULT_REGION, 'auto');
    });
  });

  describe('2. Target Selection & Build Artifact Exclusion', () => {
    it('strictly accepts .git and .zoekt and rejects build artifacts', () => {
      assert.equal(isAllowedCacheTarget('.git'), true);
      assert.equal(isAllowedCacheTarget('.git/config'), true);
      assert.equal(isAllowedCacheTarget('.zoekt'), true);
      assert.equal(isAllowedCacheTarget('.zoekt/shard.idx'), true);

      assert.equal(isAllowedCacheTarget('node_modules'), false);
      assert.equal(isAllowedCacheTarget('node_modules/express'), false);
      assert.equal(isAllowedCacheTarget('dist'), false);
      assert.equal(isAllowedCacheTarget('dist/bundle.js'), false);
      assert.equal(isAllowedCacheTarget('src'), false);
      assert.equal(isAllowedCacheTarget('src/index.ts'), false);
      assert.equal(isAllowedCacheTarget('.env'), false);
    });

    it('filterCacheTargets and filterAllowedCacheTargets filter array strictly', () => {
      const candidates = ['.git', '.zoekt', 'node_modules', 'dist', 'src', 'package.json'];
      const filtered1 = filterCacheTargets(candidates);
      assert.deepEqual(filtered1, ['.git', '.zoekt']);

      const filtered2 = filterAllowedCacheTargets(candidates);
      assert.deepEqual(filtered2, ['.git', '.zoekt']);
    });

    it('strictly rejects path traversal attacks attempting to escape .git or .zoekt', () => {
      const traversalAttacks = [
        '.git/../.env',
        '.git/../../etc/passwd',
        '.zoekt/../node_modules',
        '.zoekt/../../secret.key',
        '.git/..',
        '.zoekt/..',
        '..',
        '../',
        '../.git',
        '../../.git',
        './../.git',
        '.git\\..\\.env',
        '.zoekt\\..\\..\\secret.key',
        '/etc/passwd',
        '/.git/../etc/passwd',
        '.git\0/evil',
      ];
      for (const attack of traversalAttacks) {
        assert.equal(
          isAllowedCacheTarget(attack),
          false,
          `Expected traversal path '${attack}' to be rejected`
        );
      }
    });

    it('strictly accepts legitimate nested subpaths inside .git and .zoekt', () => {
      const validSubpaths = [
        '.git/objects/pack',
        '.git/objects/pack/pack-12345.pack',
        '.git/refs/heads/main',
        '.git/HEAD',
        '.git/config',
        '.zoekt/index',
        '.zoekt/shard.00000.idx',
        './.git/objects/pack',
        './.zoekt/index',
        '.git\\objects\\pack',
        '.zoekt\\index',
      ];
      for (const p of validSubpaths) {
        assert.equal(
          isAllowedCacheTarget(p),
          true,
          `Expected valid subpath '${p}' to be accepted`
        );
      }
    });

    it('filterCacheTargets filters adversarial arrays containing traversal attempts', () => {
      const mixed = [
        '.git',
        '.git/../.env',
        '.zoekt/../../secret.key',
        '.git/objects/pack',
        '.zoekt/index',
        'node_modules',
        'dist',
      ];
      const filtered = filterCacheTargets(mixed);
      assert.deepEqual(filtered, ['.git', '.git/objects/pack', '.zoekt/index']);
    });
  });

  describe('3. Shell Script Fail-Fast Validation', () => {
    it('restore-r2-cache.sh exits with code 1 if required variables are missing', async () => {
      try {
        await execFileAsync('bash', [restoreScriptPath], {
          env: { PATH: process.env.PATH },
        });
        assert.fail('Expected script to exit with error code 1');
      } catch (err: any) {
        assert.equal(err.code, 1);
        assert.ok(err.stderr.includes('Missing required environment variable(s)'));
      }
    });

    it('stage-r2-cache.sh exits with code 1 if required variables are missing', async () => {
      try {
        await execFileAsync('bash', [stageScriptPath], {
          env: { PATH: process.env.PATH },
        });
        assert.fail('Expected script to exit with error code 1');
      } catch (err: any) {
        assert.equal(err.code, 1);
        assert.ok(err.stderr.includes('Missing required environment variable(s)'));
      }
    });
  });

  describe('4. Staging Script Execution & Content Verification', () => {
    it('packages strictly .git and .zoekt into archive without leaking build artifacts', async () => {
      const workspace = path.join(testTempDir, 'mock_ws');
      await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
      await fs.mkdir(path.join(workspace, '.zoekt'), { recursive: true });
      await fs.mkdir(path.join(workspace, 'node_modules', 'dummy'), { recursive: true });
      await fs.mkdir(path.join(workspace, 'dist'), { recursive: true });
      await fs.mkdir(path.join(workspace, 'src'), { recursive: true });

      await fs.writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await fs.writeFile(path.join(workspace, '.zoekt', 'shard.idx'), 'zoekt shard data\n');
      await fs.writeFile(path.join(workspace, 'node_modules', 'dummy', 'index.js'), 'module.exports = {};\n');
      await fs.writeFile(path.join(workspace, 'dist', 'bundle.js'), 'console.log("dist");\n');
      await fs.writeFile(path.join(workspace, 'src', 'index.ts'), 'export const x = 1;\n');

      const result = await stageWorkspaceCache(
        {
          owner: 'testorg',
          repo: 'testrepo',
          prNumber: 55,
          headSha: '1122334455667788990011223344556677889900',
          workspaceDir: workspace,
          dryRun: true,
        },
        { scriptPath: stageScriptPath }
      );

      assert.equal(result.success, true);
      assert.ok(result.archiveSizeBytes && result.archiveSizeBytes > 0);
      assert.ok(result.output.includes('Dry run enabled; skipping upload'));
    });
  });

  describe('5. Sub-1.5s Unpack Benchmark Constraint', () => {
    it('unpacks 20MB compressed archive in under 1500ms', async () => {
      const benchDir = path.join(testTempDir, 'bench');
      const wsDir = path.join(benchDir, 'src_ws');
      const outDir = path.join(benchDir, 'dest_ws');
      await fs.mkdir(path.join(wsDir, '.git', 'objects'), { recursive: true });
      await fs.mkdir(path.join(wsDir, '.zoekt'), { recursive: true });

      // Create synthetic 20MB of compressible data
      const dummyBuffer = Buffer.alloc(1024 * 1024 * 20, 0x41); // 20MB of 'A'
      await fs.writeFile(path.join(wsDir, '.git', 'objects', 'pack-01.pack'), dummyBuffer);
      await fs.writeFile(path.join(wsDir, '.zoekt', 'index.zoekt'), 'zoekt index data');

      const archivePath = path.join(benchDir, 'test-cache.tar.zst');
      // Create test archive using portable pipe
      await execFileAsync('sh', [
        '-c',
        `cd "${wsDir}" && tar -cf - .git .zoekt | zstd -3 > "${archivePath}"`,
      ]);

      const benchResult = await benchmarkUnpackSpeed(archivePath, outDir);

      assert.equal(benchResult.isSub1500Ms, true, `Unpack took ${benchResult.durationMs}ms, exceeding 1500ms limit`);
      assert.ok(benchResult.durationMs < 1500);

      // Verify unpacked content
      const unpackedHead = await fs.readFile(path.join(outDir, '.zoekt', 'index.zoekt'), 'utf8');
      assert.equal(unpackedHead, 'zoekt index data');
    });
  });

  describe('6. Cache Hit vs Cache Miss Execution Flow', () => {
    let mockBinDir: string;

    before(async () => {
      mockBinDir = path.join(testTempDir, 'mock_bin');
      await fs.mkdir(mockBinDir, { recursive: true });

      // Create a mock git command to avoid real network clones during testing
      const mockGit = `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  mkdir -p "$5/.git"
  echo "ref: refs/heads/main" > "$5/.git/HEAD"
  exit 0
elif [ "$1" = "-C" ] && [ "$3" = "fetch" ]; then
  exit 0
elif [ "$1" = "-C" ] && [ "$3" = "checkout" ]; then
  exit 0
elif [ "$1" = "-C" ] && [ "$3" = "remote" ]; then
  exit 0
fi
exit 0
`;
      await fs.writeFile(path.join(mockBinDir, 'git'), mockGit, { mode: 0o755 });
    });

    it('executes cache miss path when R2 download fails or archive not found', async () => {
      const workspace = path.join(testTempDir, 'miss_ws');
      const mockAws = `#!/usr/bin/env bash
# simulate s3 404
exit 1
`;
      await fs.writeFile(path.join(mockBinDir, 'aws'), mockAws, { mode: 0o755 });

      const result = await restoreWorkspaceCache(
        {
          owner: 'testorg',
          repo: 'testrepo',
          prNumber: 77,
          headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          workspaceDir: workspace,
          r2Endpoint: 'https://r2.example.com',
        },
        {
          scriptPath: restoreScriptPath,
          extraEnv: { PATH: `${mockBinDir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.success, true);
      assert.equal(result.cacheHit, false);
      assert.ok(result.output.includes('Cache miss for PR #77'));
      assert.ok(result.output.includes('Performing full shallow clone'));
    });

    it('executes cache hit path and delta fetch when archive is present', async () => {
      const workspace = path.join(testTempDir, 'hit_ws');
      const seedDir = path.join(testTempDir, 'seed_archive');
      await fs.mkdir(path.join(seedDir, '.git'), { recursive: true });
      await fs.mkdir(path.join(seedDir, '.zoekt'), { recursive: true });
      await fs.writeFile(path.join(seedDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await fs.writeFile(path.join(seedDir, '.zoekt', 'shard.idx'), 'zoekt shard data\n');

      const seedArchive = path.join(testTempDir, 'seed.tar.zst');
      await execFileAsync('sh', [
        '-c',
        `cd "${seedDir}" && tar -cf - .git .zoekt | zstd -3 > "${seedArchive}"`,
      ]);

      const mockAws = `#!/usr/bin/env bash
if [ "$1" = "s3api" ] && [ "$2" = "head-object" ]; then
  echo '{"Metadata": {"created-at": "'$(date +%s)'"}}'
  exit 0
elif [ "$1" = "s3" ] && [ "$2" = "cp" ]; then
  cp "${seedArchive}" "$4"
  exit 0
fi
exit 0
`;
      await fs.writeFile(path.join(mockBinDir, 'aws'), mockAws, { mode: 0o755 });

      const result = await restoreWorkspaceCache(
        {
          owner: 'testorg',
          repo: 'testrepo',
          prNumber: 77,
          headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          workspaceDir: workspace,
          r2Endpoint: 'https://r2.example.com',
        },
        {
          scriptPath: restoreScriptPath,
          extraEnv: { PATH: `${mockBinDir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.success, true);
      assert.equal(result.cacheHit, true);
      assert.ok(result.output.includes('Cache hit! Unpacking archive with zstd'));
      assert.ok(result.output.includes('Fetching delta for head a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'));
    });
  });

  describe('7. Zoekt Symbol Indexing Resilience', () => {
    it('executes zoekt-index if binary exists and ignores errors safely', async () => {
      const mockBinDir = path.join(testTempDir, 'zoekt_mock_bin');
      await fs.mkdir(mockBinDir, { recursive: true });

      const mockGit = `#!/usr/bin/env bash
mkdir -p "$5/.git"
exit 0
`;
      await fs.writeFile(path.join(mockBinDir, 'git'), mockGit, { mode: 0o755 });

      const mockZoekt = `#!/usr/bin/env bash
echo "mock-zoekt-index called for $2"
exit 0
`;
      await fs.writeFile(path.join(mockBinDir, 'zoekt-index'), mockZoekt, { mode: 0o755 });

      const workspace = path.join(testTempDir, 'zoekt_ws');
      const result = await restoreWorkspaceCache(
        {
          owner: 'testorg',
          repo: 'testrepo',
          prNumber: 88,
          headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          workspaceDir: workspace,
        },
        {
          scriptPath: restoreScriptPath,
          extraEnv: { PATH: `${mockBinDir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.success, true);
      assert.ok(result.output.includes('Updating Zoekt symbol index'));
      assert.ok(result.output.includes('mock-zoekt-index called'));
    });
  });

  describe('8. Credential & Token Redaction in Runner Streams', () => {
    it('redacts tokens embedded in git URLs, auth headers, and raw token formats', () => {
      const sensitiveToken = 'ghp_secretTokenVal1234567890abcdef';
      const sampleStderr = `fatal: unable to access 'https://x-access-token:${sensitiveToken}@github.com/calltelemetry/cisco-cdr.git': The requested URL returned error: 403`;
      const sanitized = redactTokens(sampleStderr);

      assert.ok(!sanitized.includes(sensitiveToken), 'Must not contain raw token');
      assert.ok(sanitized.includes('https://x-access-token:[REDACTED]@github.com') || sanitized.includes('https://[REDACTED]@github.com'));

      const bearerSample = 'Authorization: Bearer secret_bearer_token_12345';
      assert.equal(redactTokens(bearerSample), 'Authorization: Bearer [REDACTED]');

      const customToken = 'my_super_secret_custom_token_123';
      const customSample = `Failed with token: ${customToken}`;
      const customSanitized = redactTokens(customSample, [customToken]);
      assert.ok(!customSanitized.includes(customToken));
      assert.ok(customSanitized.includes('[REDACTED_SECRET]'));
    });

    it('ensures restoreWorkspaceCache scrubs tokens from error and output when git clone fails', async () => {
      const mockBinDir = path.join(testTempDir, 'mock_fail_bin');
      await fs.mkdir(mockBinDir, { recursive: true });

      const testToken = 'ghp_leakTestSecretToken1234567890';
      // Mock git clone that fails and prints the remote URL to stderr
      const mockGit = `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  echo "fatal: unable to access '$4': 403 Forbidden" >&2
  exit 128
fi
exit 0
`;
      await fs.writeFile(path.join(mockBinDir, 'git'), mockGit, { mode: 0o755 });

      const workspace = path.join(testTempDir, 'fail_ws');
      const result = await restoreWorkspaceCache(
        {
          owner: 'testorg',
          repo: 'testrepo',
          prNumber: 99,
          headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          workspaceDir: workspace,
          githubToken: testToken,
        },
        {
          scriptPath: restoreScriptPath,
          extraEnv: { PATH: `${mockBinDir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.success, false);
      assert.ok(result.error, 'result.error must be defined');
      assert.ok(!result.error.includes(testToken), 'result.error must not leak raw token');
      assert.ok(!result.output.includes(testToken), 'result.output must not leak raw token');
      assert.ok(result.error.includes('[REDACTED]') || result.error.includes('[REDACTED_GH_TOKEN]'));
    });
  });

  describe('R2 1-Hour Aggressive Cache Expiration & Purge', () => {
    it('isCacheExpired correctly identifies fresh vs expired archives', () => {
      const now = Date.now();
      const freshDate = new Date(now - 30 * 60 * 1000); // 30 minutes ago
      const expiredDate = new Date(now - 65 * 60 * 1000); // 65 minutes ago (> 1 hour)

      assert.equal(isCacheExpired(freshDate, 3600, now), false);
      assert.equal(isCacheExpired(expiredDate, 3600, now), true);

      // Numeric epoch timestamps
      assert.equal(isCacheExpired(Math.floor((now - 1800000) / 1000), 3600, now), false);
      assert.equal(isCacheExpired(Math.floor((now - 4000000) / 1000), 3600, now), true);

      // ISO strings
      assert.equal(isCacheExpired(freshDate.toISOString(), 3600, now), false);
      assert.equal(isCacheExpired(expiredDate.toISOString(), 3600, now), true);

      // Falsy and invalid inputs safely return false (fail-safe: do not sweep corrupt or missing timestamps)
      assert.equal(isCacheExpired(undefined, 3600, now), false);
      assert.equal(isCacheExpired(null, 3600, now), false);
      assert.equal(isCacheExpired('not-a-date', 3600, now), false);
      assert.equal(isCacheExpired(0, 3600, now), false);
      assert.equal(isCacheExpired(-100, 3600, now), false);
    });

    it('purgeExpiredR2WorkspaceCaches iterates bucket and deletes objects older than 1 hour', async () => {
      const now = Date.now();
      const mockObjects = [
        { key: 'org/repo/pr-101.tar.zst', uploaded: new Date(now - 15 * 60 * 1000) }, // 15m old - keep
        { key: 'org/repo/pr-102.tar.zst', uploaded: new Date(now - 90 * 60 * 1000) }, // 90m old - delete
        { key: 'org/repo/pr-103.tar.zst', uploaded: new Date(now - 120 * 60 * 1000) }, // 120m old - delete
        { key: 'org/repo/pr-104.tar.zst', uploaded: new Date(now - 45 * 60 * 1000) }, // 45m old - keep
      ];

      const deleted: string[] = [];
      const mockBucket = {
        async list() {
          return {
            objects: mockObjects,
            truncated: false,
          };
        },
        async delete(keys: string | string[]) {
          const arr = Array.isArray(keys) ? keys : [keys];
          deleted.push(...arr);
        },
      };

      const result = await purgeExpiredR2WorkspaceCaches(mockBucket, 3600, now);
      assert.equal(result.scannedCount, 4);
      assert.equal(result.deletedCount, 2);
      assert.deepEqual(result.deletedKeys, ['org/repo/pr-102.tar.zst', 'org/repo/pr-103.tar.zst']);
      assert.deepEqual(deleted, ['org/repo/pr-102.tar.zst', 'org/repo/pr-103.tar.zst']);
    });

    it('purgeExpiredR2WorkspaceCaches handles multi-page cursor pagination cleanly', async () => {
      const now = Date.now();
      const page1 = [
        { key: 'org/repo/pr-201.tar.zst', uploaded: new Date(now - 10 * 60 * 1000) },
        { key: 'org/repo/pr-202.tar.zst', uploaded: new Date(now - 70 * 60 * 1000) },
      ];
      const page2 = [
        { key: 'org/repo/pr-203.tar.zst', uploaded: new Date(now - 80 * 60 * 1000) },
      ];

      const deleted: string[] = [];
      let callCount = 0;
      const mockBucket = {
        async list(opts: any) {
          callCount++;
          if (!opts?.cursor) {
            return { objects: page1, truncated: true, cursor: 'cursor_page_2' };
          }
          return { objects: page2, truncated: false };
        },
        async delete(keys: string | string[]) {
          const arr = Array.isArray(keys) ? keys : [keys];
          deleted.push(...arr);
        },
      };

      const result = await purgeExpiredR2WorkspaceCaches(mockBucket, 3600, now);
      assert.equal(callCount, 2);
      assert.equal(result.scannedCount, 3);
      assert.equal(result.deletedCount, 2);
      assert.deepEqual(result.deletedKeys, ['org/repo/pr-202.tar.zst', 'org/repo/pr-203.tar.zst']);
      assert.deepEqual(deleted, ['org/repo/pr-202.tar.zst', 'org/repo/pr-203.tar.zst']);
    });

    it('purgeExpiredR2WorkspaceCaches ignores non-canonical keys even if timestamp is expired', async () => {
      const now = Date.now();
      const expiredDate = new Date(now - 120 * 60 * 1000);
      const mixedObjects = [
        { key: 'org/repo/pr-301.tar.zst', uploaded: expiredDate }, // valid cache key, expired -> should delete
        { key: 'org/repo/build-artifact.tar.gz', uploaded: expiredDate }, // invalid format -> ignore
        { key: 'random-root-file.tar.zst', uploaded: expiredDate }, // invalid format -> ignore
        { key: 'org/repo/pr-invalid.tar.zst', uploaded: expiredDate }, // invalid PR number -> ignore
      ];

      const deleted: string[] = [];
      const mockBucket = {
        async list() {
          return { objects: mixedObjects, truncated: false };
        },
        async delete(keys: string | string[]) {
          const arr = Array.isArray(keys) ? keys : [keys];
          deleted.push(...arr);
        },
      };

      const result = await purgeExpiredR2WorkspaceCaches(mockBucket, 3600, now);
      assert.equal(result.scannedCount, 4);
      assert.equal(result.deletedCount, 1);
      assert.deepEqual(result.deletedKeys, ['org/repo/pr-301.tar.zst']);
      assert.deepEqual(deleted, ['org/repo/pr-301.tar.zst']);
    });

    it('purgeExpiredR2WorkspaceCaches handles bucket.delete error gracefully and continues', async () => {
      const now = Date.now();
      const mockObjects = [
        { key: 'org/repo/pr-401.tar.zst', uploaded: new Date(now - 90 * 60 * 1000) },
      ];

      const mockBucket = {
        async list() {
          return { objects: mockObjects, truncated: false };
        },
        async delete() {
          throw new Error('R2 API temporary network timeout');
        },
      };

      // Must complete without unhandled rejection
      const result = await purgeExpiredR2WorkspaceCaches(mockBucket, 3600, now);
      assert.equal(result.scannedCount, 1);
      assert.equal(result.deletedCount, 0);
      assert.deepEqual(result.deletedKeys, []);
    });

    it('purgeExpiredR2WorkspaceCaches throws error when bucket.delete is not a function', async () => {
      const invalidBucket = {
        async list() {
          return {
            objects: [{ key: 'org/repo/pr-1.tar.zst', uploaded: new Date(Date.now() - 7200000) }],
            truncated: false,
          };
        },
      };

      await assert.rejects(
        async () => {
          await purgeExpiredR2WorkspaceCaches(invalidBucket as any, 3600);
        },
        /bucket\.delete is not a function/
      );
    });
  });
});

