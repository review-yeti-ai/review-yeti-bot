import { z } from 'zod';
import { reviewPolicySourceSchema, type TrustedResolvedReviewPolicy } from './authoritativeReviewIdentity';
import { sha256 } from './reviewCore';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const repositoryNamePart = z.string().regex(/^[A-Za-z0-9_.-]+$/u).min(1).max(100);
const positiveInteger = z.number().int().positive().safe();
const refSchema = z.string().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

export const operatorMaintenanceIdentitySchema = z.object({
  repositoryId: positiveInteger,
  owner: repositoryNamePart,
  repo: repositoryNamePart,
  headSha: shaSchema,
  baseSha: shaSchema,
  subject: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pull_request'), prNumber: positiveInteger }).strict(),
    z.object({ kind: z.literal('merge_group'), headRef: refSchema, baseRef: refSchema }).strict(),
  ]),
}).strict();

export type OperatorMaintenanceIdentity = z.infer<typeof operatorMaintenanceIdentitySchema>;

const sourceSchema = z.enum(['github-app-webhook', 'central-action-dispatch', 'mcp-trigger']);
const checkSchema = z.object({
  name: z.string().min(1).max(100),
  appId: positiveInteger,
  externalId: z.string().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
}).strict();

export const operatorMaintenanceReceiptSchema = z.object({
  version: z.literal('OperatorMaintenanceReceipt.v1'),
  intentId: z.string().regex(/^operator-maintenance:v1:[a-f0-9]{64}$/u),
  source: sourceSchema,
  mode: z.literal('passthrough'),
  decision: z.literal('SHIP'),
  reason: z.literal('operator_global_passthrough'),
  reviewCompleted: z.literal(false),
  identity: operatorMaintenanceIdentitySchema,
  authority: z.object({
    kind: z.literal('trusted-runtime-operator-config'),
    setting: z.literal('REVIEW_YETI_PASSTHROUGH'),
    configDigest: digestSchema,
  }).strict(),
  policy: z.object({
    effectivePolicyDigest: digestSchema,
    effectiveConfigDigest: digestSchema,
    sources: z.array(reviewPolicySourceSchema).min(1).max(16),
  }).strict(),
  checks: z.object({ raw: checkSchema, gate: checkSchema }).strict(),
}).strict().superRefine((receipt, context) => {
  if (receipt.checks.raw.name !== 'Review Yeti') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['checks', 'raw', 'name'], message: 'Unexpected raw check name' });
  }
  if (receipt.checks.gate.name !== 'Review Yeti Gate') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['checks', 'gate', 'name'], message: 'Unexpected gate check name' });
  }
  if (receipt.checks.raw.externalId === receipt.checks.gate.externalId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['checks'], message: 'Check external IDs must be distinct' });
  }
});

export type OperatorMaintenanceReceiptV1 = Omit<z.infer<typeof operatorMaintenanceReceiptSchema>, 'policy'> & {
  policy: {
    effectivePolicyDigest: string;
    effectiveConfigDigest: string;
    sources: TrustedResolvedReviewPolicy['sources'];
  };
};

/** Stable target identity. Policy, config, source lane, and check setup are
 * compared during reservation but never create a second pair for one target. */
export function createOperatorMaintenanceIntentId(identity: OperatorMaintenanceIdentity): string {
  const parsed = operatorMaintenanceIdentitySchema.parse(identity);
  return `operator-maintenance:v1:${sha256({ version: 'OperatorMaintenanceTarget.v1', identity: parsed })}`;
}

export type OperatorMaintenanceStage = 'raw' | 'gate';
export type OperatorMaintenanceClaimResult =
  | { kind: 'bound'; checkId: number }
  | { kind: 'busy' }
  | { kind: 'stale' }
  | { kind: 'blocked' }
  | { kind: 'lease'; leaseToken: string; reconcileFirst: true };

export interface OperatorMaintenanceRepository {
  reserve(receipt: OperatorMaintenanceReceiptV1): Promise<OperatorMaintenanceReceiptV1>;
  claimRaw(intentId: string, now: Date, leaseMs: number): Promise<OperatorMaintenanceClaimResult>;
  bindRaw(intentId: string, leaseToken: string, checkId: number, now: Date): Promise<void>;
  claimGate(intentId: string, now: Date, leaseMs: number): Promise<OperatorMaintenanceClaimResult>;
  bindGate(intentId: string, leaseToken: string, checkId: number, now: Date): Promise<void>;
  markStale(intentId: string, now: Date): Promise<void>;
}

export type OperatorMaintenanceResult = { status: 'published' | 'pending'; receipt: OperatorMaintenanceReceiptV1 };
