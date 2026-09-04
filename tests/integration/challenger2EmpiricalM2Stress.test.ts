import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import type { CtReviewConfigV3 } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { executePersonaPanel, PanelConfigurationError } from '../../src/panel/panelEngine';

const testPolicy = `
version: 3
profile: chill
quorum: 1
personas:
  - id: security-tenancy
    enabled: true
    required: true
    charter: builtin:security
    paths: ["src/**"]
    providers: [grok]
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 900
  providers:
    - id: grok
      enabled: true
      model: grok-cli/grok-4.5
      effort: high
      review_timeout_s: 1
      arbiter_timeout_s: 1
  arbiter:
    order: [grok]
`;

describe('Challenger 2 Empirical Stress Test: panelEngine & omniRouteClient Failure Handling', () => {
  let timeoutServer: http.Server;
  let timeoutPort: number;
  let error500Server: http.Server;
  let error500Port: number;

  beforeAll(async () => {
    // Server that hangs indefinitely (for connection timeout test)
    timeoutServer = http.createServer((_req, _res) => {
      // Do not respond, allow client timeout to trigger
    });
    await new Promise<void>((resolve) => timeoutServer.listen(0, '127.0.0.1', () => resolve()));
    timeoutPort = (timeoutServer.address() as any).port;

    // Server that returns HTTP 500 Internal Server Error
    error500Server = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    });
    await new Promise<void>((resolve) => error500Server.listen(0, '127.0.0.1', () => resolve()));
    error500Port = (error500Server.address() as any).port;
  });

  afterAll(() => {
    timeoutServer?.close();
    error500Server?.close();
  });

  it('Scenario 1: DNS Resolution Failure — panelEngine must fail closed and NOT return synthetic approvals', async () => {
    const config = parseAndValidateConfig(testPolicy) as unknown as CtReviewConfigV3;
    const client = new OmniRouteClient({
      baseUrl: 'http://nonexistent-dns-domain-xyz123456789.invalid:9999',
    });

    let returnedResult: any = null;
    let caughtError: any = null;

    try {
      returnedResult = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/index.ts', patch: 'console.log("test");' }],
        repository: 'test/repo',
        headSha: '1234567890abcdef',
        client,
      });
    } catch (err) {
      caughtError = err;
    }

    // Verify empirical behavior:
    // MUST fail closed (caughtError != null) AND MUST NOT return synthetic approval object (returnedResult == null)
    console.log('[Scenario 1 DNS Failure] returnedResult:', returnedResult);
    console.log('[Scenario 1 DNS Failure] caughtError:', caughtError?.message);

    expect(returnedResult).toBeNull();
    expect(caughtError).toBeInstanceOf(Error);
  });

  it('Scenario 2: Connection Timeout — panelEngine must fail closed and NOT return synthetic approvals', async () => {
    const config = parseAndValidateConfig(testPolicy) as unknown as CtReviewConfigV3;
    const client = new OmniRouteClient({
      baseUrl: `http://127.0.0.1:${timeoutPort}`,
    });

    let returnedResult: any = null;
    let caughtError: any = null;

    try {
      returnedResult = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/index.ts', patch: 'console.log("test");' }],
        repository: 'test/repo',
        headSha: '1234567890abcdef',
        client,
      });
    } catch (err) {
      caughtError = err;
    }

    console.log('[Scenario 2 Timeout] returnedResult:', returnedResult);
    console.log('[Scenario 2 Timeout] caughtError:', caughtError?.message);

    expect(returnedResult).toBeNull();
    expect(caughtError).toBeInstanceOf(Error);
  });

  it('Scenario 3: HTTP 500 Error — panelEngine must fail closed and NOT return synthetic approvals', async () => {
    const config = parseAndValidateConfig(testPolicy) as unknown as CtReviewConfigV3;
    const client = new OmniRouteClient({
      baseUrl: `http://127.0.0.1:${error500Port}`,
    });

    let returnedResult: any = null;
    let caughtError: any = null;

    try {
      returnedResult = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/index.ts', patch: 'console.log("test");' }],
        repository: 'test/repo',
        headSha: '1234567890abcdef',
        client,
      });
    } catch (err) {
      caughtError = err;
    }

    console.log('[Scenario 3 HTTP 500] returnedResult:', returnedResult);
    console.log('[Scenario 3 HTTP 500] caughtError:', caughtError?.message);

    expect(returnedResult).toBeNull();
    expect(caughtError).toBeInstanceOf(Error);
  });
});
