import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_RESPONSE_BYTES,
  MCP_AUTH_SECRET_NAME,
  readWorkerName,
  syncMcpAuthSecret,
} from './sync-mcp-auth-secret.mjs';

const dopplerToken = 'dummy-doppler-access-token';
const workerSecret = 'dummy-mcp-auth-secret-value';

function validEnv(overrides = {}) {
  return {
    REVIEW_YETI_DOPPLER_TOKEN: dopplerToken,
    REVIEW_YETI_DOPPLER_PROJECT: 'public-project-configured-by-operator',
    REVIEW_YETI_DOPPLER_CONFIG: 'production-config-configured-by-operator',
    CLOUDFLARE_API_TOKEN: 'dummy-cloudflare-deploy-token',
    CLOUDFLARE_ACCOUNT_ID: 'configured-account-id',
    ...overrides,
  };
}

function fetchResponses({ dopplerResponse, cloudflareResponse, onRequest } = {}) {
  return async (url, init) => {
    const parsedUrl = new URL(url);
    onRequest?.(parsedUrl, init);
    if (parsedUrl.hostname === 'api.doppler.com') {
      return dopplerResponse ?? Response.json({
        name: MCP_AUTH_SECRET_NAME,
        value: { computed: workerSecret },
      });
    }
    return cloudflareResponse ?? Response.json({
      success: true,
      result: { name: MCP_AUTH_SECRET_NAME, type: 'secret_text', text: workerSecret },
    });
  };
}

