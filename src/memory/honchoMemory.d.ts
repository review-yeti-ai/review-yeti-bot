export interface HonchoMemoryConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  workspaceId?: string;
  timeoutMs?: number;
  maxContextChars?: number;
}

export interface HonchoMemoryIdentity {
  repo: string;
  prNumber: string | number;
  headSha: string;
}

export interface HonchoMemoryProvider {
  readonly enabled: boolean;
  healthCheck(): Promise<{ configured: boolean; available: boolean; status?: number; reason?: string }>;
  resolveContext(input: HonchoMemoryIdentity & { query?: string }): Promise<{
    available: boolean;
    text: string;
    reason?: string;
  }>;
  appendEvents(input: HonchoMemoryIdentity & { events?: Record<string, unknown>[] }): Promise<{
    accepted: number;
    available: boolean;
    reason?: string;
    eventIds?: string[];
    chunks?: number;
  }>;
}

export function createHonchoMemoryProvider(options?: {
  config?: HonchoMemoryConfig;
  env?: NodeJS.ProcessEnv;
  secretManager?: { getSecret(name: string): Promise<string | null> };
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}): HonchoMemoryProvider;

export function resolveHonchoConfig(options?: {
  config?: HonchoMemoryConfig;
  env?: NodeJS.ProcessEnv;
  secretManager?: { getSecret(name: string): Promise<string | null> };
}): Promise<HonchoMemoryConfig & { enabled: boolean; reason?: string }>;

export function normalizeReviewEvent(event?: Record<string, unknown>, now?: () => Date): Record<string, unknown>;
export function stableWorkspaceId(value?: string): string;
export function stablePeerId(repo: string): string;
export function stableSessionId(repo: string, prNumber: string | number): string;
export function canonicalJson(value: unknown): string;
