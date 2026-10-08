import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveWorkerConfig } from '../config/publishingWorkerConfig';
import { ctReviewConfigV3Schema, disputedBlockerAdjudicatorSchema, type CtReviewConfigV3 } from '../config/schema';
import {
  DEFAULT_MAX_REVIEWED_LOCKFILE_PATCH_CHARS,
  HARD_MAX_REVIEWED_LOCKFILE_PATCH_CHARS,
} from '../pipeline/hunkFilter';
import { fingerprintEffectiveReviewConfig, fingerprintTrustedReviewPolicy, reviewPolicySourceSchema,
  type TrustedResolvedReviewPolicy, type ImmutableReviewPolicyFile } from './authoritativeReviewIdentity';

// Shared envelope/transport cases live in the operator's
// pkg/job/testdata/prepared-review-execution.json and run in both languages.
const transportSchema = z.object({
  baseUrl: z.string().max(2_000).url().refine((value) => {
    // Check the original spelling before WHATWG URL parsing can normalize it.
    // Empty userinfo/query/fragment and malformed escapes are not permitted.
    if (/[\u0000-\u0020\u007f\\?#]/u.test(value) || /%(?![0-9a-f]{2})/iu.test(value)
      || /^https:\/\/[^/]*@/iu.test(value)) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  }),
  model: z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
}).strict();
const qualificationRuntimeImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const qualificationDispatchOriginSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const centralPolicySchema = z.object({
  // The schema id is a version marker, not an authority: accept `<producer>.review-policy.v1` from any
  // trusted producer. Authority comes from the policy digest and central provenance, not from this prefix.
  schema: z.string().regex(/^[a-z0-9][a-z0-9-]*\.review-policy\.v1$/u),
  review_yeti: z.object({
    personas: z.string().min(1).max(2_000),
    profile: z.enum(['chill', 'balanced', 'assertive']).optional(),
    severity_policy: z.literal('review-yeti-severity.v2').optional(),
    disputed_blocker_adjudicator: disputedBlockerAdjudicatorSchema.optional(),
    budget: z.object({
      max_investigation_turns: z.number().int().positive().max(100),
      max_reviewed_lockfile_patch_chars: z.number().int()
        .min(DEFAULT_MAX_REVIEWED_LOCKFILE_PATCH_CHARS)
        .max(HARD_MAX_REVIEWED_LOCKFILE_PATCH_CHARS)
      .optional(),
    }),
  }),
  repository_overrides: z.record(
    z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    z.object({ severity_policy: z.literal('review-yeti-severity.v2').optional() }).passthrough(),
  ).optional(),
});

export interface PreparedPublishingPolicy {
  version: 'PreparedPublishingPolicy.v1';
  policy: TrustedResolvedReviewPolicy;
  config: CtReviewConfigV3;
  expectedPersonaIds: string[];
  transport: z.infer<typeof transportSchema>;
  /** Service-owned immutable worker-image capability; absent on legacy/general receipts. */
  qualificationRuntimeImageDigest?: string;
  /** Service-owned qualification action-origin binding; never contains the raw origin. */
  qualificationDispatchOriginSha256?: string;
}

/** The only config envelope permitted across the service/operator/worker seam. */
export function parsePreparedReviewExecution(json: string, expectedDigest: string,
  actualTransport?: PreparedPublishingPolicy['transport']): {
  version: 'PreparedReviewExecution.v1'; config: CtReviewConfigV3;
    transport: PreparedPublishingPolicy['transport'];
    qualificationRuntimeImageDigest?: string;
  } {
  try {
    if (typeof json !== 'string' || !json || Buffer.byteLength(json, 'utf8') > 256 * 1024) throw new Error();
    const parsed = z.object({ version: z.literal('PreparedReviewExecution.v1'),
      config: z.unknown(), transport: transportSchema,
      qualificationRuntimeImageDigest: qualificationRuntimeImageDigestSchema.optional() }).strict().parse(JSON.parse(json));
    const config = verifyPreparedPublishingConfig(parsed.config, expectedDigest, actualTransport || parsed.transport,
      parsed.qualificationRuntimeImageDigest);
    // Verify both stored transport and the actual injected transport. Neither
    // the operator nor a stale environment may silently select another model/URL.
    // Recheck the original envelope config: current schema defaults may add
    // fields to an older, still-valid v1 producer payload after its digest was issued.
    verifyPreparedPublishingConfig(parsed.config, expectedDigest, parsed.transport, parsed.qualificationRuntimeImageDigest);
    return { version: parsed.version, config, transport: parsed.transport,
      ...(parsed.qualificationRuntimeImageDigest === undefined ? {} : {
        qualificationRuntimeImageDigest: parsed.qualificationRuntimeImageDigest,
      }) };
  } catch { throw new Error('Prepared review execution does not match its admitted identity'); }
}

/** Input file must be resolved by the service at a trusted immutable revision.
 * Retain only the normalized effective config and source fingerprints, not raw
 * central policy or credentials. The existing DOKS Bifrost provider selection
 * and turn clamp remain owned by the shared worker resolver. */
export function preparePublishingPolicy(file: ImmutableReviewPolicyFile,
  transport: PreparedPublishingPolicy['transport'],
  trustedTarget?: { owner: string; repo: string },
  trustedRuntime?: { composedEngineMaxTurns?: string; qualificationRuntimeImageDigest?: string;
    qualificationDispatchOriginSha256?: string }): PreparedPublishingPolicy {
  try {
    const resolvedTransport = transportSchema.parse(transport);
    const qualificationRuntimeImageDigest = trustedRuntime?.qualificationRuntimeImageDigest === undefined
      ? undefined : qualificationRuntimeImageDigestSchema.parse(trustedRuntime.qualificationRuntimeImageDigest);
    const qualificationDispatchOriginSha256 = trustedRuntime?.qualificationDispatchOriginSha256 === undefined
      ? undefined : qualificationDispatchOriginSha256Schema.parse(trustedRuntime.qualificationDispatchOriginSha256);
    if ((qualificationDispatchOriginSha256 === undefined) !== (qualificationRuntimeImageDigest === undefined)) throw new Error();
    const source = reviewPolicySourceSchema.parse(file.source);
    if (typeof file.content !== 'string' || Buffer.byteLength(file.content, 'utf8') > 256 * 1024
      || createHash('sha256').update(file.content).digest('hex') !== source.contentDigest) throw new Error();
    const raw: unknown = JSON.parse(file.content);
    const parsedPolicy = centralPolicySchema.parse(raw);
    const trustedRepository = trustedTarget
      ? `${z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u).parse(trustedTarget.owner)}/${z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u).parse(trustedTarget.repo)}`
      : undefined;
    const matchingOverrides = trustedRepository === undefined ? [] : Object.entries(parsedPolicy.repository_overrides ?? {})
      .filter(([repository]) => repository.toLowerCase() === trustedRepository.toLowerCase());
    if (matchingOverrides.length > 1) throw new Error('duplicate canonical repository override');
    const selectedOverride = matchingOverrides[0]?.[1];
    const selectedSeverityPolicy = selectedOverride?.severity_policy ?? parsedPolicy.review_yeti.severity_policy;
    const rawPolicy = raw as Record<string, any>;
    const effectivePolicy = {
      ...rawPolicy,
      review_yeti: {
        ...rawPolicy.review_yeti,
        ...(selectedSeverityPolicy === undefined ? {} : { severity_policy: selectedSeverityPolicy }),
      },
    };
    const effectivePolicyJson = JSON.stringify(effectivePolicy);
    const effective = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: effectivePolicyJson,
      ...(trustedRuntime?.composedEngineMaxTurns === undefined ? {} : {
        COMPOSED_ENGINE_MAX_TURNS: trustedRuntime.composedEngineMaxTurns,
      }) }, { ...resolvedTransport, apiKey: '' });
    const config = ctReviewConfigV3Schema.parse(effective);
    const expectedPersonaIds = config.personas.filter((persona) => persona.enabled).map((persona) => persona.id);
    if (expectedPersonaIds.length === 0 || expectedPersonaIds.length > 64
      || new Set(expectedPersonaIds).size !== expectedPersonaIds.length
      || expectedPersonaIds.some((id) => !/^[a-z][a-z0-9_-]{0,127}$/u.test(id))) throw new Error();
    const effectiveConfig = { config, transport: resolvedTransport,
      ...(qualificationRuntimeImageDigest === undefined ? {} : { qualificationRuntimeImageDigest }) };
    return {
      version: 'PreparedPublishingPolicy.v1', config, expectedPersonaIds, transport: resolvedTransport,
      ...(qualificationRuntimeImageDigest === undefined ? {} : { qualificationRuntimeImageDigest }),
      ...(qualificationDispatchOriginSha256 === undefined ? {} : { qualificationDispatchOriginSha256 }),
      policy: fingerprintTrustedReviewPolicy({
        effectiveConfig,
        effectivePolicy: {
          central: raw,
          targetRepository: selectedOverride === undefined ? null : trustedRepository?.toLowerCase() ?? null,
          selectedRepositoryOverride: selectedOverride ?? null,
          execution: { provider: 'bifrost', ...resolvedTransport,
            ...(qualificationRuntimeImageDigest === undefined ? {} : { qualificationRuntimeImageDigest }),
            ...(qualificationDispatchOriginSha256 === undefined ? {} : { qualificationDispatchOriginSha256 }) },
        },
        sources: [source],
      }),
    };
  } catch { throw new Error('Trusted publishing policy could not be prepared'); }
}

