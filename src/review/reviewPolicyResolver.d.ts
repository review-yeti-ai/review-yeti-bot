export interface TrustedReviewPolicy {
  schemaVersion: 'trusted-review-policy-v1';
  status: 'enabled' | 'disabled' | 'disabled_by_action' | 'invalid_config';
  enabled: boolean;
  trustedBaseRef: string;
  configDigest: string;
  policyDigest: string;
  limits: Partial<{ maxDiffChars: number; maxFileDiffChars: number; maxPersonas: number }>;
  capabilities?: Partial<{ provider: string; endpoint: string; tools: string[]; rules: string[] }>;
}

export function resolveTrustedReviewPolicy(input: {
  trustedConfig?: { raw?: string; parsed?: unknown; parseError?: Error };
  baseRef: string;
  headRef: string;
  configRef?: string;
  actionInputs?: Record<string, unknown>;
}): TrustedReviewPolicy;
export function validateTrustedConfigRef(configRef: string | undefined, baseRef: string, headRef: string): string;
