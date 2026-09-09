import { z } from 'zod';
import { ctReviewConfigV3Schema } from '../config/schema';
import { reviewPolicySourceSchema } from '../review/authoritativeReviewIdentity';
import { verifyPreparedPublishingConfig, type PreparedPublishingPolicy } from '../review/preparedPublishingPolicy';
import { canonicalJson, sha256 } from '../review/reviewCore';

/** Additive only: the caller installs this schema and owns admission wiring. */
export const PREPARED_REVIEW_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS prepared_review_policies (
    effective_policy_digest VARCHAR(64) PRIMARY KEY CHECK (effective_policy_digest ~ '^[a-f0-9]{64}$'),
    version TEXT NOT NULL CHECK (version = 'PreparedPublishingPolicy.v1'),
    effective_config_digest VARCHAR(64) NOT NULL CHECK (effective_config_digest ~ '^[a-f0-9]{64}$'),
    config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
    transport JSONB NOT NULL CHECK (jsonb_typeof(transport) = 'object'),
    sources JSONB NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
    expected_persona_ids JSONB NOT NULL CHECK (jsonb_typeof(expected_persona_ids) = 'array'),
    prepared_content_digest VARCHAR(64) NOT NULL CHECK (prepared_content_digest ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

export interface PreparedReviewQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** UTF-8 bytes of the serialized prepared object, including source metadata. */
export const MAX_PREPARED_REVIEW_BYTES = 256 * 1024;
const MAX_JSON_NODES = 16_384;
const MAX_JSON_DEPTH = 32;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const personaIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u);
const preparedSchema = z.object({
  version: z.literal('PreparedPublishingPolicy.v1'),
  policy: z.object({
    effectivePolicyDigest: digestSchema,
    effectiveConfigDigest: digestSchema,
    sources: z.array(reviewPolicySourceSchema).min(1).max(16),
  }).strict(),
  config: z.record(z.unknown()),
  // The shared verifier enforces HTTPS, no userinfo/query/fragment, and bounds.
  transport: z.object({ baseUrl: z.string(), model: z.string() }).strict(),
  expectedPersonaIds: z.array(personaIdSchema).min(1).max(64),
}).strict();

const storedSchema = z.object({
  effective_policy_digest: digestSchema,
  version: z.literal('PreparedPublishingPolicy.v1'),
  effective_config_digest: digestSchema,
  config: z.record(z.unknown()),
  transport: z.record(z.unknown()),
  sources: z.array(z.unknown()),
  expected_persona_ids: z.array(z.unknown()),
  prepared_content_digest: digestSchema,
}).strict();

/** No executable objects, lossy JSON values, prototype keys or credential
 * containers. Free-form review text is still the trusted preparer's obligation;
 * a field-name guard cannot establish that arbitrary text contains no secret. */
function requireSafeBoundedJson(input: unknown, maxBytes = MAX_PREPARED_REVIEW_BYTES): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  let textBytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      textBytes += Buffer.byteLength(item, 'utf8');
      if (textBytes > maxBytes) throw new Error();
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error();
    const array = Array.isArray(item);
    if (array && Object.getPrototypeOf(item) !== Array.prototype) throw new Error();
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error();
    ancestors.add(item);
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) throw new Error(); // Dense JSON arrays only.
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new Error();
      const field = key.replace(/[_-]/gu, '').toLowerCase();
      if (['__proto__', 'prototype', 'constructor'].includes(key)
        || /(?:apikey|accesskey|privatekey|password|secret|token|credential|authorization|headers)/u.test(field)
        || ['rawpolicy', 'policyjson', 'rawcontent', 'content'].includes(field)) throw new Error();
      textBytes += Buffer.byteLength(key, 'utf8');
      if (textBytes > maxBytes) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error();
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > maxBytes) throw new Error();
}

