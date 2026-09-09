import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { preparePublishingPolicy, verifyPreparedPublishingConfig } from '../../src/review/preparedPublishingPolicy';

const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' };
function file(raw: unknown = { schema: 'calltelemetry.review-policy.v1', review_yeti: {
  personas: 'security,testing', budget: { max_investigation_turns: 20 }, api_key_env: 'PRIVATE_KEY_NAME_ONLY',
} }) {
  const content = JSON.stringify(raw);
  return { content, source: { repositoryId: 123, repository: 'example/policy', sha: 'a'.repeat(40),
    path: 'policy/review-yeti.json', contentDigest: createHash('sha256').update(content).digest('hex') } };
}

describe('trusted prepared publishing policy', () => {
  it('preserves the shared Bifrost resolver and binds normalized config independently of source credentials', () => {
    const prepared = preparePublishingPolicy(file(), transport);
    expect(prepared.expectedPersonaIds).toEqual(['sec-lane', 'qual-lane']);
    expect(prepared.config.default_max_turns).toBe(3);
    expect(prepared.config.reviewers.providers).toMatchObject([{ id: 'bifrost', model: transport.model }]);
    expect(JSON.stringify(prepared)).not.toContain('PRIVATE_KEY_NAME_ONLY');
    expect(verifyPreparedPublishingConfig(prepared.config, prepared.policy.effectiveConfigDigest, transport)).toEqual(prepared.config);
  });
  it('rejects a file paired with a different source digest', () => {
    const input = file(); input.source.contentDigest = 'b'.repeat(64);
    expect(() => preparePublishingPolicy(input, transport)).toThrow('Trusted publishing policy could not be prepared');
  });
  it.each([{}, { schema: 'unknown' }, { schema: 'calltelemetry.review-policy.v1', review_yeti: { personas: 'security', budget: { max_investigation_turns: 0 } } }])
    ('rejects malformed central policy without echoing it', (raw) => {
      expect(() => preparePublishingPolicy(file(raw), transport)).toThrow('Trusted publishing policy could not be prepared');
    });
  it('rejects duplicate canonical persona identities', () => {
    const input = file({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
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
