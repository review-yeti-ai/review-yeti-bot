import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const profileModule = require(path.join(root, '.github/workflows/pipelines/execution-profile.js'));
const switchModule = require(path.join(root, '.github/workflows/pipelines/execution-profile-switch.js'));

const profiles = profileModule.getExecutionProfiles();
const context = {
  repository: 'review-yeti-ai/review-yeti-bot',
  pr_number: '254',
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    operation: 'prepare',
    profile_id: 'fireworks-breakglass',
    profile_digest: profiles['fireworks-breakglass'].profile_digest,
    repository: context.repository,
    pr_number: context.pr_number,
    base_sha: context.base_sha,
    head_sha: context.head_sha,
    previous_profile_id: 'openrouter-primary',
    previous_profile_digest: profiles['openrouter-primary'].profile_digest,
    requested_by: 'operator@example.invalid',
    reason: 'bounded recovery qualification',
    ...overrides,
  };
}

function encoded(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('manual exact-head execution-profile switch contract', () => {
  it('normalizes a valid prepare request without activating a provider', () => {
    const result = switchModule.validateManualProfileSwitchRequest(encoded(request()), context);
    expect(result).toMatchObject({
      operation: 'prepare',
      profile_id: 'fireworks-breakglass',
      previous_profile_id: 'openrouter-primary',
      repository: context.repository,
      pr_number: context.pr_number,
      base_sha: context.base_sha,
      head_sha: context.head_sha,
      transport_plan_digest: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('allows an exact transport-plan digest while retaining the same binding', () => {
    const digest = 'c'.repeat(64);
    expect(switchModule.validateManualProfileSwitchRequest(encoded(request({ transport_plan_digest: digest })), context))
      .toMatchObject({ transport_plan_digest: digest });
  });

  it('requires activation to target an already active immutable profile', () => {
    expect(() => switchModule.validateManualProfileSwitchRequest(
      encoded(request({ operation: 'activate' })),
      context,
    )).toThrow(/inactive profile/i);
  });

  it('requires the rollback source to be the active immutable profile', () => {
    expect(() => switchModule.validateManualProfileSwitchRequest(encoded(request({
      previous_profile_id: 'ollama-evaluation',
      previous_profile_digest: profiles['ollama-evaluation'].profile_digest,
    })), context)).toThrow(/previous profile.*not active/i);
  });

  it.each([
    ['repository', { repository: 'other/repository' }, /repository.*match/i],
    ['pr', { pr_number: '255' }, /pr_number.*match/i],
    ['base', { base_sha: 'c'.repeat(40) }, /base_sha.*match/i],
    ['head', { head_sha: 'd'.repeat(40) }, /head_sha.*match/i],
    ['profile digest', { profile_digest: 'e'.repeat(64) }, /profile_digest.*immutable/i],
    ['previous digest', { previous_profile_digest: 'f'.repeat(64) }, /previous_profile_digest.*immutable/i],
  ])('rejects a mismatched exact binding: %s', (_label, overrides, pattern) => {
    expect(() => switchModule.validateManualProfileSwitchRequest(encoded(request(overrides)), context)).toThrow(pattern);
  });

  it('rejects non-canonical or same-profile requests', () => {
    expect(() => switchModule.validateManualProfileSwitchRequest(encoded(request({ profile_id: 'unknown' })), context))
      .toThrow(/one of|allowlisted/i);
    expect(() => switchModule.validateManualProfileSwitchRequest(encoded(request({
      profile_id: 'openrouter-primary',
      profile_digest: profiles['openrouter-primary'].profile_digest,
      previous_profile_id: 'openrouter-primary',
    })), context)).toThrow(/must change/i);
  });

  it('rejects malformed, oversized, unknown-key, and secret-shaped input', () => {
    expect(switchModule.validateManualProfileSwitchRequest('', context)).toBeNull();
    expect(() => switchModule.validateManualProfileSwitchRequest('not-base64', context)).toThrow(/base64/i);
    expect(() => switchModule.validateManualProfileSwitchRequest('!!!!', context)).toThrow(/base64/i);
    expect(() => switchModule.validateManualProfileSwitchRequest('=', context)).toThrow(/empty or too large/i);
    expect(() => switchModule.validateManualProfileSwitchRequest(encoded({ ...request(), unexpected: true }), context)).toThrow(/unknown/i);
    expect(() => switchModule.validateManualProfileSwitchRequest(encoded({ ...request(), reason: 'Bearer secret-value' }), context)).toThrow(/credential-shaped/i);
    expect(() => switchModule.validateManualProfileSwitchRequest(encoded({ ...request(), profile_digest: 'short' }), context)).toThrow(/64-character/i);
    expect(() => switchModule.validateManualProfileSwitchRequest(
      encoded({ ...request(), reason: 'x'.repeat(switchModule.MAX_REQUEST_BYTES) }),
      context,
    )).toThrow(/too large/i);
  });

  it('requires exact forty-character commit digests', () => {
    expect(() => switchModule.validateManualProfileSwitchRequest(encoded(request({ head_sha: 'exact-head' })), context))
      .toThrow(/40.*hexadecimal/i);
  });
});
