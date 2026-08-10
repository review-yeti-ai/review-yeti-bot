export type ContextZone = 'frozen' | 'compactable' | 'active';

export interface ContextMessage {
  id: string;
  role: string;
  content: unknown;
  zone?: ContextZone;
}

export interface ContextCompactionPolicy {
  enabled: boolean;
  maxBytes: number;
  summaryBytes: number;
  frozenOverflow: 'fail';
}

export interface ContextCompactionReceipt {
  schemaVersion: 'context-window-v1';
  budgetDigest: string;
  status: 'disabled' | 'compacted';
  compacted: boolean;
  inputBytes: number;
  outputBytes: number;
  frozenBytes: number;
  compactedSources: Array<{
    sourceIndex: number;
    sourceIdDigest: string;
    role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'retrieval' | 'unknown';
    bytes: number;
    contentDigest: string;
  }>;
}

export class ContextWindowFrozenOverflowError extends Error {
  code: 'CONTEXT_WINDOW_FROZEN_OVERFLOW';
  frozenBytes: number;
  maxBytes: number;
}

export class ContextWindowActiveOverflowError extends Error {
  code: 'CONTEXT_WINDOW_ACTIVE_OVERFLOW';
  frozenBytes: number;
  activeBytes: number;
  maxBytes: number;
}

export function compact(messages: ContextMessage[], policy: ContextCompactionPolicy): {
  messages: ContextMessage[];
  receipt: ContextCompactionReceipt;
};

export function resolveContextCompactionPolicy(config?: unknown): ContextCompactionPolicy;