function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** v1 identities bind the producer's normalized config, including field absence.
 * A newer reader may know defaults the producer did not; do not retroactively
 * activate those fields while preserving the original service-issued digest. */
function preservePreparedV1FieldPresence(config: CtReviewConfigV3, input: unknown): CtReviewConfigV3 {
  const source = asJsonRecord(input);
  if (!source) return config;
  const normalized = config as unknown as Record<string, unknown>;
  if (!Object.hasOwn(source, 'swarm_context_isolation')) delete normalized.swarm_context_isolation;

  const sourceComposed = asJsonRecord(source.composed);
  const normalizedComposed = asJsonRecord(normalized.composed);
  if (normalizedComposed) {
    for (const field of ['swarm_context_isolation', 'quorum_policy']) {
      if (!sourceComposed || !Object.hasOwn(sourceComposed, field)) delete normalizedComposed[field];
    }
  }

  const sourceReceipt = asJsonRecord(source.review_configuration_receipt);
  const sourceEffective = asJsonRecord(sourceReceipt?.effective);
  const sourceBudget = asJsonRecord(sourceEffective?.composed_budget);
  const sourceOverrides = asJsonRecord(sourceBudget?.configured_overrides);
  const normalizedReceipt = asJsonRecord(normalized.review_configuration_receipt);
  const normalizedEffective = asJsonRecord(normalizedReceipt?.effective);
  const normalizedBudget = asJsonRecord(normalizedEffective?.composed_budget);
  const normalizedOverrides = asJsonRecord(normalizedBudget?.configured_overrides);
  if (normalizedOverrides) {
    for (const field of ['swarm_context_isolation', 'quorum_policy']) {
      if (!sourceOverrides || !Object.hasOwn(sourceOverrides, field)) delete normalizedOverrides[field];
    }
  }
  return config;
}

