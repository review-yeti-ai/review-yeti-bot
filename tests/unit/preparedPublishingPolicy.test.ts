import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parsePreparedReviewExecution, preparePublishingPolicy, verifyPreparedPublishingConfig } from '../../src/review/preparedPublishingPolicy';
import { fingerprintEffectiveReviewConfig } from '../../src/review/authoritativeReviewIdentity';

const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' };
function file(raw: unknown = { schema: 'exampleorg.review-policy.v1', review_yeti: {
  personas: 'security,testing', budget: { max_investigation_turns: 20 }, api_key_env: 'PRIVATE_KEY_NAME_ONLY',
} }) {
  const content = JSON.stringify(raw);
  return { content, source: { repositoryId: 123, repository: 'example/policy', sha: 'a'.repeat(40),
    path: 'policy/review-yeti.json', contentDigest: createHash('sha256').update(content).digest('hex') } };
}

function policyWithReviewYeti(reviewYeti: unknown): Record<string, unknown> {
  const defaultPolicy = JSON.parse(file().content) as Record<string, unknown>;
  return { ...defaultPolicy, review_yeti: reviewYeti };
}

describe('trusted prepared publishing policy', () => {
  it('resolves the private DSH policy to its explicit composed fallback without changing the panel default', () => {
    const selected = preparePublishingPolicy(file({ schema: 'exampleorg.review-policy.v1', review_yeti: {
      personas: 'security,testing', budget: { max_investigation_turns: 20 },
      review_engine: 'dsh', fallback_review_engine: 'composed',
    } }), transport);
    expect(selected.config.review_engine).toBe('composed');
    expect(preparePublishingPolicy(file(), transport).config.review_engine).toBe('panel');
  });
  it('binds explicit severity-v2 activation to both effective config and policy digests', () => {
    const legacy = preparePublishingPolicy(file({ schema: 'exampleorg.review-policy.v1', review_yeti: {
      personas: 'security,testing', budget: { max_investigation_turns: 20 },
    } }), transport);
    const activated = preparePublishingPolicy(file({ schema: 'exampleorg.review-policy.v1', review_yeti: {
      personas: 'security,testing', budget: { max_investigation_turns: 20 },
      severity_policy: 'review-yeti-severity.v2',
    } }), transport);

    expect(activated.config.severity_policy).toBe('review-yeti-severity.v2');
    expect(activated.config.review_configuration_receipt?.effective.severity_policy).toBe('review-yeti-severity.v2');
    expect(activated.policy.effectiveConfigDigest).not.toBe(legacy.policy.effectiveConfigDigest);
    expect(activated.policy.effectivePolicyDigest).not.toBe(legacy.policy.effectivePolicyDigest);
    expect(verifyPreparedPublishingConfig(activated.config, activated.policy.effectiveConfigDigest, transport))
      .toEqual(activated.config);
  });
  it('selects severity v2 only for the service-trusted repository and keeps unrelated repositories legacy', () => {
    const source = file({ schema: 'exampleorg.review-policy.v1', review_yeti: {
      personas: 'security,testing', budget: { max_investigation_turns: 20 },
    }, repository_overrides: {
      'calltelemetry/ct-review-actions': { severity_policy: 'review-yeti-severity.v2' },
    } });
    const noTarget = preparePublishingPolicy(source, transport);
    const canary = preparePublishingPolicy(source, transport, { owner: 'calltelemetry', repo: 'ct-review-actions' });
    const unrelated = preparePublishingPolicy(source, transport, { owner: 'calltelemetry', repo: 'ct-meta' });

    expect(noTarget.config.severity_policy).toBeUndefined();
    expect(canary.config.severity_policy).toBe('review-yeti-severity.v2');
    expect(canary.config.review_configuration_receipt?.effective.severity_policy).toBe('review-yeti-severity.v2');
    expect(unrelated.config.severity_policy).toBeUndefined();
    expect(canary.policy.effectiveConfigDigest).not.toBe(unrelated.policy.effectiveConfigDigest);
    expect(canary.policy.effectivePolicyDigest).not.toBe(unrelated.policy.effectivePolicyDigest);
    expect(verifyPreparedPublishingConfig(canary.config, canary.policy.effectiveConfigDigest, transport))
      .toEqual(canary.config);
    const envelope = JSON.stringify({ version: 'PreparedReviewExecution.v1', config: canary.config, transport });
    const admitted = parsePreparedReviewExecution(envelope, canary.policy.effectiveConfigDigest, transport);
    expect(admitted.config.severity_policy).toBe('review-yeti-severity.v2');
    expect(admitted.config.review_configuration_receipt).toEqual(canary.config.review_configuration_receipt);
  });
  it('preserves the shared Bifrost resolver and binds normalized config independently of source credentials', () => {
    const prepared = preparePublishingPolicy(file(), transport);
    expect(prepared.expectedPersonaIds).toEqual(['sec-lane', 'qual-lane']);
    expect(prepared.config.default_max_turns).toBe(15);
    expect(prepared.config.reviewers.overall_timeout_s).toBe(1200);
    expect(prepared.config.reviewers.providers).toMatchObject([{
      id: 'bifrost', model: transport.model, review_timeout_s: 180, arbiter_timeout_s: 180,
    }]);
    expect(JSON.stringify(prepared)).not.toContain('PRIVATE_KEY_NAME_ONLY');
    expect(verifyPreparedPublishingConfig(prepared.config, prepared.policy.effectiveConfigDigest, transport)).toEqual(prepared.config);
  });
  it('keeps the old normalized config/hash shape unless central policy explicitly admits a larger cap', () => {
    const priorShape = preparePublishingPolicy(file(), transport);
    expect(Object.hasOwn(priorShape.config, 'max_reviewed_lockfile_patch_chars')).toBe(false);
    const oldEffectiveDigest = fingerprintEffectiveReviewConfig({ config: priorShape.config, transport });
    const legacyEnvelope = JSON.stringify({
      version: 'PreparedReviewExecution.v1', config: priorShape.config, transport,
    });
    const verifiedLegacy = parsePreparedReviewExecution(legacyEnvelope, oldEffectiveDigest, transport);
    expect(Object.hasOwn(verifiedLegacy.config, 'max_reviewed_lockfile_patch_chars')).toBe(false);

    const capped = preparePublishingPolicy(file(policyWithReviewYeti({
      personas: 'security,testing', budget: { max_investigation_turns: 20, max_reviewed_lockfile_patch_chars: 65_536 },
    })), transport);
    expect(capped.config.max_reviewed_lockfile_patch_chars).toBe(65_536);
    expect(capped.policy.effectiveConfigDigest).not.toBe(oldEffectiveDigest);
    expect(verifyPreparedPublishingConfig(capped.config, capped.policy.effectiveConfigDigest, transport))
      .toEqual(capped.config);
  });
  it('preserves existing central lane-budget keys while validating the named lockfile cap', () => {
    const prepared = preparePublishingPolicy(file(policyWithReviewYeti({
      personas: 'security,testing',
      budget: {
        max_investigation_turns: 20,
        lane_deadline_ms: 30_000,
        lane_overhead_ms: 2_000,
        lane_call_budget: 4,
        max_review_assignments: 8,
        max_reviewed_lockfile_patch_chars: 56_544,
      },
    })), transport);
    expect(prepared.config.max_reviewed_lockfile_patch_chars).toBe(56_544);
    expect(JSON.stringify(prepared.config)).not.toMatch(/lane_deadline_ms|lane_overhead_ms|lane_call_budget|max_review_assignments/u);
  });
  it('rejects a file paired with a different source digest', () => {
    const input = file(); input.source.contentDigest = 'b'.repeat(64);
    expect(() => preparePublishingPolicy(input, transport)).toThrow('Trusted publishing policy could not be prepared');
  });
  it.each([
    {},
    { schema: 'unknown' },
    { schema: 'exampleorg.review-policy.v1', review_yeti: { personas: 'security', budget: { max_investigation_turns: 0 } } },
    { schema: 'exampleorg.review-policy.v1', review_yeti: { personas: 'security', budget: { max_investigation_turns: 5 } },
      repository_overrides: { 'calltelemetry/ct-review-actions': { severity_policy: 'not-v2' } } },
    policyWithReviewYeti({ personas: 'security', budget: { max_investigation_turns: 5, max_reviewed_lockfile_patch_chars: 19_999 } }),
    policyWithReviewYeti({ personas: 'security', budget: { max_investigation_turns: 5, max_reviewed_lockfile_patch_chars: 65_537 } }),
    policyWithReviewYeti({ personas: 'security', budget: { max_investigation_turns: 5, max_reviewed_lockfile_patch_chars: '65536' } }),
  ])
    ('rejects malformed central policy without echoing it', (raw) => {
      expect(() => preparePublishingPolicy(file(raw), transport)).toThrow('Trusted publishing policy could not be prepared');
    });
  it('rejects duplicate canonical persona identities', () => {
    const input = file({ schema: 'exampleorg.review-policy.v1', review_yeti: {
      personas: 'security,sec-lane', budget: { max_investigation_turns: 20 },
    } });
    expect(() => preparePublishingPolicy(input, transport)).toThrow();
  });
  it('rejects a different digest or operator model before review', () => {
    const prepared = preparePublishingPolicy(file(), transport);
    expect(() => verifyPreparedPublishingConfig(prepared.config, 'b'.repeat(64), transport)).toThrow();
    expect(() => verifyPreparedPublishingConfig(prepared.config, prepared.policy.effectiveConfigDigest,
      { ...transport, model: 'different-model' })).toThrow();
    expect(() => verifyPreparedPublishingConfig(prepared.config, prepared.policy.effectiveConfigDigest,
      { ...transport, baseUrl: 'https://other-gateway.example.invalid/v1' })).toThrow();
  });
  it.each(['http://gateway.example.invalid', 'https://user:credential@gateway.example.invalid', 'https://gateway.example.invalid/?token=credential'])
    ('rejects unsafe transport %s', (baseUrl) => {
      expect(() => preparePublishingPolicy(file(), { ...transport, baseUrl })).toThrow('Trusted publishing policy could not be prepared');
    });
});

