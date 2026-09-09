import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveWorkerConfig } from '../config/publishingWorkerConfig';
import { ctReviewConfigV3Schema, type CtReviewConfigV3 } from '../config/schema';
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
const centralPolicySchema = z.object({
  schema: z.literal('calltelemetry.review-policy.v1'),
  review_yeti: z.object({
    personas: z.string().min(1).max(2_000),
    budget: z.object({ max_investigation_turns: z.number().int().positive().max(100) }),
  }),
});

export interface PreparedPublishingPolicy {
  version: 'PreparedPublishingPolicy.v1';
  policy: TrustedResolvedReviewPolicy;
  config: CtReviewConfigV3;
  expectedPersonaIds: string[];
  transport: z.infer<typeof transportSchema>;
}

/** The only config envelope permitted across the service/operator/worker seam. */
export function parsePreparedReviewExecution(json: string, expectedDigest: string,
  actualTransport?: PreparedPublishingPolicy['transport']): {
    version: 'PreparedReviewExecution.v1'; config: CtReviewConfigV3;
    transport: PreparedPublishingPolicy['transport'];
  } {
  try {
    if (typeof json !== 'string' || !json || Buffer.byteLength(json, 'utf8') > 256 * 1024) throw new Error();
    const parsed = z.object({ version: z.literal('PreparedReviewExecution.v1'),
      config: z.unknown(), transport: transportSchema }).strict().parse(JSON.parse(json));
    const config = verifyPreparedPublishingConfig(parsed.config, expectedDigest, actualTransport || parsed.transport);
    // Verify both stored transport and the actual injected transport. Neither
    // the operator nor a stale environment may silently select another model/URL.
    verifyPreparedPublishingConfig(config, expectedDigest, parsed.transport);
    return { version: parsed.version, config, transport: parsed.transport };
  } catch { throw new Error('Prepared review execution does not match its admitted identity'); }
}

/** Input file must be resolved by the service at a trusted immutable revision.
 * Retain only the normalized effective config and source fingerprints, not raw
 * central policy or credentials. The existing DOKS Bifrost provider selection
 * and turn clamp remain owned by the shared worker resolver. */
export function preparePublishingPolicy(file: ImmutableReviewPolicyFile,
  transport: PreparedPublishingPolicy['transport']): PreparedPublishingPolicy {
  try {
    const resolvedTransport = transportSchema.parse(transport);
    const source = reviewPolicySourceSchema.parse(file.source);
    if (typeof file.content !== 'string' || Buffer.byteLength(file.content, 'utf8') > 256 * 1024
      || createHash('sha256').update(file.content).digest('hex') !== source.contentDigest) throw new Error();
    const raw: unknown = JSON.parse(file.content);
    centralPolicySchema.parse(raw);
    const effective = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: file.content }, { ...resolvedTransport, apiKey: '' });
    const config = ctReviewConfigV3Schema.parse(effective);
    const expectedPersonaIds = config.personas.filter((persona) => persona.enabled).map((persona) => persona.id);
    if (expectedPersonaIds.length === 0 || expectedPersonaIds.length > 64
      || new Set(expectedPersonaIds).size !== expectedPersonaIds.length
      || expectedPersonaIds.some((id) => !/^[a-z][a-z0-9_-]{0,127}$/u.test(id))) throw new Error();
    return {
      version: 'PreparedPublishingPolicy.v1', config, expectedPersonaIds, transport: resolvedTransport,
      policy: fingerprintTrustedReviewPolicy({
        effectiveConfig: { config, transport: resolvedTransport },
        effectivePolicy: { central: raw, execution: { provider: 'bifrost', ...resolvedTransport } },
        sources: [source],
      }),
    };
  } catch { throw new Error('Trusted publishing policy could not be prepared'); }
}

/** The future authoritative worker lane verifies its normalized prepared
 * config before a provider call. This does not activate or change legacy Jobs. */
export function verifyPreparedPublishingConfig(config: unknown, expectedDigest: string,
  transport: PreparedPublishingPolicy['transport']): CtReviewConfigV3 {
  try {
    const selectedTransport = transportSchema.parse(transport);
    const parsed = ctReviewConfigV3Schema.parse(config);
    if (!/^[a-f0-9]{64}$/u.test(expectedDigest)
      || fingerprintEffectiveReviewConfig({ config: parsed, transport: selectedTransport }) !== expectedDigest
      || parsed.reviewers.providers.length !== 1
      || parsed.reviewers.providers[0].id !== 'bifrost'
      || parsed.reviewers.providers[0].enabled !== true
      || parsed.reviewers.providers[0].model !== selectedTransport.model
      || parsed.reviewers.arbiter.order.some((id) => id !== 'bifrost')
      || parsed.personas.some((persona) => persona.providers?.some((id) => id !== 'bifrost'))) throw new Error();
    return parsed;
  } catch { throw new Error('Prepared publishing configuration does not match its admitted identity'); }
}