/** The authoritative worker verifies the original prepared config identity
 * before a provider call, then preserves v1 field presence when parsing it. */
export function verifyPreparedPublishingConfig(config: unknown, expectedDigest: string,
  transport: PreparedPublishingPolicy['transport'], qualificationRuntimeImageDigest?: string): CtReviewConfigV3 {
  try {
    const selectedTransport = transportSchema.parse(transport);
    if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new Error();
    const runtimeDigest = qualificationRuntimeImageDigest === undefined ? undefined
      : qualificationRuntimeImageDigestSchema.parse(qualificationRuntimeImageDigest);
    const admittedDigest = fingerprintEffectiveReviewConfig({ config, transport: selectedTransport,
      ...(runtimeDigest === undefined ? {} : { qualificationRuntimeImageDigest: runtimeDigest }) });
    const parsed = ctReviewConfigV3Schema.parse(config);
    if (admittedDigest !== expectedDigest
      || parsed.reviewers.providers.length !== 1
      || parsed.reviewers.providers[0].id !== 'bifrost'
      || parsed.reviewers.providers[0].enabled !== true
      || parsed.reviewers.providers[0].model !== selectedTransport.model
      || parsed.disputed_blocker_adjudicator?.model.toLowerCase() === selectedTransport.model.toLowerCase()
      || parsed.reviewers.arbiter.order.some((id) => id !== 'bifrost')
      || parsed.personas.some((persona) => persona.providers?.some((id) => id !== 'bifrost'))) throw new Error();
    return preservePreparedV1FieldPresence(parsed, config);
  } catch { throw new Error('Prepared publishing configuration does not match its admitted identity'); }
}
