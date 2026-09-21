import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { OPENCODE_LANE_TIMEOUT_S } from '../../src/config/configLoader';

/**
 * These two invariants fail silently and expensively, and both were introduced as untestable
 * branching inside workflow YAML. Extracted to a script so the suite can reach them.
 */
const SCRIPT = path.resolve(__dirname, '../../scripts/assert-review-transport-config.sh');

function run(env: Record<string, string>): { ok: boolean; out: string } {
  try {
    const out = execFileSync(SCRIPT, { encoding: 'utf8', env: { ...process.env, ...env } });
    return { ok: true, out };
  } catch (error: any) {
    return { ok: false, out: String(error.stderr || error.stdout || error.message) };
  }
}

const OPENCODE = 'https://opencode.ai/zen/v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';

/**
 * The third destination is pinned by digest, not hostname, because this repository is public.
 * These tests must not hardcode the hostname either -- so they drive the guard with a destination
 * synthesised from the SAME pin the guard uses, overriding it to a value the tests do own.
 */
const TEST_GATEWAY = 'https://gateway.test.invalid/v1';
const TEST_GATEWAY_SHA256 = createHash('sha256').update(TEST_GATEWAY).digest('hex');
const gatewayEnv = (extra: Record<string, string> = {}) => ({
  REVIEW_BASE_URL: TEST_GATEWAY,
  GATEWAY_BASE_URL_SHA256: TEST_GATEWAY_SHA256,
  ...extra,
});

