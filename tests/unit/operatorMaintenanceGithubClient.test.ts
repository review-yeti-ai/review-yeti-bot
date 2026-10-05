import { describe, expect, it, vi } from 'vitest';
import { GitHubInstallationClient, type OperatorMaintenanceCheckInput } from '../../src/github/installationClient';

const DIGEST = 'a'.repeat(64);
const HEAD = 'b'.repeat(40);
const INTENT_ID = `operator-maintenance:v1:${DIGEST}`;

function input(stage: 'raw' | 'gate'): OperatorMaintenanceCheckInput {
  return {
    owner: 'review-yeti-ai', repo: 'sample', headSha: HEAD, expectedAppId: 4_385_771,
    name: stage === 'raw' ? 'Review Yeti' : 'Review Yeti Gate',
    externalId: `review-yeti-maintenance:v1:${DIGEST}:${stage}`,
    intentId: INTENT_ID, title: 'SHIP: operator passthrough; review bypassed',
    summary: [
      'review-mode=passthrough', 'review-completed=false', 'decision=SHIP',
      'reason=operator_global_passthrough', `intent-id=${INTENT_ID}`,
      `head-sha=${HEAD}`, `check-kind=${stage}`,
    ].join('\n'),
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

describe('GitHub operator maintenance check reconciliation', () => {
  it.each(['raw', 'gate'] as const)('completes the same exact %s check after a lost POST acknowledgement', async (stage) => {
    const expected = input(stage);
    const calls: { method: string; path: string; body?: any }[] = [];
    let check: any;
    let posted = false;
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = String(init?.method || 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: parsed.pathname + parsed.search, body });
      if (parsed.pathname.endsWith('/check-runs') && method === 'GET') {
        const matches = check && check.name === expected.name && check.head_sha === HEAD
          && check.external_id === expected.externalId ? [check] : [];
        return json({ total_count: matches.length, check_runs: matches });
      }
      if (parsed.pathname.endsWith('/check-runs') && method === 'POST') {
        if (posted) throw new Error('duplicate POST attempted');
        posted = true;
        check = { id: 991, ...body, app: { id: expected.expectedAppId }, status: 'in_progress', conclusion: null };
        return json({ message: 'unknown acknowledgement' }, 502);
      }
      if (parsed.pathname.endsWith('/check-runs/991') && method === 'GET') return json(check);
      if (parsed.pathname.endsWith('/check-runs/991') && method === 'PATCH') {
        check = { ...check, ...body, output: body.output, status: 'completed', conclusion: 'success' };
        return json(check);
      }
      throw new Error(`unexpected GitHub request: ${method} ${parsed.pathname}`);
    });
    const client = new GitHubInstallationClient({ token: 'ghs_maintenance_test_token', fetchImplementation,
      sleep: async () => undefined, random: () => 0 });

    const result = await client.publishOperatorMaintenanceCheck(expected);

    expect(result).toMatchObject({ id: 991, name: expected.name, appId: expected.expectedAppId,
      headSha: HEAD, externalId: expected.externalId, state: 'completed' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'PATCH')?.path).toContain('/check-runs/991');
    expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({
      status: 'completed', conclusion: 'success', output: { title: expected.title, summary: expected.summary },
    });
    expect(check.id).toBe(991);
    expect(check.external_id).toBe(expected.externalId);
    expect(check.output.summary).toBe(expected.summary);
  });

  it('publishes a distinct maintenance pair alongside existing failing review checks without changing them', async () => {
    const raw = input('raw');
    const gate = input('gate');
    const genuineRaw = { id: 992, name: raw.name, head_sha: HEAD,
      external_id: 'review-yeti:existing-run', app: { id: raw.expectedAppId },
      status: 'completed', conclusion: 'failure', output: { title: 'FIX_FIRST', summary: 'verified review' } };
    const genuineGate = { id: 993, name: gate.name, head_sha: HEAD,
      external_id: 'review-yeti-gate:existing-run', app: { id: gate.expectedAppId },
      status: 'completed', conclusion: 'failure', output: { title: 'FIX_FIRST', summary: 'verified review' } };
    const checks = [genuineRaw, genuineGate];
    const methods: string[] = [];
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = String(init?.method || 'GET').toUpperCase();
      methods.push(method);
      if (parsed.pathname.includes('/commits/') && parsed.pathname.endsWith('/check-runs') && method === 'GET') {
        return json({ total_count: checks.length, check_runs: checks });
      }
      if (parsed.pathname.endsWith('/check-runs') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        const created = { id: 994 + checks.length, ...body,
          app: { id: raw.expectedAppId }, status: 'completed', conclusion: 'success' };
        checks.push(created);
        return json(created);
      }
      throw new Error(`unexpected GitHub request: ${method}`);
    });
    const client = new GitHubInstallationClient({ token: 'ghs_maintenance_test_token', fetchImplementation });

    await client.publishOperatorMaintenanceCheck(raw);
    await client.publishOperatorMaintenanceCheck(gate);

    expect(checks).toHaveLength(4);
    expect(checks.slice(0, 2)).toEqual([genuineRaw, genuineGate]);
    expect(checks.slice(2).map((check) => check.external_id)).toEqual([raw.externalId, gate.externalId]);
    expect(methods.filter((method) => method === 'POST')).toHaveLength(2);
    expect(methods).not.toContain('PATCH');
  });
});
