export type MemoryDomain = 'processing' | 'code' | 'rule' | 'feedback';
export type MemoryTransport = 'mcp' | 'rest' | 'auto';

export interface MemoryIdentity {
  repository: string;
  prNumber: string | number;
  headSha: string;
  baseSha?: string;
  policyDigest?: string;
}

export interface MemoryProviderCapabilities {
  queryContext: boolean;
  appendEvents: boolean;
  ingestFacts?: boolean;
  health?: boolean;
  readiness?: boolean;
  supportsIdempotency?: boolean;
  deliverySemantics?: 'at_least_once' | 'exactly_once';
  scopes?: string[];
  transports?: MemoryTransport[];
  domains?: { recall: string[]; persist: string[] };
}

export interface MemoryProvider {
  id: string;
  contractVersion: string;
  adapterVersion?: string;
  experimental?: boolean;
  capabilities: MemoryProviderCapabilities;
  queryContext(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  appendEvents(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  healthCheck?(): Promise<Record<string, unknown>>;
  readiness?(): Promise<Record<string, unknown>>;
}

export class MemoryProviderRouter {
  constructor(options?: { providers?: MemoryProvider[]; defaultProviderId?: string; transport?: MemoryTransport; mode?: 'single' });
  register(provider: MemoryProvider): MemoryProvider;
  get(id?: string): MemoryProvider | undefined;
  list(): Array<Record<string, unknown>>;
  queryContext(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  appendEvents(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  health(providerId?: string): Promise<Record<string, unknown>>;
}

export function createMemoryProviderRouter(options?: Record<string, unknown>): MemoryProviderRouter;
