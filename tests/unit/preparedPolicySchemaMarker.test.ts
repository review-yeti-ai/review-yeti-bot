import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';

const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' };

function prepare(schema: unknown) {
  const content = JSON.stringify({
    schema,
    review_yeti: { personas: 'security,testing', budget: { max_investigation_turns: 1 } },
  });
  return preparePublishingPolicy({
    content,
    source: {
      repositoryId: 987,
      repository: 'example-org/review-policies',
      sha: 'f'.repeat(40),
      path: 'policy/review.json',
      contentDigest: createHash('sha256').update(content).digest('hex'),
    },
  }, transport);
}

describe('central policy schema id is a version marker', () => {
  it.each(['review-yeti.review-policy.v1', 'example-org.review-policy.v1', 'a1.review-policy.v1'])(
    'accepts %s',
    (schema) => {
      expect(prepare(schema).version).toBe('PreparedPublishingPolicy.v1');
    },
  );

  it.each([
    '',
    'review-policy.v1',
    '.review-policy.v1',
    '-bad.review-policy.v1',
    'UPPER.review-policy.v1',
    'under_score.review-policy.v1',
    'example.review-policy.v2',
    'example.review-policy.v1.extra',
    'example/review-policy.v1',
    42,
    null,
  ])('rejects %j', (schema) => {
    expect(() => prepare(schema)).toThrow('Trusted publishing policy could not be prepared');
  });
});
