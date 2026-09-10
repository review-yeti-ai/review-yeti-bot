import { describe, expect, it } from 'vitest';
import {
  validateReviewCIRequestPayload,
  SCHEMA_VERSION_CI_REQUEST,
  EVENT_TYPE_CI_REQUEST,
  ReviewCIRequestPayload,
} from '../../src/github/reviewCIRequest';

describe('reviewCIRequest contract validation', () => {
  const validPayload: ReviewCIRequestPayload = {
    schema_version: SCHEMA_VERSION_CI_REQUEST,
    repository_id: 12345678,
    repository: 'calltelemetry/dashboard',
    pr_number: 100,
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    attempt_id: 'review-attempt-100-1',
    policy_digest: `sha256:${'c'.repeat(64)}`,
    validation_request_id: 'validation-100-1',
  };

  it('exports correct schema version and event type constants', () => {
    expect(SCHEMA_VERSION_CI_REQUEST).toBe('review-yeti-ci-request.v1');
    expect(EVENT_TYPE_CI_REQUEST).toBe('review-yeti-ci-request');
  });

  it('accepts a strictly conforming 9-field coordinate payload', () => {
    const result = validateReviewCIRequestPayload(validPayload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual(validPayload);
    }
  });

  it('rejects null, non-objects, or arrays', () => {
    expect(validateReviewCIRequestPayload(null).valid).toBe(false);
    expect(validateReviewCIRequestPayload(undefined).valid).toBe(false);
    expect(validateReviewCIRequestPayload('not an object').valid).toBe(false);
    expect(validateReviewCIRequestPayload([validPayload]).valid).toBe(false);
  });

  it('rejects disallowed extraneous fields', () => {
    const extraneous = { ...validPayload, unexpected_extra_field: 'malicious' };
    const result = validateReviewCIRequestPayload(extraneous);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Disallowed extraneous field in coordinate payload: unexpected_extra_field');
    }
  });

  it('rejects missing required fields', () => {
    for (const key of Object.keys(validPayload) as Array<keyof ReviewCIRequestPayload>) {
      const missing = { ...validPayload };
      delete (missing as any)[key];
      const result = validateReviewCIRequestPayload(missing);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain(`Missing required field: ${key}`);
      }
    }
  });

  it('rejects unsupported schema version', () => {
    const invalid = { ...validPayload, schema_version: 'review-yeti-ci-request.v2' };
    const result = validateReviewCIRequestPayload(invalid);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Unsupported schema_version');
    }
  });

  it('rejects invalid repository_id or pr_number', () => {
    expect(validateReviewCIRequestPayload({ ...validPayload, repository_id: -1 }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, repository_id: 0 }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, repository_id: 1.5 }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, pr_number: -5 }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, pr_number: 0 }).valid).toBe(false);
  });

  it('rejects invalid repository coordinate formats', () => {
    expect(validateReviewCIRequestPayload({ ...validPayload, repository: 'invalid' }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, repository: 'invalid/repo/sub' }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, repository: 'invalid repo' }).valid).toBe(false);
  });

  it('rejects non-40 hex or uppercase base_sha and head_sha', () => {
    expect(validateReviewCIRequestPayload({ ...validPayload, base_sha: 'A'.repeat(40) }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, base_sha: 'a'.repeat(39) }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, head_sha: 'z'.repeat(40) }).valid).toBe(false);
  });

  it('rejects invalid policy_digest format', () => {
    expect(validateReviewCIRequestPayload({ ...validPayload, policy_digest: 'c'.repeat(64) }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, policy_digest: `sha512:${'c'.repeat(128)}` }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, policy_digest: `sha256:${'C'.repeat(64)}` }).valid).toBe(false);
  });

  it('rejects shell metacharacters in identifiers', () => {
    const maliciousChars = [';', '&', '|', '`', '$', '<', '>', '\\', '\n', '\r', '"', '\'', ' ', '(', ')', '{', '}', '*'];
    for (const char of maliciousChars) {
      const payloadWithAttempt = { ...validPayload, attempt_id: `run${char}inject` };
      expect(validateReviewCIRequestPayload(payloadWithAttempt).valid).toBe(false);

      const payloadWithValReq = { ...validPayload, validation_request_id: `val${char}inject` };
      expect(validateReviewCIRequestPayload(payloadWithValReq).valid).toBe(false);
    }
  });

  it('rejects multiline, quote injection, and length > 128 chars in identifiers', () => {
    expect(validateReviewCIRequestPayload({ ...validPayload, attempt_id: "attempt-1\nINJECTED_ENV=pwned\n" }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, validation_request_id: 'val-"quote-injection"-1' }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, attempt_id: 'a'.repeat(129) }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, validation_request_id: 'v'.repeat(129) }).valid).toBe(false);
    expect(validateReviewCIRequestPayload({ ...validPayload, attempt_id: 'valid-identifier_123.456:789' }).valid).toBe(true);
  });
});