function validatePrepared(input: unknown): PreparedPublishingPolicy {
  requireSafeBoundedJson(input);
  const parsed = preparedSchema.parse(input);
  // The shared config schema is intentionally permissive for other consumers.
  // Storage rejects unknown root fields and rejects nested stripping/defaults:
  // only an already-normalized config may cross this persistence boundary.
  const strictConfig = ctReviewConfigV3Schema.innerType().strict().parse(parsed.config);
  const config = verifyPreparedPublishingConfig(strictConfig, parsed.policy.effectiveConfigDigest, parsed.transport);
  if (canonicalJson(config) !== canonicalJson(parsed.config) || config.personas.length > 64) throw new Error();
  const expected = config.personas.filter((persona) => persona.enabled).map((persona) => persona.id);
  if (new Set(parsed.expectedPersonaIds).size !== parsed.expectedPersonaIds.length
    || canonicalJson(expected) !== canonicalJson(parsed.expectedPersonaIds)) throw new Error();
  // Match authoritativeReviewIdentity's source ordering, without retaining or
  // recreating the raw central policy used to derive effectivePolicyDigest.
  const sources = parsed.policy.sources.sort((left, right) => {
    const a = JSON.stringify(left); const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (new Set(sources.map((source) => `${source.repositoryId}:${source.sha}:${source.path}`)).size !== sources.length) {
    throw new Error();
  }
  return { ...parsed, config, policy: { ...parsed.policy, sources } };
}

function contentDigest(prepared: PreparedPublishingPolicy): string {
  return sha256({ version: 'PreparedReviewContent.v1', prepared });
}

/** Revalidates all persisted fields, the config/transport fingerprint and the
 * full prepared-content digest. This detects inconsistent/corrupt storage; it
 * does not authenticate a writer able to replace both contents and digests. */
export async function getPreparedPublishingPolicy(
  queryable: PreparedReviewQueryable,
  effectivePolicyDigest: string,
): Promise<PreparedPublishingPolicy | null> {
  try {
    digestSchema.parse(effectivePolicyDigest);
    const result = await queryable.query(`SELECT effective_policy_digest, version, effective_config_digest,
      config, transport, sources, expected_persona_ids, prepared_content_digest
      FROM prepared_review_policies WHERE effective_policy_digest = $1`, [effectivePolicyDigest]);
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error();
    // Permit only the small SQL field-name/digest envelope overhead here; the
    // reconstructed prepared object still has the exact public byte bound.
    requireSafeBoundedJson(result.rows[0], MAX_PREPARED_REVIEW_BYTES + 1_024);
    const row = storedSchema.parse(result.rows[0]);
    if (row.effective_policy_digest !== effectivePolicyDigest) throw new Error();
    const prepared = validatePrepared({
      version: row.version,
      policy: {
        effectivePolicyDigest: row.effective_policy_digest,
        effectiveConfigDigest: row.effective_config_digest,
        sources: row.sources,
      },
      config: row.config, transport: row.transport, expectedPersonaIds: row.expected_persona_ids,
    });
    if (row.prepared_content_digest !== contentDigest(prepared)) throw new Error();
    return prepared;
  } catch {
    // Schema/SQL errors may echo JSON values or credentials; do not retain causes.
    throw new Error('Prepared review policy is invalid or unavailable');
  }
}

/** Only a trusted service caller that resolved immutable central policy may
 * supply `prepared`. The policy digest includes deliberately omitted raw policy
 * and cannot be rederived here. Bind that supplied digest to a separately
 * verified content digest of the entire prepared object, including provenance.
 *
 * No BEGIN/COMMIT/ROLLBACK: pass the admission transaction's client to make the
 * insert and admission atomic. An immutable conflict throws; the caller must
 * roll back its transaction. Pool use is also supported for standalone saves. */
export async function savePreparedPublishingPolicy(
  queryable: PreparedReviewQueryable,
  prepared: PreparedPublishingPolicy,
): Promise<PreparedPublishingPolicy> {
  try {
    const normalized = validatePrepared(prepared);
    await queryable.query(`INSERT INTO prepared_review_policies (
      effective_policy_digest, version, effective_config_digest, config, transport,
      sources, expected_persona_ids, prepared_content_digest
    ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8)
      ON CONFLICT (effective_policy_digest) DO NOTHING`, [
      normalized.policy.effectivePolicyDigest, normalized.version, normalized.policy.effectiveConfigDigest,
      canonicalJson(normalized.config), canonicalJson(normalized.transport), canonicalJson(normalized.policy.sources),
      canonicalJson(normalized.expectedPersonaIds), contentDigest(normalized),
    ]);
    const stored = await getPreparedPublishingPolicy(queryable, normalized.policy.effectivePolicyDigest);
    if (!stored || canonicalJson(stored) !== canonicalJson(normalized)) throw new Error();
    return stored;
  } catch {
    throw new Error('Prepared review policy could not be saved');
  }
}
