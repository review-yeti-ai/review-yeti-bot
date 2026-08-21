import { sha256 } from '../review/reviewCore';

export interface ReviewPolicy {
  requireEvidence: boolean;
  failClosed: boolean;
  maxFiles: number;
  maxBytes: number;
  maxTokens: number;
  maxCostUSD: number;
  maxConcurrency: number;
  retentionDays: number;
  allowRecursiveSubmodules: boolean;
}

export interface PolicyLayer {
  name: 'platform' | 'organization' | 'repository' | 'workflow' | 'operator';
  values: Partial<ReviewPolicy>;
}

export interface EffectivePolicy {
  policy: ReviewPolicy;
  sources: Record<keyof ReviewPolicy, string[]>;
  digest: string;
}

const DEFAULT_POLICY: ReviewPolicy = {
  requireEvidence: true,
  failClosed: true,
  maxFiles: 10_000,
  maxBytes: 25_000_000,
  maxTokens: 100_000,
  maxCostUSD: 5,
  maxConcurrency: 4,
  retentionDays: 30,
  allowRecursiveSubmodules: false,
};

/** Resolve policy with explicit provenance and immutable platform safety caps. */
export function resolveEffectivePolicy(layers: PolicyLayer[]): EffectivePolicy {
  const platform = { ...DEFAULT_POLICY, ...(layers.find((layer) => layer.name === 'platform')?.values || {}) };
  const policy = { ...platform };
  const sources = Object.fromEntries(Object.keys(DEFAULT_POLICY).map((key) => [key, ['platform']])) as Record<keyof ReviewPolicy, string[]>;
  const mutable = policy as Record<keyof ReviewPolicy, unknown>;
  const platformSecurityFlags = new Set<keyof ReviewPolicy>(['requireEvidence', 'failClosed']);
  for (const layer of layers.filter((layer) => layer.name !== 'platform')) {
    for (const key of Object.keys(DEFAULT_POLICY) as Array<keyof ReviewPolicy>) {
      const value = layer.values[key];
      if (value === undefined) continue;
      if (typeof value === 'number') mutable[key] = Math.min(mutable[key] as number, value);
      else if (typeof value === 'boolean') {
        mutable[key] = platformSecurityFlags.has(key)
          ? Boolean(platform[key]) && (Boolean(mutable[key]) || value)
          : value;
      }
      sources[key].push(layer.name);
    }
  }
  return { policy, sources, digest: sha256({ policy, sources }) };
}