describe('prepared execution envelope', () => {
  function fixture() {
    const prepared = preparePublishingPolicy(file(), transport);
    const envelope = { version: 'PreparedReviewExecution.v1', config: prepared.config, transport };
    const digest = prepared.policy.effectiveConfigDigest;
    return { prepared, envelope, digest };
  }
  const error = 'Prepared review execution does not match its admitted identity';

  it('returns the admitted config and transport only after verifying the actual transport', () => {
    const f = fixture();
    expect(parsePreparedReviewExecution(JSON.stringify(f.envelope), f.digest, transport)).toEqual(f.envelope);
  });

  it.each([
    'extra envelope field', 'wrong version', 'missing version', 'missing config', 'missing transport',
    'extra transport field', 'query', 'fragment', 'userinfo', 'plaintext', 'model control character',
  ])('rejects %s with otherwise valid configuration and a redacted error', (variant) => {
    const f = fixture();
    const raw: Record<string, unknown> = { ...f.envelope };
    if (variant === 'extra envelope field') raw.token = 'private-envelope-token';
    if (variant === 'wrong version') raw.version = 'PreparedReviewExecution.v2';
    if (variant === 'missing version') delete raw.version;
    if (variant === 'missing config') delete raw.config;
    if (variant === 'missing transport') delete raw.transport;
    if (variant === 'extra transport field') raw.transport = { ...transport, apiKey: 'private-envelope-token' };
    if (variant === 'query') raw.transport = { ...transport, baseUrl: `${transport.baseUrl}?token=private-envelope-token` };
    if (variant === 'fragment') raw.transport = { ...transport, baseUrl: `${transport.baseUrl}#private-envelope-token` };
    if (variant === 'userinfo') raw.transport = { ...transport, baseUrl: 'https://user:private-envelope-token@gateway.example.invalid/v1' };
    if (variant === 'plaintext') raw.transport = { ...transport, baseUrl: 'http://gateway.example.invalid/v1' };
    if (variant === 'model control character') raw.transport = { ...transport, model: 'private-envelope-token\n' };
    expect(() => parsePreparedReviewExecution(JSON.stringify(raw), f.digest, transport)).toThrow(new Error(error));
  });

  it.each(['', '{private-envelope-token', 'null', '[]', '"private-envelope-token"'])('rejects malformed or non-envelope JSON: %s', (json) => {
    const f = fixture();
    expect(() => parsePreparedReviewExecution(json, f.digest, transport)).toThrow(new Error(error));
  });

  it.each(['actual URL', 'actual model', 'stored URL', 'stored model', 'config', 'digest'])('binds %s independently of valid surrounding inputs', (variant) => {
    const f = fixture();
    const envelope = structuredClone(f.envelope);
    const actual = { ...transport };
    let digest = f.digest;
    if (variant === 'actual URL') actual.baseUrl = 'https://other.example.invalid/v1';
    if (variant === 'actual model') actual.model = 'other-model';
    if (variant === 'stored URL') envelope.transport.baseUrl = 'https://other.example.invalid/v1';
    if (variant === 'stored model') envelope.transport.model = 'other-model';
    if (variant === 'config') envelope.config.default_max_turns = 1;
    if (variant === 'digest') digest = 'b'.repeat(64);
    expect(() => parsePreparedReviewExecution(JSON.stringify(envelope), digest, actual)).toThrow(new Error(error));
  });

  it('accepts exactly 256 KiB but rejects one extra byte of otherwise valid JSON', () => {
    const f = fixture();
    const json = JSON.stringify(f.envelope);
    const exact = json + ' '.repeat(256 * 1024 - Buffer.byteLength(json, 'utf8'));
    expect(Buffer.byteLength(exact, 'utf8')).toBe(256 * 1024);
    expect(parsePreparedReviewExecution(exact, f.digest, transport)).toEqual(f.envelope);
    expect(() => parsePreparedReviewExecution(`${exact} `, f.digest, transport)).toThrow(new Error(error));
  });

  it('bounds UTF-8 bytes rather than JavaScript character count', () => {
    const f = fixture();
    const config = structuredClone(f.prepared.config);
    config.personas[0].charter = '🦊'.repeat(10_000);
    const digest = fingerprintEffectiveReviewConfig({ config, transport });
    // Independently prove the config and digest are valid: only the serialized
    // envelope's byte bound should reject this input.
    expect(verifyPreparedPublishingConfig(config, digest, transport)).toEqual(config);
    const compact = JSON.stringify({ ...f.envelope, config });
    const json = compact + ' '.repeat(256 * 1024 + 1 - Buffer.byteLength(compact, 'utf8'));
    expect(json.length).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(256 * 1024);
    expect(() => parsePreparedReviewExecution(json, digest, transport)).toThrow(new Error(error));
  });
});