describe('Doppler to Worker MCP token projection', () => {
  it('fetches only the named Doppler secret and sends one secret binding to Cloudflare', async () => {
    const calls = [];
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));

    try {
      const result = await syncMcpAuthSecret({
        env: validEnv(),
        workerName: 'test-worker',
        fetchImpl: fetchResponses({ onRequest: (url, init) => calls.push({ url, init }) }),
      });
      assert.equal(result, undefined);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.origin, 'https://api.doppler.com');
    assert.equal(calls[0].url.pathname, '/v3/configs/config/secret');
    assert.deepEqual([...calls[0].url.searchParams.keys()].sort(), ['config', 'name', 'project']);
    assert.equal(calls[0].url.searchParams.get('project'), 'public-project-configured-by-operator');
    assert.equal(calls[0].url.searchParams.get('config'), 'production-config-configured-by-operator');
    assert.equal(calls[0].url.searchParams.get('name'), MCP_AUTH_SECRET_NAME);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${dopplerToken}`);

    assert.equal(calls[1].url.origin, 'https://api.cloudflare.com');
    assert.equal(calls[1].url.pathname, '/client/v4/accounts/configured-account-id/workers/scripts/test-worker/secrets');
    assert.equal(calls[1].init.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      name: MCP_AUTH_SECRET_NAME,
      text: workerSecret,
      type: 'secret_text',
    });
    assert.equal(calls[1].init.headers.Authorization, 'Bearer dummy-cloudflare-deploy-token');

    for (const call of calls) {
      assert.equal(call.init.redirect, 'error');
      assert.ok(call.init.signal instanceof AbortSignal);
    }
    assert.equal(logs.join('\n').includes(workerSecret), false);
    assert.equal(logs.join('\n').includes(dopplerToken), false);
  });

  it('fails before requesting when a required source or deployment input is absent', async () => {
    let fetchCount = 0;
    for (const name of [
      'REVIEW_YETI_DOPPLER_TOKEN',
      'REVIEW_YETI_DOPPLER_PROJECT',
      'REVIEW_YETI_DOPPLER_CONFIG',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
    ]) {
      await assert.rejects(
        syncMcpAuthSecret({
          env: validEnv({ [name]: '' }),
          workerName: 'test-worker',
          fetchImpl: async () => { fetchCount += 1; throw new Error('must not request'); },
        }),
        new RegExp(`missing_${name}`),
      );
    }
    assert.equal(fetchCount, 0);
  });

  it('does not update Cloudflare when Doppler omits or empties the requested key', async () => {
    let cloudflareCalls = 0;
    const fetchImpl = async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname === 'api.doppler.com') {
        return Response.json({ name: 'A_DIFFERENT_KEY', value: { computed: workerSecret } });
      }
      cloudflareCalls += 1;
      return Response.json({ success: true, result: { name: MCP_AUTH_SECRET_NAME, type: 'secret_text' } });
    };

    await assert.rejects(
      syncMcpAuthSecret({ env: validEnv(), workerName: 'test-worker', fetchImpl }),
      /doppler_secret_missing_or_invalid/u,
    );
    assert.equal(cloudflareCalls, 0);

    await assert.rejects(
      syncMcpAuthSecret({
        env: validEnv(),
        workerName: 'test-worker',
        fetchImpl: async () => Response.json({ name: MCP_AUTH_SECRET_NAME, value: { computed: '' } }),
      }),
      /doppler_secret_missing_or_invalid/u,
    );
  });

  it('redacts provider error bodies and prevents projection on provider failure', async () => {
    let cloudflareCalls = 0;
    await assert.rejects(
      syncMcpAuthSecret({
        env: validEnv(),
        workerName: 'test-worker',
        fetchImpl: async (url) => {
          if (new URL(url).hostname === 'api.doppler.com') {
            return new Response(`${dopplerToken} ${workerSecret}`, { status: 403 });
          }
          cloudflareCalls += 1;
          return Response.json({ success: true, result: { name: MCP_AUTH_SECRET_NAME, type: 'secret_text' } });
        },
      }),
      (error) => {
        assert.equal(error.message, 'doppler_http_403');
        assert.equal(error.message.includes(dopplerToken), false);
        assert.equal(error.message.includes(workerSecret), false);
        return true;
      },
    );
    assert.equal(cloudflareCalls, 0);

    await assert.rejects(
      syncMcpAuthSecret({
        env: validEnv(),
        workerName: 'test-worker',
        fetchImpl: fetchResponses({
          cloudflareResponse: new Response(`${dopplerToken} ${workerSecret}`, { status: 403 }),
        }),
      }),
      (error) => {
        assert.equal(error.message, 'cloudflare_http_403');
        assert.equal(error.message.includes(dopplerToken), false);
        assert.equal(error.message.includes(workerSecret), false);
        return true;
      },
    );

    await assert.rejects(
      syncMcpAuthSecret({
        env: validEnv(),
        workerName: 'test-worker',
        fetchImpl: fetchResponses({
          cloudflareResponse: Response.json({
            success: false,
            errors: [{ message: `${dopplerToken} ${workerSecret}` }],
          }),
        }),
      }),
      (error) => {
        assert.equal(error.message, 'cloudflare_response_invalid');
        assert.equal(error.message.includes(dopplerToken), false);
        assert.equal(error.message.includes(workerSecret), false);
        return true;
      },
    );
  });

  it('rejects oversized and malformed Doppler responses before making a Cloudflare request', async () => {
    let cloudflareCalls = 0;
    await assert.rejects(
      syncMcpAuthSecret({
        env: validEnv(),
        workerName: 'test-worker',
        fetchImpl: async (url) => {
          if (new URL(url).hostname === 'api.doppler.com') {
            return new Response(JSON.stringify({ large: 'x'.repeat(MAX_RESPONSE_BYTES) }));
          }
          cloudflareCalls += 1;
          return Response.json({ success: true, result: { name: MCP_AUTH_SECRET_NAME, type: 'secret_text' } });
        },
      }),
      /doppler_response_too_large/u,
    );
    assert.equal(cloudflareCalls, 0);

    await assert.rejects(
      syncMcpAuthSecret({
        env: validEnv(),
        workerName: 'test-worker',
        fetchImpl: async () => new Response('not-json'),
      }),
      /doppler_response_invalid_json/u,
    );
  });

  it('bounds hanging requests and refuses redirects carrying provider credentials', async () => {
    let redirectPolicy;
    let observedAbort = false;
    await assert.rejects(
      syncMcpAuthSecret({
        env: validEnv(),
        workerName: 'test-worker',
        timeoutMs: 20,
        fetchImpl: async (_url, init) => {
          redirectPolicy = init.redirect;
          return new Promise((_resolve, reject) => {
            // A real request keeps the event loop alive. AbortSignal.timeout
            // alone does not, so give the mock a bounded referenced handle.
            const watchdog = setTimeout(() => {
              init.signal.removeEventListener('abort', onAbort);
              reject(new Error('mock request did not receive an abort'));
            }, 1000);
            const onAbort = () => {
              clearTimeout(watchdog);
              observedAbort = true;
              reject(new Error(`${dopplerToken} ${workerSecret}`));
            };
            if (init.signal.aborted) onAbort();
            else init.signal.addEventListener('abort', onAbort, { once: true });
          });
        },
      }),
      (error) => {
        assert.equal(error.message, 'doppler_request_failed');
        assert.equal(error.message.includes(dopplerToken), false);
        assert.equal(error.message.includes(workerSecret), false);
        return true;
      },
    );
    assert.equal(observedAbort, true, 'the request deadline must cancel the in-flight request');
    assert.equal(redirectPolicy, 'error');
  });

  it('reads the Worker target from Wrangler config without a deployment-specific hostname', async () => {
    const workerName = await readWorkerName();
    assert.match(workerName, /^[A-Za-z0-9_-]+$/u);
  });

  it('requires credential projection inputs and orders synchronization before deploy', async () => {
    const workflow = await readFile(resolve(process.cwd(), '../.github/workflows/cf-orchestrator-ci.yaml'), 'utf8');
    const deployJob = workflow.slice(workflow.indexOf('  deploy-orchestrator:'));
    const syncStepIndex = deployJob.indexOf('- name: Project MCP auth token from Doppler');
    const deployStepIndex = deployJob.indexOf('- name: Deploy to Cloudflare Edge');
    const deployJobEnv = deployJob.slice(0, deployJob.indexOf('    steps:'));

    assert.ok(syncStepIndex >= 0);
    assert.ok(deployStepIndex > syncStepIndex);
    assert.match(deployJobEnv, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/u);
    assert.match(deployJobEnv, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/u);
    const syncStep = deployJob.slice(syncStepIndex, deployStepIndex);
    const deploymentGuard = "if: env.CLOUDFLARE_API_TOKEN != ''";
    assert.ok(syncStep.includes(deploymentGuard), 'secret sync must skip the disabled-deploy path');
    assert.ok(deployJob.slice(deployStepIndex).includes(deploymentGuard), 'sync and deploy must share their enable condition');
    assert.match(syncStep, /node scripts\/sync-mcp-auth-secret\.mjs/u);
    assert.match(syncStep, /REVIEW_YETI_DOPPLER_TOKEN:\s*\$\{\{\s*secrets\.REVIEW_YETI_DOPPLER_TOKEN\s*\}\}/u);
    assert.match(syncStep, /REVIEW_YETI_DOPPLER_PROJECT:\s*\$\{\{\s*vars\.REVIEW_YETI_DOPPLER_PROJECT\s*\}\}/u);
    assert.match(syncStep, /REVIEW_YETI_DOPPLER_CONFIG:\s*\$\{\{\s*vars\.REVIEW_YETI_DOPPLER_CONFIG\s*\}\}/u);
  });
});