describe('review transport configuration guard', () => {
  it('accepts a fully consistent opencode configuration', () => {
    expect(run({ REVIEW_BASE_URL: OPENCODE, OPENCODE_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '420000' }).ok).toBe(true);
  });

  // The leak this exists to stop: the workflow's key-selection expression falls through to the
  // OpenRouter credential on an empty opencode secret, because Actions `||` treats '' as falsy.
  it('refuses to run opencode without its own key rather than falling back', () => {
    const r = run({ REVIEW_BASE_URL: OPENCODE, OPENCODE_KEY_PRESENT: 'false', OPENROUTER_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '420000' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/CT_REVIEW_OPENCODE_API_KEY is unset/);
  });

  // Does NOT hold by default: the outer default is 90s and the opencode budget is 300s, so the
  // opencode destination requires the variable. A requirement living only in a repo variable is
  // invisible until reviews start failing.
  it('requires an explicit lane timeout for opencode', () => {
    const r = run({ REVIEW_BASE_URL: OPENCODE, OPENCODE_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/REVIEW_LANE_TIMEOUT_MS is unset/);
  });

  it('rejects a lane timeout tighter than the provider budget', () => {
    const r = run({ REVIEW_BASE_URL: OPENCODE, OPENCODE_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '90000' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/tighter than the opencode provider budget/);
  });

  it('accepts OpenRouter with its own key and needs no lane timeout', () => {
    expect(run({ REVIEW_BASE_URL: OPENROUTER, OPENROUTER_KEY_PRESENT: 'true' }).ok).toBe(true);
  });

  // Both destinations must fail closed on a missing key, not just opencode. Only the accept path
  // was covered here, which would have let the OpenRouter branch rot into a no-op unnoticed.
  it('refuses OpenRouter without its own key', () => {
    const r = run({ REVIEW_BASE_URL: OPENROUTER, OPENROUTER_KEY_PRESENT: 'false', OPENCODE_KEY_PRESENT: 'true' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/CT_REVIEW_OPENROUTER_API_KEY is unset/);
  });

  it('rejects a destination with no credential rule rather than defaulting', () => {
    const r = run({ REVIEW_BASE_URL: 'https://evil.example/v1', OPENCODE_KEY_PRESENT: 'true', OPENROUTER_KEY_PRESENT: 'true' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/no matching role-scoped credential rule/);
  });

  // The guard's minimum is a shell default and the budget is a TypeScript constant; a shell
  // script cannot import TS, so the value is necessarily duplicated. What must not be duplicated
  // is the DECISION -- this ties them together so the two cannot drift apart silently, which is
  // the whole failure mode. Change OPENCODE_LANE_TIMEOUT_S without the script and this goes red.
  it('the guard default matches the TypeScript provider budget', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const match = source.match(/OPENCODE_MIN_LANE_TIMEOUT_MS:-(\d+)/);
    expect(match, 'guard must declare a default minimum').toBeTruthy();
    expect(Number(match![1])).toBe(OPENCODE_LANE_TIMEOUT_S * 1000);
  });

  // --- digest-pinned gateway destination ---------------------------------------------------

  it('accepts a consistent digest-pinned gateway configuration', () => {
    const r = run(gatewayEnv({ GATEWAY_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '420000' }));
    expect(r.ok).toBe(true);
    expect(r.out).toMatch(/digest-pinned gateway destination/);
  });

  it('normalizes a trailing slash before matching the pinned digest', () => {
    const r = run(gatewayEnv({ REVIEW_BASE_URL: `${TEST_GATEWAY}/`, GATEWAY_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '420000' }));
    expect(r.ok).toBe(true);
  });

  // Same leak as the opencode case: with the gateway secret empty, the workflow's key-selection
  // expression falls through to another provider's credential and transmits it to the gateway.
  it('refuses the gateway without its own key rather than falling back', () => {
    const r = run(gatewayEnv({ GATEWAY_KEY_PRESENT: 'false', OPENROUTER_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '420000' }));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/CT_REVIEW_GATEWAY_API_KEY is unset/);
  });

  it('requires an explicit lane timeout for the gateway', () => {
    const r = run(gatewayEnv({ GATEWAY_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '' }));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/REVIEW_LANE_TIMEOUT_MS is unset/);
  });

  it('rejects a lane timeout tighter than the gateway budget', () => {
    const r = run(gatewayEnv({ GATEWAY_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '90000' }));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/tighter than the digest-pinned gateway provider budget/);
  });

  // A near-miss of the pinned URL must fall to the catch-all, not be waved through.
  it('rejects a destination that merely resembles the pinned one', () => {
    const r = run(gatewayEnv({ REVIEW_BASE_URL: 'https://gateway.test.invalid/v2', GATEWAY_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '420000' }));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/no matching role-scoped credential rule/);
  });

  // This repository's workflow logs are public, and the likeliest unrecognised destination is a
  // typo of a first-party hostname. The guard must report the digest, never the URL.
  it('never echoes an unrecognised destination back into the log', () => {
    const secretish = 'https://internal-host.example.com/v1';
    const r = run({ REVIEW_BASE_URL: secretish });
    expect(r.ok).toBe(false);
    expect(r.out).not.toContain(secretish);
    expect(r.out).not.toContain('internal-host');
    expect(r.out).toContain(createHash('sha256').update(secretish).digest('hex'));
  });

  // The guard and the policy module each carry the pin. If they drift, the workflow admits a
  // destination the policy rejects (or the reverse) and the failure surfaces only in production.
  it('pins the same gateway digest as the review policy module', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    const policy = fs.readFileSync(
      path.resolve(__dirname, '../../.github/workflows/pipelines/openrouter-policy.js'),
      'utf8',
    );
    const inScript = script.match(/GATEWAY_BASE_URL_SHA256:-([0-9a-f]{64})/)?.[1];
    const inPolicy = [...policy.matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]);
    expect(inScript).toMatch(/^[0-9a-f]{64}$/);
    expect(inPolicy).toContain(inScript);
  });

  // --- destination class emitted for the workflow's credential selection -----------------------

  /**
   * The workflow picks the credential from this output. The binding used to be prose only -- the
   * selector identified the gateway by elimination, which held while those were the only
   * destinations and would have handed the gateway credential to any fourth one admitted later.
   * These assert the contract the selector actually consumes.
   */
  function destinationOf(env: Record<string, string>): { ok: boolean; destination: string } {
    const outPath = path.join(os.tmpdir(), `gh-output-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(outPath, '');
    try {
      const r = run({ ...env, GITHUB_OUTPUT: outPath });
      const written = fs.readFileSync(outPath, 'utf8');
      return { ok: r.ok, destination: written.match(/^destination=(.*)$/m)?.[1] ?? '' };
    } finally {
      fs.rmSync(outPath, { force: true });
    }
  }

  it.each([
    ['opencode', { REVIEW_BASE_URL: OPENCODE, OPENCODE_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '420000' }],
    ['openrouter', { REVIEW_BASE_URL: OPENROUTER, OPENROUTER_KEY_PRESENT: 'true' }],
    ['gateway', gatewayEnv({ GATEWAY_KEY_PRESENT: 'true', REVIEW_LANE_TIMEOUT_MS: '420000' })],
  ])('emits the %s destination class for the credential selector', (expected, env) => {
    const r = destinationOf(env as Record<string, string>);
    expect(r.ok).toBe(true);
    expect(r.destination).toBe(expected);
  });

  // The selector has no catch-all arm, so an empty class yields an empty key rather than another
  // provider's credential. A rejected destination must therefore emit nothing at all.
  it('emits no destination class when the configuration is rejected', () => {
    const r = destinationOf({ REVIEW_BASE_URL: 'https://evil.example/v1' });
    expect(r.ok).toBe(false);
    expect(r.destination).toBe('');
  });

  // Each class must map to exactly one credential in the workflow, and no arm may be a catch-all.
  it('maps every emitted class to its own credential in the workflow', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../../.github/workflows/review-bot.yaml'),
      'utf8',
    );
    const selector = workflow.match(/llm-api-key: >-\n([\s\S]*?)\n\s{10}[a-z#]/)?.[1] ?? '';
    expect(selector).toContain("outputs.destination == 'opencode' && secrets.CT_REVIEW_OPENCODE_API_KEY");
    expect(selector).toContain("outputs.destination == 'gateway' && secrets.CT_REVIEW_GATEWAY_API_KEY");
    expect(selector).toContain("outputs.destination == 'openrouter' && secrets.CT_REVIEW_OPENROUTER_API_KEY");
    // No bare trailing `|| secrets.X` arm: that is the elimination fallback this replaced.
    expect(selector).not.toMatch(/\|\|\s*secrets\.[A-Z_]+\s*\}\}/);
  });
});