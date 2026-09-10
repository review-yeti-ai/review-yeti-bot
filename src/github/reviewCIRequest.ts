export const SCHEMA_VERSION_CI_REQUEST = 'review-yeti-ci-request.v1' as const;
export const EVENT_TYPE_CI_REQUEST = 'review-yeti-ci-request' as const;

export interface ReviewCIRequestPayload {
  schema_version: typeof SCHEMA_VERSION_CI_REQUEST;
  repository_id: number;
  repository: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  attempt_id: string;
  policy_digest: string;
  validation_request_id: string;
}

export const ALLOWED_PAYLOAD_FIELDS = new Set([
  'schema_version',
  'repository_id',
  'repository',
  'pr_number',
  'base_sha',
  'head_sha',
  'attempt_id',
  'policy_digest',
  'validation_request_id',
]);

const SHA_REGEX = /^[0-9a-f]{40}$/;
const POLICY_DIGEST_REGEX = /^sha256:[0-9a-f]{64}$/;
const REPO_REGEX = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const IDENTIFIER_REGEX = /^[a-zA-Z0-9_.:-]{1,128}$/;

export function validateReviewCIRequestPayload(payload: unknown): {
  valid: true;
  value: ReviewCIRequestPayload;
} | {
  valid: false;
  error: string;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, error: 'Payload must be a non-null object' };
  }
  const obj = payload as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_PAYLOAD_FIELDS.has(key)) {
      return { valid: false, error: `Disallowed extraneous field in coordinate payload: ${key}` };
    }
  }

  for (const field of ALLOWED_PAYLOAD_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  if (obj.schema_version !== SCHEMA_VERSION_CI_REQUEST) {
    return {
      valid: false,
      error: `Unsupported schema_version: ${obj.schema_version} (expected ${SCHEMA_VERSION_CI_REQUEST})`,
    };
  }

  if (typeof obj.repository_id !== 'number' || !Number.isInteger(obj.repository_id) || obj.repository_id <= 0) {
    return { valid: false, error: 'repository_id must be a positive integer' };
  }

  if (typeof obj.repository !== 'string' || !REPO_REGEX.test(obj.repository)) {
    return { valid: false, error: `Invalid repository coordinate: ${obj.repository}` };
  }

  if (typeof obj.pr_number !== 'number' || !Number.isInteger(obj.pr_number) || obj.pr_number <= 0) {
    return { valid: false, error: 'pr_number must be a positive integer' };
  }

  if (typeof obj.base_sha !== 'string' || !SHA_REGEX.test(obj.base_sha)) {
    return { valid: false, error: `base_sha must be a 40-character lowercase hex string: ${obj.base_sha}` };
  }

  if (typeof obj.head_sha !== 'string' || !SHA_REGEX.test(obj.head_sha)) {
    return { valid: false, error: `head_sha must be a 40-character lowercase hex string: ${obj.head_sha}` };
  }

  if (typeof obj.attempt_id !== 'string' || obj.attempt_id.trim().length === 0) {
    return { valid: false, error: 'attempt_id must be a non-empty string' };
  }

  if (typeof obj.policy_digest !== 'string' || !POLICY_DIGEST_REGEX.test(obj.policy_digest)) {
    return { valid: false, error: `policy_digest must match sha256:[0-9a-f]{64}: ${obj.policy_digest}` };
  }

  if (typeof obj.validation_request_id !== 'string' || obj.validation_request_id.trim().length === 0) {
    return { valid: false, error: 'validation_request_id must be a non-empty string' };
  }

  if (!IDENTIFIER_REGEX.test(obj.attempt_id) || !IDENTIFIER_REGEX.test(obj.validation_request_id)) {
    return { valid: false, error: 'Security violation: shell metacharacters detected in identifiers' };
  }

  return {
    valid: true,
    value: obj as unknown as ReviewCIRequestPayload,
  };
}
