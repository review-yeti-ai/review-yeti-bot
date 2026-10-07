import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createWs5PublicTestFixture } from './ws5PublicTestFixtures';

let runner: any = null;
let ws5Fixture: ReturnType<typeof createWs5PublicTestFixture>;
beforeAll(async () => {
  ws5Fixture = createWs5PublicTestFixture(process.cwd());
  vi.doMock('../../scripts/ws5-acceptance.mjs', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return { ...actual, loadPinnedAcceptancePlan: () => ws5Fixture.bundle };
  });
  runner = await import('../../scripts/ws5-matrix-runner.mjs').catch(() => null);
});

afterAll(() => {
  vi.doUnmock('../../scripts/ws5-acceptance.mjs');
  ws5Fixture?.cleanup();
});

const sha256 = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');

describe('WS5 finite matrix runner', () => {
  it('rejects stale revised and repeat runtime pins even when they match the old baseline', () => {
    expect(runner).not.toBeNull();
    expect(typeof runner.assertRuntimeIdentity).toBe('function');
    const baseline = 'e70749fd4b14cb284b1497974306975cbce2d47a';

    expect(() => runner.assertRuntimeIdentity({
      armId: 'yeti-revised-medium', expectedRuntimeSha: baseline, actualRuntimeSha: baseline,
      worktreeClean: true,
    })).toThrow('ws5_revised_runtime_pin_is_stale');
    expect(() => runner.assertRuntimeIdentity({
      armId: 'yeti-revised-medium-repeat', expectedRuntimeSha: 'a'.repeat(40),
      actualRuntimeSha: 'a'.repeat(40), revisedRuntimeSha: 'b'.repeat(40), worktreeClean: true,
    })).toThrow('ws5_repeat_runtime_pin_mismatch');
    expect(() => runner.assertRuntimeIdentity({
      armId: 'yeti-v1-native-baseline', expectedRuntimeSha: baseline, actualRuntimeSha: baseline,
      worktreeClean: false,
    })).toThrow('ws5_runtime_worktree_dirty');
  });

  it('selects the separately validated repeat runtime root and host identity for repeat cells', () => {
    expect(runner).not.toBeNull();
    const revisedIdentity = {
      commit: 'a'.repeat(40), tree: 'b'.repeat(40), worktreeClean: true,
      hostExecution: { runnerSourceSha256: 'c'.repeat(64) },
    };
    const repeatIdentity = {
      commit: 'a'.repeat(40), tree: 'b'.repeat(40), worktreeClean: true,
      hostExecution: { runnerSourceSha256: 'd'.repeat(64) },
    };
    const binding = runner.selectYetiRuntimeForCell({
      armId: 'yeti-revised-medium-repeat', runtimeSha: null,
    }, {
      revisedRuntimeRoot: '/tmp/runtime-revised', revisedRuntimeSha: 'a'.repeat(40),
      repeatRuntimeRoot: '/tmp/runtime-repeat', repeatRuntimeSha: 'a'.repeat(40),
    }, { revised: revisedIdentity, repeat: repeatIdentity });
    expect(binding).toMatchObject({
      runtimeRoot: '/tmp/runtime-repeat',
      expectedRuntimeSha: 'a'.repeat(40),
      hostExecution: repeatIdentity.hostExecution,
    });
  });

  it('requires identical pinned route resources across the baseline revised and repeat no-call preflights', () => {
    const profile = (transportName = 'openrouter') => ({
      status: 'ready_without_model_call', modelCalls: 0, transportName, requestedModel: 'pr-reviewer',
      modelConfigDefaults: {
        source: 'pipeline.resolveModelConfig', transportName, requestedModel: 'pr-reviewer', provider: null,
        compat: 'openrouter', stream: true, maxTokens: 24_576, timeoutMs: 240_000, reasoningEffort: null,
      },
      productionPublishingTransport: {
        resolver: 'runtime.publishing.openaiTransport', protocol: 'https:', endpointHost: '127.0.0.1',
        requestedModel: 'pr-reviewer', resourceLimits: 'not_exposed_by_publishing_transport_resolver',
      },
      loopbackOnly: true, inactiveProviderCredentialCount: 0,
      localTlsBoundary: {
        certificateSha256: 'e'.repeat(64), opensslExecutableSha256: 'f'.repeat(64),
        childTrust: 'NODE_EXTRA_CA_CERTS_public_certificate_only', privateKeySentToChild: false,
      },
    });
    expect(runner.assertMatchedPrimaryTransportProfiles([profile(), profile(), profile()])).toBe(true);
    expect(() => runner.assertMatchedPrimaryTransportProfiles([
      profile(), { ...profile(), modelConfigDefaults: { ...profile().modelConfigDefaults, maxTokens: 16_384 } }, profile(),
    ])).toThrow('ws5_primary_transport_resource_profile_mismatch');
    expect(() => runner.assertMatchedPrimaryTransportProfiles([
      profile(), profile('other-route'), profile(),
    ])).toThrow('ws5_primary_transport_resource_profile_mismatch');
    expect(() => runner.assertMatchedPrimaryTransportProfiles([
      profile('openrouter'), { ...profile('openrouter'), productionPublishingTransport: {
        ...profile('openrouter').productionPublishingTransport, endpointHost: 'gateway.example.invalid',
      } }, profile('openrouter'),
    ])).toThrow('ws5_production_publishing_transport_mismatch');
  });

  it('verifies an image pin from immutable receipt bytes and source/platform identities', () => {
    expect(runner).not.toBeNull();
    expect(typeof runner.verifyImagePinReceipt).toBe('function');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-image-pin-'));
    const imageDigest = `sha256:${'c'.repeat(64)}`;
    const platformDigest = `sha256:${'d'.repeat(64)}`;
    const receipt = {
      schemaVersion: 'ReviewYetiWS5ImageProvenance.v1',
      subject: { digest: imageDigest },
      source: { commitSha: 'b'.repeat(40) },
      build: { runId: '37409566461', provenanceSha256: 'e'.repeat(64) },
      platformManifests: [{ platform: 'linux/amd64', digest: platformDigest }],
    };
    const bytes = Buffer.from(JSON.stringify(receipt));
    const receiptPath = path.join(directory, 'image-provenance.json');
    fs.writeFileSync(receiptPath, bytes, { mode: 0o600 });
    try {
      expect(runner.verifyImagePinReceipt(receiptPath, {
        expectedReceiptSha256: sha256(bytes),
        expectedSourceCommit: 'b'.repeat(40),
        expectedImageDigest: imageDigest,
        requiredPlatform: 'linux/amd64',
      })).toMatchObject({ imageDigest, sourceCommit: 'b'.repeat(40), platformDigest });
      expect(() => runner.verifyImagePinReceipt(receiptPath, {
        expectedReceiptSha256: 'f'.repeat(64), expectedSourceCommit: 'b'.repeat(40),
        expectedImageDigest: imageDigest, requiredPlatform: 'linux/amd64',
      })).toThrow('ws5_image_provenance_digest_mismatch');

      fs.writeFileSync(receiptPath, JSON.stringify({ verified: true }));
      expect(() => runner.verifyImagePinReceipt(receiptPath, {
        expectedReceiptSha256: sha256(fs.readFileSync(receiptPath)),
        expectedSourceCommit: 'b'.repeat(40), expectedImageDigest: imageDigest,
        requiredPlatform: 'linux/amd64',
      })).toThrow('ws5_image_provenance_schema_invalid');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records the executed host toolchain and marks the worker image as provenance only', () => {
    expect(runner).not.toBeNull();
    const identity = runner.readRuntimeIdentity(process.cwd());
    expect(identity.hostExecution).toMatchObject({
      executionMode: 'host_node',
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      workerImageExecution: 'provenance_reference_only_not_executed_by_ws5_host_runner',
    });
    for (const key of [
      'nodeExecutableSha256', 'runnerSourceSha256', 'runnerPackageLockSha256',
      'runtimePackageLockSha256', 'tsNodeLoaderSha256', 'typescriptEntrySha256',
    ]) expect(identity.hostExecution[key]).toMatch(/^[a-f0-9]{64}$/u);
    expect(identity.hostExecution.runnerSourceCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(identity.hostExecution.runtimeEntryFilesSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('binds the source freeze to actual committed blobs and the current Git tree', () => {
    expect(runner).not.toBeNull();
    expect(typeof runner.verifyPublicSourceFreeze).toBe('function');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-helper-freeze-'));
    const freezeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-freeze-receipt-'));
    const requiredFiles = [
      'scripts/competitive-review-benchmark.mjs',
      'scripts/ws5-acceptance.mjs',
      'scripts/ws5-alibaba.mjs',
      'scripts/ws5-external-data-contract.mjs',
      'scripts/ws5-matrix-runner.mjs',
      'scripts/ws5-verification-runner.mjs',
      'tests/unit/competitiveReviewBenchmark.test.ts',
      'tests/unit/ws5Acceptance.test.ts',
      'tests/unit/ws5ExternalDataContract.test.ts',
      'tests/unit/ws5MatrixRunner.test.ts',
      'tests/unit/ws5VerificationRunner.test.ts',
    ];
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    try {
      git(['init', '--quiet']);
      git(['config', 'user.name', 'WS5 neutral test']);
      git(['config', 'user.email', 'ws5-neutral@example.invalid']);
      const publicAllowlist = requiredFiles.map((file, index) => {
        const destination = path.join(root, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const bytes = Buffer.from(`neutral public test file ${index}\n`);
        fs.writeFileSync(destination, bytes);
        return { path: file, sha256: sha256(bytes), category: 'source_or_test' };
      });
      git(['add', ...requiredFiles]);
      git(['commit', '--quiet', '-m', 'neutral helper fixture']);
      const headCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const gitTreeOid = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
      const descriptor = publicAllowlist.map(({ path: file, sha256: digest }) => ({ path: file, sha256: digest }));
      const freeze = {
        schemaVersion: 'ReviewYetiPublicSourceFreeze.v2',
        sourceTreeSha256: 'a'.repeat(64),
        allowlistDigest: sha256(JSON.stringify(descriptor)),
        publicAllowlist,
        localGitCommitSnapshot: { headCommitSha, gitTreeOid },
      };
      const freezePath = path.join(freezeDirectory, 'freeze.json');
      const bytes = Buffer.from(JSON.stringify(freeze));
      fs.writeFileSync(freezePath, bytes, { mode: 0o600 });
      expect(runner.verifyPublicSourceFreeze(root, freezePath, sha256(bytes))).toMatchObject({
        headCommitSha, gitTreeOid, allowlistedFileCount: 11,
      });
      for (const required of [
        'scripts/ws5-external-data-contract.mjs',
        'tests/unit/ws5ExternalDataContract.test.ts',
      ]) {
        const missingContractBoundary = {
          ...freeze,
          publicAllowlist: publicAllowlist.filter((entry) => entry.path !== required),
        };
        const missingDescriptor = missingContractBoundary.publicAllowlist.map(({ path: file, sha256: digest }) => ({
          path: file, sha256: digest,
        }));
        missingContractBoundary.allowlistDigest = sha256(JSON.stringify(missingDescriptor));
        const missingBytes = Buffer.from(JSON.stringify(missingContractBoundary));
        fs.writeFileSync(freezePath, missingBytes);
        expect(() => runner.verifyPublicSourceFreeze(root, freezePath, sha256(missingBytes)))
          .toThrow('ws5_source_freeze_allowlist_incomplete');
      }
      fs.writeFileSync(freezePath, bytes);
      fs.appendFileSync(path.join(root, requiredFiles[0]), 'changed');
      expect(() => runner.verifyPublicSourceFreeze(root, freezePath, sha256(bytes)))
        .toThrow('ws5_source_freeze_file_digest_mismatch');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(freezeDirectory, { recursive: true, force: true });
    }
  });

  it('kills a child at the hard wall deadline and reports a terminal timeout', async () => {
    expect(runner).not.toBeNull();
    expect(typeof runner.runBoundedChildProcess).toBe('function');
    const result = await runner.runBoundedChildProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH || '' },
      maxWallMs: 50,
      killGraceMs: 50,
    });
    expect(result).toMatchObject({ terminal: 'timed_out', terminationRequested: true });
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });

  it('cancels an active child when the parent interrupts the run', async () => {
    expect(runner).not.toBeNull();
    expect(typeof runner.runBoundedChildProcess).toBe('function');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      const result = await runner.runBoundedChildProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: os.tmpdir(),
        env: { PATH: process.env.PATH || '' },
        maxWallMs: 5000,
        killGraceMs: 50,
        signal: controller.signal,
      });
      expect(result).toMatchObject({ terminal: 'aborted', terminationRequested: true });
    } finally {
      clearTimeout(timer);
    }
  });

  it('does not read a parent credential unless dispatch is explicitly authorized', async () => {
    expect(runner).not.toBeNull();
    expect(typeof runner.runWs5Matrix).toBe('function');
    let credentialReads = 0;
    await expect(runner.runWs5Matrix({
      authorizeModelDispatch: false,
      parentBroker: { readApiKeyInMemory: () => { credentialReads += 1; return 'sentinel'; } },
    })).rejects.toThrow('ws5_model_dispatch_not_authorized_by_root');
    expect(credentialReads).toBe(0);
  });

  it('terminalizes the full plan without reading credentials when final pins are missing', async () => {
    expect(runner).not.toBeNull();
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-pins-not-ready-'));
    let credentialReads = 0;
    try {
      const result = await runner.runWs5Matrix({
        authorizeModelDispatch: true,
        repoRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
        dataRoot: path.join(os.tmpdir(), 'ws5-unit-private-data-root'),
        planPath: 'eval-baselines/competitive-review-benchmark/ws5-acceptance-v1.json',
        externalDataContractPath: path.join(os.tmpdir(), 'ws5-unit-external-data-contract.json'),
        externalDataContractSha256: 'a'.repeat(64),
        outputDirectory,
        sourceCacheRoot: os.tmpdir(),
        alibabaBinaryPath: process.execPath,
        pins: null,
        parentBroker: {
          bifrostBaseUrl: 'https://bifrost.invalid',
          preflightAlias: async () => { throw new Error('must_not_run'); },
          readApiKeyInMemory: () => { credentialReads += 1; return 'unused'; },
          attestRequests: async () => { throw new Error('must_not_run'); },
        },
      });
      expect(credentialReads).toBe(0);
      expect(result.cells).toHaveLength(28);
      expect(result.manifest).toMatchObject({ status: 'incomplete', modelRunCells: 0,
        incompleteCells: 28, qualityScore: null });
      expect(fs.readdirSync(outputDirectory)).toHaveLength(30);
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('keeps the exact serial resource ceiling explicit and provides only a dummy child credential', () => {
    expect(runner).not.toBeNull();
    expect(runner.WS5_MATRIX_BOUNDS).toMatchObject({
      expectedCells: 28,
      modelRunCells: 27,
      preflightAbstentionCells: 1,
      maxConcurrentCells: 1,
      automaticRetries: 0,
      maxForwardedModelRequestsPerCell: 100,
      maxCellWallMs: 1_200_000,
      maxPreflightWallMs: 1_200_000,
      maxFinalizationWallMs: 300_000,
      maxPanelWallMs: 33_900_000,
    });
    const tlsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-child-ca-root-'));
    const tls = runner.createEphemeralLoopbackTls(tlsRoot);
    try {
      const env = runner.createSanitizedYetiChildEnvironment({
        home: path.join(os.tmpdir(), 'ws5-child-home'),
        temporaryDirectory: path.join(os.tmpdir(), 'ws5-child-tmp'),
        localBaseUrl: 'https://127.0.0.1:12345/v1',
        localToken: 'dummy-loopback-token-not-provider-secret-1234567890',
        localCaCertificatePath: tls.publicCaPath,
      });
      expect(env).toMatchObject({
        OPENROUTER_BASE_URL: 'https://127.0.0.1:12345/v1',
        OPENROUTER_API_KEY: 'dummy-loopback-token-not-provider-secret-1234567890',
        OPENROUTER_MODEL: 'pr-reviewer',
        REVIEW_TRANSPORT_DESTINATION: 'gateway',
        REVIEW_YETI_GATEWAY_BASE_URL: 'https://127.0.0.1:12345/v1',
        REVIEW_YETI_BIFROST_API_KEY: 'dummy-loopback-token-not-provider-secret-1234567890',
        REVIEW_MODEL: 'pr-reviewer',
        NODE_EXTRA_CA_CERTS: fs.realpathSync(tls.publicCaPath),
        WS5_LOOPBACK_BROKER: '1',
        GIT_NO_LAZY_FETCH: '1',
      });
      expect(env).not.toHaveProperty('REVIEW_YETI_TRANSPORTS');
      expect(env).not.toHaveProperty('WS5_BIFROST_API_KEY');
      expect(env).not.toHaveProperty('BIFROST_API_KEY');
      expect(Object.keys(env).filter((key) =>
        /^(?:OPENAI|ANTHROPIC|GEMINI|SYNTHETIC|OLLAMA)_.*KEY$/u.test(key))).toEqual([]);
    } finally {
      tls.cleanup();
      fs.rmSync(tlsRoot, { recursive: true, force: true });
    }
  });

  it('uses the meter proxy local bearer boundary and rejects missing source ordinals before forwarding', async () => {
    const { createBifrostMeterProxy } = await import('../../scripts/ws5-alibaba.mjs');
    const localToken = 'dummy-loopback-token-not-provider-secret-1234567890';
    const proxy = createBifrostMeterProxy({
      upstreamBaseUrl: 'https://bifrost.invalid',
      apiKey: 'parent-memory-only-sentinel',
      modelAlias: 'pr-reviewer',
      maxForwardedAttempts: 1,
      maxInboundAttempts: 1,
      maxOutputTokensPerRequest: null,
      requestAccountingMode: 'review_yeti',
      localBearerToken: localToken,
    });
    const baseUrl = await proxy.listen();
    try {
      const body = JSON.stringify({ model: 'pr-reviewer', stream: false });
      const unauthorized = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body,
      });
      expect(unauthorized.status).toBe(401);
      const uninstrumented = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body,
      });
      expect(uninstrumented.status).toBe(400);
      expect(proxy.snapshot()).toMatchObject({
        receivedCompletionAttempts: 1,
        forwardedCompletionAttempts: 0,
        requests: [{ logicalMappingStatus: 'invalid_source_completion_ordinals' }],
      });
      expect(JSON.stringify(proxy.snapshot())).not.toContain('parent-memory-only-sentinel');
      expect(JSON.stringify(proxy.snapshot())).not.toContain(localToken);
    } finally {
      await proxy.close();
    }
  });

  it('joins concurrent proxy and runtime attempts by unique local ordinal, not arrival order', () => {
    expect(runner).not.toBeNull();
    const firstDigest = 'a'.repeat(16);
    const secondDigest = 'b'.repeat(16);
    const proxySnapshot = {
      requests: [
        { localAttemptOrdinal: 1, logicalDispatchOrdinal: 1, gatewayRequestIdDigest: firstDigest },
        { localAttemptOrdinal: 2, logicalDispatchOrdinal: 2, gatewayRequestIdDigest: secondDigest },
      ],
    };
    const runtimeAttempts = [
      { localAttemptOrdinal: 2, logicalDispatchOrdinal: 2, gatewayRequestIdDigests: [secondDigest] },
      { localAttemptOrdinal: 1, logicalDispatchOrdinal: 1, gatewayRequestIdDigests: [firstDigest] },
    ];
    expect(runner.assertLocalProxyAgainstRuntime(proxySnapshot, runtimeAttempts)).toBe(true);
    expect(() => runner.assertLocalProxyAgainstRuntime(proxySnapshot, [
      { ...runtimeAttempts[0], localAttemptOrdinal: 1, gatewayRequestIdDigests: [firstDigest] },
      { ...runtimeAttempts[1], localAttemptOrdinal: 2, gatewayRequestIdDigests: [secondDigest] },
    ])).toThrow('ws5_local_runtime_attempt_identity_mismatch');
    expect(() => runner.assertLocalProxyAgainstRuntime(proxySnapshot, [
      runtimeAttempts[1], { ...runtimeAttempts[0], localAttemptOrdinal: 3 },
    ])).toThrow('ws5_local_runtime_attempt_identity_mismatch');
  });

  it('maps concurrent loopback headers by source ordinal even when they arrive out of order', async () => {
    const { createBifrostMeterProxy } = await import('../../scripts/ws5-alibaba.mjs');
    const localToken = 'dummy-loopback-token-not-provider-secret-1234567890';
    const proxy = createBifrostMeterProxy({
      upstreamBaseUrl: 'https://bifrost.invalid',
      apiKey: 'parent-memory-only-sentinel',
      modelAlias: 'pr-reviewer',
      maxForwardedAttempts: 2,
      maxInboundAttempts: 2,
      maxOutputTokensPerRequest: null,
      requestAccountingMode: 'review_yeti',
      localBearerToken: localToken,
    });
    const baseUrl = await proxy.listen();
    try {
      for (const [localAttemptOrdinal, logicalDispatchOrdinal] of [[2, 2], [1, 1]]) {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${localToken}`,
            'content-type': 'application/json',
            'x-ws5-local-attempt-ordinal': String(localAttemptOrdinal),
            'x-ws5-logical-dispatch-ordinal': String(logicalDispatchOrdinal),
          },
          body: JSON.stringify({ model: 'wrong-model', stream: false }),
        });
        expect(response.status).toBe(400);
      }
      expect(proxy.snapshot()).toMatchObject({
        receivedCompletionAttempts: 2,
        forwardedCompletionAttempts: 0,
        unknownAttemptCount: 0,
        dispatchAttemptAccountingMatches: true,
        requests: [
          { localAttemptOrdinal: 2, logicalDispatchOrdinal: 2, logicalMappingStatus: 'source_instrumented_completion_scope' },
          { localAttemptOrdinal: 1, logicalDispatchOrdinal: 1, logicalMappingStatus: 'source_instrumented_completion_scope' },
        ],
      });
    } finally {
      await proxy.close();
    }
  });

  it('serves the Yeti loopback broker over HTTPS with a parent-held key and public CA trust', async () => {
    const { createBifrostMeterProxy } = await import('../../scripts/ws5-alibaba.mjs');
    const tlsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-loopback-tls-test-'));
    const tls = runner.createEphemeralLoopbackTls(tlsRoot);
    const localToken = 'dummy-loopback-token-not-provider-secret-1234567890';
    const proxy = createBifrostMeterProxy({
      upstreamBaseUrl: 'https://bifrost.invalid',
      apiKey: 'parent-memory-only-sentinel',
      modelAlias: 'pr-reviewer',
      maxForwardedAttempts: 1,
      maxInboundAttempts: 1,
      maxOutputTokensPerRequest: null,
      requestAccountingMode: 'review_yeti',
      localBearerToken: localToken,
      localTls: { key: tls.key, cert: tls.cert },
    });
    const baseUrl = await proxy.listen();
    try {
      expect(baseUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/v1$/u);
      const childEnvironment = runner.createSanitizedYetiChildEnvironment({
        home: path.join(tlsRoot, 'child-home'),
        temporaryDirectory: path.join(tlsRoot, 'child-tmp'),
        localBaseUrl: baseUrl,
        localToken,
        localCaCertificatePath: tls.publicCaPath,
      });
      fs.mkdirSync(childEnvironment.HOME, { recursive: true, mode: 0o700 });
      fs.mkdirSync(childEnvironment.TMPDIR, { recursive: true, mode: 0o700 });
      const childCode = `fetch(${JSON.stringify(`${baseUrl}/chat/completions`)}, {method:'POST',headers:{authorization:'Bearer wrong','content-type':'application/json'},body:JSON.stringify({model:'pr-reviewer',stream:false})}).then((response)=>{process.stdout.write(String(response.status));}).catch(()=>{process.exitCode=2;});`;
      const childResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', childCode], {
          cwd: tlsRoot, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
      expect(childResult.code, childResult.stderr).toBe(0);
      expect(childResult.stdout.trim()).toBe('401');
      const response = await new Promise<number>((resolve, reject) => {
        const request = https.request(`${baseUrl}/chat/completions`, {
          method: 'POST',
          ca: fs.readFileSync(tls.publicCaPath),
          headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        }, (reply) => {
          reply.resume();
          reply.on('end', () => resolve(reply.statusCode || 0));
        });
        request.on('error', reject);
        request.end(JSON.stringify({ model: 'pr-reviewer', stream: false }));
      });
      expect(response).toBe(401);
      expect(proxy.snapshot()).toMatchObject({ receivedCompletionAttempts: 0, forwardedCompletionAttempts: 0 });
      expect(tls.key.length).toBeGreaterThan(0);
      expect(tls.cert.toString('ascii')).toContain('-----BEGIN CERTIFICATE-----');
      expect(tls.cert.toString('ascii')).not.toContain('PRIVATE KEY');
      expect(fs.existsSync(path.join(path.dirname(tls.publicCaPath), 'loopback-key.pem'))).toBe(false);
    } finally {
      await proxy.close();
      tls.cleanup();
      fs.rmSync(tlsRoot, { recursive: true, force: true });
    }
  });
});
