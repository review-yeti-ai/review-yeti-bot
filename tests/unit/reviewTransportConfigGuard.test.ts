import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

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

  it('rejects a destination with no credential rule rather than defaulting', () => {
    const r = run({ REVIEW_BASE_URL: 'https://evil.example/v1', OPENCODE_KEY_PRESENT: 'true', OPENROUTER_KEY_PRESENT: 'true' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/no matching role-scoped credential rule/);
  });
});
